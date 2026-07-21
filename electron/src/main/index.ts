import { app, shell, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { configManager } from './utils/config'
import { logger } from './utils/logger'
import { serviceManager } from './utils/service-manager'
import { handlePrintCommand } from './print/engine'
import { printQueue, type PrintTask } from './print/queue'
import icon from '../../build/icon.png?asset'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

const PRINTER_STATUS_READY = 0
const PRINTER_STATUS_UNKNOWN = 2
const PRINTER_STATUS_PRINTING = 4
const PRINTER_STATUS_WARMUP = 5
const PRINTER_STATUS_STOPPED = 6
const PRINTER_STATUS_OFFLINE = 7

const WINDOWS_PRINTER_STATUS = {
  PAUSED: 0x1,
  ERROR: 0x2,
  PENDING_DELETION: 0x4,
  PAPER_JAM: 0x8,
  PAPER_OUT: 0x10,
  MANUAL_FEED: 0x20,
  PAPER_PROBLEM: 0x40,
  OFFLINE: 0x80,
  IO_ACTIVE: 0x100,
  BUSY: 0x200,
  PRINTING: 0x400,
  OUTPUT_BIN_FULL: 0x800,
  NOT_AVAILABLE: 0x1000,
  WAITING: 0x2000,
  PROCESSING: 0x4000,
  INITIALIZING: 0x8000,
  WARMING_UP: 0x10000,
  NO_TONER: 0x40000,
  USER_INTERVENTION: 0x100000,
  OUT_OF_MEMORY: 0x200000,
  DOOR_OPEN: 0x400000,
  SERVER_UNKNOWN: 0x800000
} as const

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'CWE Print',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin') {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const trayIcon = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 })
  tray = new Tray(trayIcon)
  tray.setToolTip('卡挖易打印系统 打印服务')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          } else {
            createWindow()
          }
        }
      },
      {
        label: '暂停服务',
        type: 'checkbox',
        checked: false,
        click: (item) => {
          if (item.checked) {
            serviceManager.stop().then(() => {
              logger.info('打印服务已暂停', 'tray')
            })
          } else {
            serviceManager.init().then(() => {
              logger.info('打印服务已恢复', 'tray')
            })
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit()
        }
      }
    ])
  )

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// IPC 处理器
ipcMain.handle('config:get', () => configManager.get())
ipcMain.handle('config:set', (_event, partial) => configManager.set(partial))

ipcMain.handle('service:status', () => serviceManager.getStatus())

ipcMain.handle('printer:list', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow
  if (!win) return []
  const printers = await win.webContents.getPrintersAsync()
  return printers.map((p) => ({
    name: p.name,
    description: p.description || '',
    status: normalizePrinterStatus(p.status),
    isDefault: p.isDefault
  }))
})

function normalizePrinterStatus(status: number): number {
  if (process.platform === 'win32') {
    return normalizeWindowsPrinterStatus(status)
  }

  switch (status) {
    case 3:
      return PRINTER_STATUS_READY
    case 4:
      return PRINTER_STATUS_PRINTING
    case 5:
      return PRINTER_STATUS_STOPPED
    default:
      return PRINTER_STATUS_UNKNOWN
  }
}

function normalizeWindowsPrinterStatus(status: number): number {
  if (status === 0) {
    return PRINTER_STATUS_READY
  }

  if (status & (WINDOWS_PRINTER_STATUS.OFFLINE | WINDOWS_PRINTER_STATUS.NOT_AVAILABLE)) {
    return PRINTER_STATUS_OFFLINE
  }

  if (
    status &
    (WINDOWS_PRINTER_STATUS.PRINTING |
      WINDOWS_PRINTER_STATUS.PROCESSING |
      WINDOWS_PRINTER_STATUS.IO_ACTIVE |
      WINDOWS_PRINTER_STATUS.BUSY |
      WINDOWS_PRINTER_STATUS.WAITING)
  ) {
    return PRINTER_STATUS_PRINTING
  }

  if (status & (WINDOWS_PRINTER_STATUS.INITIALIZING | WINDOWS_PRINTER_STATUS.WARMING_UP)) {
    return PRINTER_STATUS_WARMUP
  }

  if (
    status &
    (WINDOWS_PRINTER_STATUS.PAUSED |
      WINDOWS_PRINTER_STATUS.ERROR |
      WINDOWS_PRINTER_STATUS.PENDING_DELETION |
      WINDOWS_PRINTER_STATUS.PAPER_JAM |
      WINDOWS_PRINTER_STATUS.PAPER_OUT |
      WINDOWS_PRINTER_STATUS.MANUAL_FEED |
      WINDOWS_PRINTER_STATUS.PAPER_PROBLEM |
      WINDOWS_PRINTER_STATUS.OUTPUT_BIN_FULL |
      WINDOWS_PRINTER_STATUS.NO_TONER |
      WINDOWS_PRINTER_STATUS.USER_INTERVENTION |
      WINDOWS_PRINTER_STATUS.OUT_OF_MEMORY |
      WINDOWS_PRINTER_STATUS.DOOR_OPEN |
      WINDOWS_PRINTER_STATUS.SERVER_UNKNOWN)
  ) {
    return PRINTER_STATUS_STOPPED
  }

  return PRINTER_STATUS_UNKNOWN
}

ipcMain.handle('queue:tasks', () => printQueue.all)

ipcMain.handle('print:reprint', (_event, taskId: string) => {
  // 从队列历史中找到原任务，提取原始打印指令后重新入队。
  // 使用新 ID 避免队列里出现重复 ID，同时保留原指令的所有参数。
  const task = printQueue.all.find((t: PrintTask) => t.id === taskId)
  if (!task) {
    return { success: false, error: '任务不存在' }
  }

  const { status, createdAt, startedAt, completedAt, outputPath, error, ...cmd } = task
  const reprintCmd = {
    ...(cmd as unknown as Record<string, unknown>),
    id: `${task.id}-reprint-${Date.now()}`
  }

  handlePrintCommand(reprintCmd as unknown as Parameters<typeof handlePrintCommand>[0])
  return { success: true }
})

// 配置变更时通知渲染进程
configManager.on('changed', (config) => {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('config:changed', config)
  })
})

// 打印队列变更时通知渲染进程
printQueue.on('changed', () => {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('queue:changed')
  })
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.cwe.print')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  createTray()
  serviceManager.init()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Windows/Linux 保持后台运行
  }
})

// 防止 before-quit 重复触发导致清理逻辑执行多次
let isQuitting = false

app.on('before-quit', (event) => {
  // Electron 不会等待 before-quit 里的异步操作；必须先阻止默认退出，
  // 等服务清理完成后再手动 app.exit()，否则服务可能没停干净应用就退出了
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true

  logger.info('应用即将退出，开始清理服务...', 'app')
  serviceManager
    .stop()
    .catch((err) => {
      logger.error(`服务停止失败: ${(err as Error).message}`, 'app')
    })
    .finally(() => {
      app.exit()
    })
})

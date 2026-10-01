import { app, ipcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import { configManager } from './config'
import { collectDirectoryEntries, writeZipFile, type ZipEntry } from './zip'

export interface LogEntry {
  time: string
  level: string
  message: string
  source: string
  details?: unknown
}

const logs: LogEntry[] = []
const MAX_LOGS = 1000
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'app.jsonl')

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

function parseLogLine(line: string): LogEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<LogEntry>
    if (!parsed.time || !parsed.level || !parsed.message || !parsed.source) return null
    return {
      time: parsed.time,
      level: parsed.level,
      message: parsed.message,
      source: parsed.source,
      details: parsed.details
    }
  } catch {
    return null
  }
}

function readPersistedLogs(): LogEntry[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return []
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').split(/\r?\n/).filter(Boolean)
    return lines.map(parseLogLine).filter((entry): entry is LogEntry => entry !== null)
  } catch (err) {
    console.error('读取日志文件失败:', err)
    return []
  }
}

function appendLog(entry: LogEntry): void {
  try {
    ensureLogDir()
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8')
  } catch (err) {
    console.error('写入日志文件失败:', err)
  }
}

function formatLogForExport(entry: LogEntry): string {
  const line = `[${entry.time}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`
  if (entry.details === undefined) return line
  return `${line}\nDetails:\n${JSON.stringify(entry.details, null, 2)}`
}

function countFiles(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0

  let count = 0
  const names = fs.readdirSync(dirPath)
  for (const name of names) {
    const absolutePath = path.join(dirPath, name)
    const stat = fs.lstatSync(absolutePath)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      count += countFiles(absolutePath)
    } else if (stat.isFile()) {
      count += 1
    }
  }
  return count
}

function readFileIfExists(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined
  return fs.readFileSync(filePath, 'utf-8')
}

function buildDiagnosticManifest(): Record<string, unknown> {
  const crashDumpsPath = app.getPath('crashDumps')
  const reportsPath = path.join(crashDumpsPath, 'reports')
  const attachmentsPath = path.join(crashDumpsPath, 'attachments')

  return {
    generatedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    paths: {
      userData: app.getPath('userData'),
      logFile: LOG_FILE,
      crashDumps: crashDumpsPath
    },
    files: {
      logFileExists: fs.existsSync(LOG_FILE),
      crashDumpsExists: fs.existsSync(crashDumpsPath),
      crashReportsCount: countFiles(reportsPath),
      crashAttachmentsCount: countFiles(attachmentsPath)
    }
  }
}

async function exportLogs(): Promise<{ success: boolean; filePath?: string; error?: string }> {
  try {
    const allLogs = readPersistedLogs()
    const now = new Date()
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-')
    const defaultPath = path.join(app.getPath('downloads'), `cwe-print-diagnostics-${stamp}.zip`)

    const result = await dialog.showSaveDialog({
      title: '导出诊断包',
      defaultPath,
      filters: [
        { name: 'Zip Archive', extensions: ['zip'] }
      ]
    })

    if (result.canceled || !result.filePath) {
      return { success: false, error: '已取消导出' }
    }

    const logText = allLogs.map(formatLogForExport).join('\n')
    const logJsonl = readFileIfExists(LOG_FILE) || allLogs.map((entry) => JSON.stringify(entry)).join('\n')
    const markerPath = path.join(app.getPath('userData'), 'app-running.json')
    const markerContent = readFileIfExists(markerPath)
    const manifest = buildDiagnosticManifest()
    const entries: ZipEntry[] = [
      {
        archivePath: 'manifest.json',
        content: JSON.stringify(manifest, null, 2)
      },
      {
        archivePath: 'logs/app.txt',
        content: logText + (logText ? '\n' : '')
      },
      {
        archivePath: 'logs/app.jsonl',
        content: logJsonl + (logJsonl && !logJsonl.endsWith('\n') ? '\n' : '')
      },
      ...collectDirectoryEntries(app.getPath('crashDumps'), 'crashpad')
    ]

    if (markerContent) {
      entries.push({
        archivePath: 'runtime/app-running.json',
        content: markerContent
      })
    }

    const outputPath =
      path.extname(result.filePath).toLowerCase() === '.zip'
        ? result.filePath
        : `${result.filePath}.zip`

    writeZipFile(outputPath, entries)
    return { success: true, filePath: outputPath }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

logs.push(...readPersistedLogs().slice(-MAX_LOGS))

function broadcastLog(entry: LogEntry): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('log:entry', entry)
  })
}

function shouldLog(level: string): boolean {
  const levels = ['debug', 'info', 'warn', 'error']
  const current = levels.indexOf(configManager.get().logLevel)
  const target = levels.indexOf(level)
  return target >= current
}

function pushLog(level: string, message: string, source: string, details?: unknown): void {
  if (!shouldLog(level)) return
  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    message,
    source,
    details
  }
  logs.push(entry)
  if (logs.length > MAX_LOGS) logs.shift()
  appendLog(entry)
  broadcastLog(entry)
}

export const logger = {
  debug: (msg: string, source = 'main', details?: unknown) => pushLog('debug', msg, source, details),
  info: (msg: string, source = 'main', details?: unknown) => pushLog('info', msg, source, details),
  warn: (msg: string, source = 'main', details?: unknown) => pushLog('warn', msg, source, details),
  error: (msg: string, source = 'main', details?: unknown) => pushLog('error', msg, source, details),
  getLogs: () => [...logs],
  exportLogs
}

ipcMain.handle('log:get', () => logger.getLogs())
ipcMain.handle('log:export', () => logger.exportLogs())

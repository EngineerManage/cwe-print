import { BrowserWindow, dialog } from 'electron'
import { configManager } from './config'
import { logger } from './logger'
import { TcpServer } from '../socket/tcp-server'
import { WsServer } from '../socket/ws-server'
import { handlePrintCommand } from '../print/engine'
import { printQueue } from '../print/queue'
import type { ServiceStatus } from '../../preload'

interface ServiceStartupFailure {
  serviceName: 'TCP' | 'WebSocket'
  port: number
  error: Error
}

class ServiceManager {
  private tcpServer = new TcpServer()
  private wsServer = new WsServer()
  private statusTimer: NodeJS.Timeout | null = null
  private desiredRunning = false
  private startupErrorDialogVisible = false

  constructor() {
    this.tcpServer.onCommand(async (cmd) => handlePrintCommand(cmd))
    this.wsServer.onCommand(async (cmd) => handlePrintCommand(cmd))

    // 监听配置变更，自动重启服务
    configManager.on('restart:tcp', (port: number) => {
      logger.info(`TCP 端口配置变更: ${port}，即将重启服务...`, 'service')
      this.restartTcp(port)
    })

    configManager.on('restart:ws', (port: number) => {
      logger.info(`WebSocket 端口配置变更: ${port}，即将重启服务...`, 'service')
      this.restartWs(port)
    })

    // 打印队列变化时广播状态
    printQueue.on('changed', () => this.broadcastStatus())

    this.startStatusTimer()
  }

  async init(): Promise<void> {
    this.desiredRunning = true
    this.startStatusTimer()
    const config = configManager.get()
    const failures: ServiceStartupFailure[] = []

    await Promise.all([
      this.tcpServer.start(config.tcpPort).catch((err) => {
        const error = this.toError(err)
        logger.error(`TCP 服务启动失败: ${error.message}`, 'service')
        failures.push({ serviceName: 'TCP', port: config.tcpPort, error })
      }),
      this.wsServer.start(config.wsPort).catch((err) => {
        const error = this.toError(err)
        logger.error(`WebSocket 服务启动失败: ${error.message}`, 'service')
        failures.push({ serviceName: 'WebSocket', port: config.wsPort, error })
      })
    ])
    this.broadcastStatus()

    if (failures.length > 0) {
      await this.showStartupFailureDialog(failures)
    }
  }

  private startStatusTimer(): void {
    if (this.statusTimer) return

    // 定时广播状态（心跳），并在服务异常停止时自动拉起。
    this.statusTimer = setInterval(() => {
      this.ensureRunning()
      this.broadcastStatus()
    }, 5000)
  }

  private ensureRunning(): void {
    if (!this.desiredRunning) return

    const config = configManager.get()
    const status = this.getStatus()

    if (!status.tcp.running) {
      logger.warn(`检测到 TCP 服务未运行，尝试自动重启，端口: ${config.tcpPort}`, 'service')
      this.tcpServer.start(config.tcpPort).catch((err) => {
        logger.error(`TCP 服务自动重启失败: ${err.message}`, 'service')
      })
    }

    if (!status.ws.running) {
      logger.warn(`检测到 WebSocket 服务未运行，尝试自动重启，端口: ${config.wsPort}`, 'service')
      this.wsServer.start(config.wsPort).catch((err) => {
        logger.error(`WebSocket 服务自动重启失败: ${err.message}`, 'service')
      })
    }
  }

  private async restartTcp(port: number): Promise<void> {
    try {
      await this.tcpServer.stop()
      await this.tcpServer.start(port)
      logger.info(`TCP 服务已重启，新端口: ${port}`, 'service')
      this.broadcastStatus()
    } catch (err) {
      const error = this.toError(err)
      logger.error(`TCP 服务重启失败: ${error.message}`, 'service')
      await this.showStartupFailureDialog([{ serviceName: 'TCP', port, error }])
    }
  }

  private async restartWs(port: number): Promise<void> {
    try {
      await this.wsServer.stop()
      await this.wsServer.start(port)
      logger.info(`WebSocket 服务已重启，新端口: ${port}`, 'service')
      this.broadcastStatus()
    } catch (err) {
      const error = this.toError(err)
      logger.error(`WebSocket 服务重启失败: ${error.message}`, 'service')
      await this.showStartupFailureDialog([{ serviceName: 'WebSocket', port, error }])
    }
  }

  getStatus(): ServiceStatus {
    return {
      tcp: this.tcpServer.status,
      ws: this.wsServer.status,
      printQueue: printQueue.stats
    }
  }

  private broadcastStatus(): void {
    const status = this.getStatus()
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('service:statusChanged', status)
    })
  }

  private toError(err: unknown): Error {
    if (err instanceof Error) return err
    return new Error(String(err))
  }

  private getStartupFailureReason({ serviceName, port, error }: ServiceStartupFailure): string {
    const code = (error as NodeJS.ErrnoException).code

    if (code === 'EADDRINUSE') {
      return `${serviceName} 服务启动失败：端口 ${port} 已被占用。请关闭占用该端口的程序，或在服务设置中修改端口后重试。`
    }

    if (code === 'EACCES' || code === 'EPERM') {
      return `${serviceName} 服务启动失败：没有权限监听端口 ${port}。请更换端口，或使用具备端口监听权限的方式启动应用。`
    }

    if (code === 'EADDRNOTAVAIL') {
      return `${serviceName} 服务启动失败：当前设备无法监听端口 ${port} 对应的网络地址。请检查网络配置后重试。`
    }

    return `${serviceName} 服务启动失败：${error.message || '未知错误'}`
  }

  private async showStartupFailureDialog(failures: ServiceStartupFailure[]): Promise<void> {
    if (this.startupErrorDialogVisible) return

    this.startupErrorDialogVisible = true
    const detail = failures
      .map((failure) => {
        const code = (failure.error as NodeJS.ErrnoException).code
        const technicalMessage = code
          ? `原始错误：${code} ${failure.error.message}`
          : `原始错误：${failure.error.message}`

        return `${this.getStartupFailureReason(failure)}\n${technicalMessage}`
      })
      .join('\n\n')

    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const options = {
        type: 'error' as const,
        title: '打印服务启动失败',
        message: '打印服务启动失败',
        detail,
        buttons: ['确定'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }

      if (win && !win.isDestroyed()) {
        await dialog.showMessageBox(win, options)
      } else {
        await dialog.showMessageBox(options)
      }
    } finally {
      this.startupErrorDialogVisible = false
    }
  }

  async stop(): Promise<void> {
    this.desiredRunning = false
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
    // 同时停止 TCP 和 WebSocket 服务，并设置整体超时。
    // 只要任一服务关闭完成或超时，就继续退出流程，避免应用关不掉。
    await Promise.race([
      Promise.all([this.tcpServer.stop(), this.wsServer.stop()]),
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('服务停止超时')), 5000)
      })
    ])
  }
}

export const serviceManager = new ServiceManager()

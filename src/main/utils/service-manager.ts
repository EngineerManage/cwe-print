import { BrowserWindow } from 'electron'
import { configManager } from './config'
import { logger } from './logger'
import { TcpServer } from '../socket/tcp-server'
import { WsServer } from '../socket/ws-server'
import { handlePrintCommand } from '../print/engine'
import { printQueue } from '../print/queue'
import type { ServiceStatus } from '../../preload'

class ServiceManager {
  private tcpServer = new TcpServer()
  private wsServer = new WsServer()
  private statusTimer: NodeJS.Timeout | null = null

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

    // 定时广播状态（心跳）
    this.statusTimer = setInterval(() => this.broadcastStatus(), 5000)
  }

  async init(): Promise<void> {
    const config = configManager.get()
    await Promise.all([
      this.tcpServer.start(config.tcpPort).catch((err) => {
        logger.error(`TCP 服务启动失败: ${err.message}`, 'service')
      }),
      this.wsServer.start(config.wsPort).catch((err) => {
        logger.error(`WebSocket 服务启动失败: ${err.message}`, 'service')
      })
    ])
    this.broadcastStatus()
  }

  private async restartTcp(port: number): Promise<void> {
    try {
      await this.tcpServer.stop()
      await this.tcpServer.start(port)
      logger.info(`TCP 服务已重启，新端口: ${port}`, 'service')
      this.broadcastStatus()
    } catch (err) {
      logger.error(`TCP 服务重启失败: ${(err as Error).message}`, 'service')
    }
  }

  private async restartWs(port: number): Promise<void> {
    try {
      await this.wsServer.stop()
      await this.wsServer.start(port)
      logger.info(`WebSocket 服务已重启，新端口: ${port}`, 'service')
      this.broadcastStatus()
    } catch (err) {
      logger.error(`WebSocket 服务重启失败: ${(err as Error).message}`, 'service')
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

  async stop(): Promise<void> {
    if (this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
    await Promise.race([
      Promise.all([this.tcpServer.stop(), this.wsServer.stop()]),
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('服务停止超时')), 5000)
      })
    ])
  }
}

export const serviceManager = new ServiceManager()

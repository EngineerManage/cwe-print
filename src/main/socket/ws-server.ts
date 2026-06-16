import { WebSocketServer, type WebSocket } from 'ws'
import { logger } from '../utils/logger'
import type { PrintCommand } from './tcp-server'

export type WSCommandHandler = (cmd: PrintCommand, ws: WebSocket) => Promise<unknown>

export class WsServer {
  private server: WebSocketServer | null = null
  private port = 0
  private clients = new Set<WebSocket>()
  private handler: WSCommandHandler | null = null

  get status() {
    return {
      running: this.server !== null,
      port: this.port,
      clients: this.clients.size
    }
  }

  onCommand(handler: WSCommandHandler): void {
    this.handler = handler
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        if (this.port === port) {
          resolve()
          return
        }
        this.stop().then(() => this.doStart(port, resolve, reject))
        return
      }
      this.doStart(port, resolve, reject)
    })
  }

  private doStart(port: number, resolve: () => void, reject: (err: Error) => void): void {
    this.server = new WebSocketServer({ port, host: '0.0.0.0' })

    this.server.on('connection', (ws) => {
      this.clients.add(ws)
      logger.info('WebSocket 客户端已连接', 'ws')

      ws.on('message', async (data) => {
        try {
          const cmd = JSON.parse(data.toString()) as PrintCommand
          if (cmd.type !== 'print') {
            ws.send(JSON.stringify({ success: false, error: '未知指令类型' }))
            return
          }
          logger.info(`收到打印指令: ${cmd.id}, 格式: ${cmd.format}`, 'ws')
          const result = this.handler ? await this.handler(cmd, ws) : { success: false, error: '未设置处理器' }
          ws.send(JSON.stringify({ success: true, result }))
        } catch (err) {
          logger.error(`解析指令失败: ${(err as Error).message}`, 'ws')
          ws.send(JSON.stringify({ success: false, error: '指令格式错误' }))
        }
      })

      ws.on('close', () => {
        this.clients.delete(ws)
        logger.info('WebSocket 客户端已断开', 'ws')
      })

      ws.on('error', (err) => {
        logger.error(`WebSocket 客户端错误: ${err.message}`, 'ws')
        this.clients.delete(ws)
      })
    })

    this.server.on('error', (err) => {
      logger.error(`WebSocket 服务错误: ${err.message}`, 'ws')
      reject(err)
    })

    this.server.on('listening', () => {
      this.port = port
      logger.info(`WebSocket 服务已启动，端口: ${port}`, 'ws')
      resolve()
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      for (const client of this.clients) {
        client.terminate()
      }
      this.clients.clear()

      const timer = setTimeout(() => {
        logger.warn('WebSocket 服务关闭超时，强制结束', 'ws')
        this.server = null
        this.port = 0
        resolve()
      }, 3000)

      this.server.close(() => {
        clearTimeout(timer)
        logger.info('WebSocket 服务已停止', 'ws')
        this.server = null
        this.port = 0
        resolve()
      })
    })
  }

  broadcast(data: string): void {
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(data)
      }
    }
  }
}

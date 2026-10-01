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
      running: this.isListening(),
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
        if (this.port === port && this.isListening()) {
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
    const server = this.server

    server.on('connection', (ws, request) => {
      this.clients.add(ws)
      const client = `${request.socket.remoteAddress || 'unknown'}:${request.socket.remotePort || '-'}`
      logger.info(`WebSocket 客户端已连接: ${client}`, 'ws', {
        client,
        origin: request.headers.origin,
        url: request.url,
        userAgent: request.headers['user-agent']
      })

      ws.on('message', async (data) => {
        const text = data.toString()
        try {
          logger.info(`收到 WebSocket 消息，长度: ${text.length}`, 'ws', { client })
          const cmd = JSON.parse(text) as PrintCommand
          if (cmd.type !== 'print') {
            logger.warn(`WebSocket 指令类型不支持: ${String(cmd.type)}`, 'ws', {
              client,
              commandId: cmd.id
            })
            this.safeSend(ws, JSON.stringify({ success: false, error: '未知指令类型' }))
            return
          }
          logger.info(`收到打印指令: ${cmd.id}, 格式: ${cmd.format}`, 'ws', { client })
          const result = this.handler ? await this.handler(cmd, ws) : { success: false, error: '未设置处理器' }
          const failed = typeof result === 'object' && result !== null && 'status' in result && result.status === 'failed'
          this.safeSend(ws, JSON.stringify({
            success: !failed,
            result,
            error: failed && 'error' in result ? result.error : undefined
          }))
        } catch (err) {
          logger.error(`解析 WebSocket 指令失败: ${(err as Error).message}`, 'ws', {
            client,
            length: text.length,
            preview: text.slice(0, 300)
          })
          this.safeSend(ws, JSON.stringify({ success: false, error: '指令格式错误' }))
        }
      })

      ws.on('close', (code, reason) => {
        this.clients.delete(ws)
        logger.info(`WebSocket 客户端已断开: ${client}`, 'ws', {
          client,
          code,
          reason: reason.toString()
        })
      })

      ws.on('error', (err) => {
        logger.error(`WebSocket 客户端错误: ${err.message}`, 'ws', { client })
        this.clients.delete(ws)
      })
    })

    server.on('error', (err) => {
      logger.error(`WebSocket 服务错误: ${err.message}`, 'ws')
      if (this.server === server && !this.isListening()) {
        this.server = null
        this.port = 0
      }
      reject(err)
    })

    server.on('close', () => {
      if (this.server === server) {
        this.server = null
        this.port = 0
      }
    })

    server.on('listening', () => {
      this.port = port
      logger.info(`WebSocket 服务已启动，端口: ${port}`, 'ws', {
        address: server.address()
      })
      resolve()
    })
  }

  private isListening(): boolean {
    return this.server !== null && this.server.address() !== null
  }

  private safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState !== 1) return
    try {
      ws.send(data)
    } catch (err) {
      logger.error(`WebSocket 响应发送失败: ${(err as Error).message}`, 'ws')
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      // terminate() 立即关闭 WebSocket，比 close() 更彻底，避免等待握手完成
      for (const client of this.clients) {
        client.terminate()
      }
      this.clients.clear()

      // 兜底超时：防止极少数情况下 server.close() 长时间不回调
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

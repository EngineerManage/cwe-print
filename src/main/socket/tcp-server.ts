import { createServer, type Server, type Socket } from 'net'
import { logger } from '../utils/logger'

export interface PrintPosition {
  top: number
  left: number
}

export interface PrintMargins {
  top: number
  left: number
  right: number
  bottom: number
}

export type StandardPaperSize = 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal' | 'B5'

export interface CustomPaperSize {
  width: number
  height: number
  unit: 'mm' | 'in'
}

export type PaperSize = StandardPaperSize | CustomPaperSize

export interface PrintBlock {
  content: string
  position: PrintPosition
}

export interface PrintCommand {
  id: string
  type: 'print'
  format: 'pdf' | 'html' | 'image' | 'escpos'
  content: string
  printer?: string
  copies?: number
  paperSize?: PaperSize
  margins?: PrintMargins
  position?: PrintPosition
  blocks?: PrintBlock[]
  options?: Record<string, unknown>
}

export type CommandHandler = (cmd: PrintCommand, socket: Socket) => Promise<unknown>

export class TcpServer {
  private server: Server | null = null
  private port = 0
  private clients = new Set<Socket>()
  private handler: CommandHandler | null = null

  get status() {
    return {
      running: this.server !== null && this.server.listening,
      port: this.port,
      clients: this.clients.size
    }
  }

  onCommand(handler: CommandHandler): void {
    this.handler = handler
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server?.listening) {
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
    this.server = createServer((socket) => {
      this.clients.add(socket)
      logger.info(`TCP 客户端已连接: ${socket.remoteAddress}:${socket.remotePort}`, 'tcp')

      let buffer = ''
      socket.on('data', (data) => {
        buffer += data.toString('utf-8')
        // 支持换行分隔的 JSON 指令
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          this.handleLine(line.trim(), socket)
        }
      })

      socket.on('close', () => {
        this.clients.delete(socket)
        logger.info(`TCP 客户端已断开: ${socket.remoteAddress}:${socket.remotePort}`, 'tcp')
      })

      socket.on('error', (err) => {
        logger.error(`TCP 客户端错误: ${err.message}`, 'tcp')
        this.clients.delete(socket)
      })
    })

    this.server.on('error', (err) => {
      logger.error(`TCP 服务错误: ${err.message}`, 'tcp')
      reject(err)
    })

    this.server.listen(port, '0.0.0.0', () => {
      this.port = port
      logger.info(`TCP Socket 服务已启动，端口: ${port}`, 'tcp')
      resolve()
    })
  }

  private async handleLine(line: string, socket: Socket): Promise<void> {
    try {
      const cmd = JSON.parse(line) as PrintCommand
      if (cmd.type !== 'print') {
        socket.write(JSON.stringify({ success: false, error: '未知指令类型' }) + '\n')
        return
      }
      logger.info(`收到打印指令: ${cmd.id}, 格式: ${cmd.format}`, 'tcp')
      const result = this.handler ? await this.handler(cmd, socket) : { success: false, error: '未设置处理器' }
      socket.write(JSON.stringify({ success: true, result }) + '\n')
    } catch (err) {
      logger.error(`解析指令失败: ${(err as Error).message}`, 'tcp')
      socket.write(JSON.stringify({ success: false, error: '指令格式错误' }) + '\n')
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      // 断开所有客户端，避免 server.close() 一直等待连接关闭
      for (const client of this.clients) {
        client.destroy()
      }
      this.clients.clear()

      // 兜底超时：如果某个连接未正确触发 close，3 秒后强制认为已关闭，
      // 防止服务停止卡住导致应用无法退出
      const timer = setTimeout(() => {
        logger.warn('TCP 服务关闭超时，强制结束', 'tcp')
        this.server = null
        this.port = 0
        resolve()
      }, 3000)

      // closeAllConnections 在 Node 18+ 提供，可强制关闭所有剩余连接
      ;(this.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      this.server.close(() => {
        clearTimeout(timer)
        logger.info('TCP Socket 服务已停止', 'tcp')
        this.server = null
        this.port = 0
        resolve()
      })
    })
  }

  broadcast(data: string): void {
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(data + '\n')
      }
    }
  }
}

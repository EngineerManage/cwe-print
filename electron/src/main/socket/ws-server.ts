import { type IncomingMessage } from 'http'
import type { ServerResponse } from 'http'
import { type Server as NetServer, type Socket } from 'net'
import { createServer as createPolyglotServer } from 'httpolyglot'
import { WebSocketServer, type WebSocket } from 'ws'
import { certificateManager } from '../utils/certificate-manager'
import { logger } from '../utils/logger'
import type { PrintCommand } from './tcp-server'

export type WSCommandHandler = (cmd: PrintCommand, ws: WebSocket) => Promise<unknown>

interface EndpointStatus {
  running: boolean
  port: number
  clients: number
}

interface SecureEndpointStatus extends EndpointStatus {
  certificateTrusted: boolean
  certificateError?: string
}

interface EndpointRuntime {
  name: 'WS' | 'WSS'
  clients: Set<WebSocket>
}

export class WsServer {
  private wsEndpoint: EndpointRuntime | null = null
  private wssEndpoint: EndpointRuntime | null = null
  private wsServer: WebSocketServer | null = null
  private routerServer: NetServer | null = null
  private routerSockets = new Set<Socket>()
  private port = 0
  private handler: WSCommandHandler | null = null
  private certificateTrusted = false
  private certificateError: string | undefined
  private startPromise: Promise<void> | null = null

  get status(): { ws: EndpointStatus; wss: SecureEndpointStatus } {
    return {
      ws: {
        running: this.isEndpointListening(this.wsEndpoint),
        port: this.port,
        clients: this.wsEndpoint?.clients.size || 0
      },
      wss: {
        running: this.isEndpointListening(this.wssEndpoint),
        port: this.port,
        clients: this.wssEndpoint?.clients.size || 0,
        certificateTrusted: this.certificateTrusted,
        certificateError: this.certificateError
      }
    }
  }

  onCommand(handler: WSCommandHandler): void {
    this.handler = handler
  }

  async start(port: number): Promise<void> {
    if (this.startPromise) {
      await this.startPromise
      return this.start(port)
    }

    if (
      this.wsEndpoint &&
      this.wssEndpoint &&
      this.port === port &&
      this.isEndpointListening(this.wsEndpoint) &&
      this.isEndpointListening(this.wssEndpoint)
    ) {
      return
    }

    const startPromise = this.startInternal(port)
    this.startPromise = startPromise
    try {
      await startPromise
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null
      }
    }
  }

  private async startInternal(port: number): Promise<void> {
    await this.stop()
    const wsEndpoint = this.createEndpoint('WS')
    const wssEndpoint = this.createEndpoint('WSS')
    this.wsEndpoint = wsEndpoint
    this.wssEndpoint = wssEndpoint

    try {
      const certificate = await certificateManager.ensureLocalTlsCertificate()
      this.certificateTrusted = certificate.trusted
      this.certificateError = certificate.trustError

      const polyglotServer = createPolyglotServer({
        key: certificate.key,
        cert: certificate.cert
      }, (request, response) => {
        this.handleHealthRequest(request, response)
      })
      polyglotServer.on('connection', (socket: Socket) => {
        this.routerSockets.add(socket)
        socket.once('close', () => this.routerSockets.delete(socket))
      })
      this.routerServer = polyglotServer
      this.wsServer = new WebSocketServer({ noServer: true })
      this.wsServer.on('connection', (ws, request) => {
        this.attachClient(this.isEncryptedRequest(request) ? wssEndpoint : wsEndpoint, ws, request)
      })

      polyglotServer.on('upgrade', (request, socket, head) => {
        this.wsServer?.handleUpgrade(request, socket, head, (ws) => {
          this.wsServer?.emit('connection', ws, request)
        })
      })
      polyglotServer.on('tlsClientError', (err: Error) => {
        logger.warn(`WSS TLS 握手失败: ${err.message}`, 'ws')
      })
      polyglotServer.on('clientError', (err: Error) => {
        logger.warn(`WebSocket HTTP 握手失败: ${err.message}`, 'ws')
      })

      await this.listenRouter(port, polyglotServer)
    } catch (err) {
      await this.stop()
      throw err
    }
  }

  private createEndpoint(name: 'WS' | 'WSS'): EndpointRuntime {
    return {
      name,
      clients: new Set<WebSocket>()
    }
  }

  private attachClient(endpoint: EndpointRuntime, ws: WebSocket, request: IncomingMessage): void {
    endpoint.clients.add(ws)
    const client = `${request.socket.remoteAddress || 'unknown'}:${request.socket.remotePort || '-'}`
    logger.info(`${endpoint.name} 客户端已连接: ${client}`, 'ws', {
      protocol: endpoint.name.toLowerCase(),
      client,
      origin: request.headers.origin,
      url: request.url,
      userAgent: request.headers['user-agent']
    })

    ws.on('message', async (data) => {
      const text = data.toString()
      try {
        logger.info(`收到 ${endpoint.name} 消息，长度: ${text.length}`, 'ws', { client })
        const cmd = JSON.parse(text) as PrintCommand
        if (cmd.type !== 'print') {
          logger.warn(`${endpoint.name} 指令类型不支持: ${String(cmd.type)}`, 'ws', {
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
        logger.error(`解析 ${endpoint.name} 指令失败: ${(err as Error).message}`, 'ws', {
          client,
          length: text.length,
          preview: text.slice(0, 300)
        })
        this.safeSend(ws, JSON.stringify({ success: false, error: '指令格式错误' }))
      }
    })

    ws.on('close', (code, reason) => {
      endpoint.clients.delete(ws)
      logger.info(`${endpoint.name} 客户端已断开: ${client}`, 'ws', {
        client,
        code,
        reason: reason.toString()
      })
    })

    ws.on('error', (err) => {
      logger.error(`${endpoint.name} 客户端错误: ${err.message}`, 'ws', { client })
      endpoint.clients.delete(ws)
    })
  }

  private isEncryptedRequest(request: IncomingMessage): boolean {
    return (request.socket as Socket & { encrypted?: boolean }).encrypted === true
  }

  private handleHealthRequest(request: IncomingMessage, response: ServerResponse): void {
    const encrypted = this.isEncryptedRequest(request)
    const url = request.url || '/'
    if (url !== '/' && url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'not_found' }))
      return
    }

    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    })
    response.end(JSON.stringify({
      ok: true,
      protocol: encrypted ? 'wss' : 'ws',
      port: this.port,
      certificateTrusted: this.certificateTrusted,
      wsClients: this.wsEndpoint?.clients.size || 0,
      wssClients: this.wssEndpoint?.clients.size || 0
    }))
  }

  private listenRouter(port: number, server: NetServer): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening)
        logger.error(`WebSocket 服务启动失败: ${err.message}`, 'ws', { port, host: '0.0.0.0' })
        reject(err)
      }

      const onListening = () => {
        server.off('error', onError)
        this.port = port
        logger.info(`WebSocket 服务已启动，WS/WSS 共用端口: ${port}`, 'ws', {
          host: '0.0.0.0',
          address: server.address()
        })
        resolve()
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })
  }

  private isEndpointListening(endpoint: EndpointRuntime | null): boolean {
    return endpoint !== null && this.routerServer !== null && this.routerServer.listening
  }

  private safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState !== 1) return
    try {
      ws.send(data)
    } catch (err) {
      logger.error(`WebSocket 响应发送失败: ${(err as Error).message}`, 'ws')
    }
  }

  async stop(): Promise<void> {
    this.stopEndpoint(this.wsEndpoint)
    this.stopEndpoint(this.wssEndpoint)
    this.wsServer?.close()
    this.wsServer = null
    await this.stopRouter()
    this.wsEndpoint = null
    this.wssEndpoint = null
    this.port = 0
  }

  private stopRouter(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.routerServer) {
        resolve()
        return
      }

      const server = this.routerServer
      this.routerServer = null
      for (const socket of this.routerSockets) {
        socket.destroy()
      }
      this.routerSockets.clear()
      server.close(() => {
        resolve()
      })
    })
  }

  private stopEndpoint(endpoint: EndpointRuntime | null): void {
    if (!endpoint) return

    for (const client of endpoint.clients) {
      client.terminate()
    }
    endpoint.clients.clear()
    logger.info(`${endpoint.name} 服务已停止`, 'ws')
  }

  broadcast(data: string): void {
    for (const endpoint of [this.wsEndpoint, this.wssEndpoint]) {
      if (!endpoint) continue
      for (const client of endpoint.clients) {
        if (client.readyState === 1) {
          client.send(data)
        }
      }
    }
  }
}

declare module 'httpolyglot' {
  import type { ServerOptions } from 'https'
  import type { Server } from 'net'
  import type { RequestListener } from 'http'

  export function createServer(options: ServerOptions, requestListener?: RequestListener): Server
}

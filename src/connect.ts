import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ViteDevServer } from 'vite'
import type { VueMcpOptions } from './types'
import { createServer } from 'node:http'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import c from 'ansis'
import DEBUG from 'debug'

const debug = DEBUG('vite:mcp:server')

export async function setupRoutes(base: string, server: McpServer, vite: ViteDevServer, options: VueMcpOptions): Promise<void> {
  const transports = new Map<string, SSEServerTransport>()

  // 获取协议配置
  const useHttps = options.useHttps ?? vite.config.server.https !== undefined
  const mcpHost = options.mcpHost
  const mcpPort = options.mcpPort
  const protocol = useHttps ? 'https' : 'http'

  // 如果需要为Cursor创建HTTP代理
  if (useHttps && options.cursorUnsecureProxy) {
    const cursorProxyPort = options.cursorProxyPort
    // 创建HTTP服务器，仅接受来自localhost的连接
    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // 设置CORS头部
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const url = req.url || ''

      // 处理SSE请求
      if (url.startsWith(`${base}/sse`)) {
        debug('Cursor HTTP Proxy SSE req: %s', url)
        const transport = new SSEServerTransport(`${base}/messages`, res)
        transports.set(transport.sessionId, transport)
        debug('Cursor HTTP Proxy SSE sessionId: %s', transport.sessionId)

        res.on('close', () => {
          transports.delete(transport.sessionId)
        })

        try {
          await server.connect(transport)
        }
        catch (err) {
          debug('Cursor HTTP Proxy SSE connection error: %s', err)
        }
        return
      }

      // 处理消息请求
      if (url.startsWith(`${base}/messages`)) {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }

        const query = new URLSearchParams(url.split('?').pop() || '')
        const clientId = query.get('sessionId')

        if (!clientId || typeof clientId !== 'string') {
          res.statusCode = 400
          res.end('Bad Request')
          return
        }

        const transport = transports.get(clientId)
        if (!transport) {
          res.statusCode = 404
          res.end('Not Found')
          return
        }

        debug('Cursor HTTP Proxy Message from: %s', clientId)
        try {
          await transport.handlePostMessage(req, res)
        }
        catch (err) {
          debug('Cursor HTTP Proxy Message handling error: %s', err)
          res.statusCode = 500
          res.end('Internal Server Error')
        }
        return
      }

      // 未知路径
      res.statusCode = 404
      res.end('Not Found')
    })

    httpServer.listen(cursorProxyPort, 'localhost', () => {
      debug(`${c.green`  ➜  MCP:     `}Cursor HTTP Proxy running at http://localhost:${cursorProxyPort}${base}/sse`)
    })

    // 存储HTTP代理URL，用于更新.cursor/mcp.json
    options.cursorProxyUrl = `http://localhost:${cursorProxyPort}${base}/sse`
  }

  // 创建SSE连接路由 (主路由，使用HTTPS或HTTP取决于Vite配置)
  vite.middlewares.use(`${base}/sse`, async (req, res) => {
    debug('SSE req %s', req.url)

    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    // 处理OPTIONS请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 创建SSE传输
    const transport = new SSEServerTransport(`${base}/messages`, res)
    transports.set(transport.sessionId, transport)
    debug('SSE sessionId %s', transport.sessionId)

    // 监听连接关闭
    res.on('close', () => {
      transports.delete(transport.sessionId)
    })

    // 连接到MCP服务器
    try {
      await server.connect(transport)
    }
    catch (err) {
      debug('SSE connection error: %s', err)
    }
  })

  // 创建消息路由
  vite.middlewares.use(`${base}/messages`, async (req, res) => {
    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    // 处理OPTIONS请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    const query = new URLSearchParams(req.url?.split('?').pop() || '')
    const clientId = query.get('sessionId')

    if (!clientId || typeof clientId !== 'string') {
      res.statusCode = 400
      res.end('Bad Request')
      return
    }

    const transport = transports.get(clientId)
    if (!transport) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }

    debug('Message from %s', clientId)
    try {
      await transport.handlePostMessage(req, res)
    }
    catch (err) {
      debug('Message handling error: %s', err)
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  })

  // 日志输出
  setTimeout(() => {
    debug(`${c.yellow.bold`  ➜  MCP:     `}Server is running on ${protocol}://${mcpHost}:${mcpPort}${base}/sse`)
  }, 300)

  return Promise.resolve()
}

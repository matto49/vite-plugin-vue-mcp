import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import type { RpcFunctions, VueMcpContext, VueMcpOptions } from './types'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import c from 'ansis'
import DEBUG from 'debug'
import { join } from 'pathe'
import { normalizePath, searchForWorkspaceRoot } from 'vite'
import { createRPCServer } from 'vite-dev-rpc'
import { setupRoutes } from './connect'
import { createVueMcpContext } from './context'
import { createServerRpc } from './rpc'

function getVueMcpPath(): string {
  const pluginPath = normalizePath(path.dirname(fileURLToPath(import.meta.url)))
  return pluginPath.replace(/\/dist$/, '/\/src')
}
const vueMcpResourceSymbol = '?__vue-mcp-resource'

const debug = DEBUG('vite:mcp:server')

export function VueMcp(options: VueMcpOptions = {}): Plugin {
  const {
    mcpPath = '/__mcp',
    updateCursorMcpJson = true,
    printUrl = true,
    mcpHost = 'localhost',
    mcpPort = 3456,
    useHttps,
    cursorUnsecureProxy = false,
    cursorProxyPort = 3457,
    mcpServer = (vite: ViteDevServer, ctx: VueMcpContext) => import('./server').then(m => m.createMcpServerDefault(options, vite, ctx)),
  } = options

  // 设置所有配置的默认值，确保options对象包含完整配置
  options.mcpPath = mcpPath
  options.mcpHost = mcpHost
  options.mcpPort = mcpPort
  options.useHttps = useHttps
  options.cursorUnsecureProxy = cursorUnsecureProxy
  options.cursorProxyPort = cursorProxyPort
  options.updateCursorMcpJson = updateCursorMcpJson
  options.printUrl = printUrl

  const cursorMcpOptions = typeof updateCursorMcpJson == 'boolean'
    ? { enabled: updateCursorMcpJson }
    : updateCursorMcpJson

  let config: ResolvedConfig
  const vueMcpPath = getVueMcpPath()
  const vueMcpOptionsImportee = 'virtual:vue-mcp-options'
  const resolvedVueMcpOptions = `\0${vueMcpOptionsImportee}`

  const ctx = createVueMcpContext()

  return {
    name: 'vite-plugin-mcp',
    enforce: 'pre',
    apply: 'serve',
    async configureServer(vite) {
      const rpc = createServerRpc(ctx)

      const rpcServer = createRPCServer<RpcFunctions, any>(
        'vite-plugin-vue-mcp',
        vite.ws,
        rpc,
        {
          timeout: -1,
        },
      )
      ctx.rpcServer = rpcServer
      ctx.rpc = rpc

      let mcp = await mcpServer(vite, ctx)
      mcp = await options.mcpServerSetup?.(mcp, vite) || mcp
      await setupRoutes(mcpPath, mcp, vite, options)

      const port = vite.config.server.port || 5173
      const root = searchForWorkspaceRoot(vite.config.root)
      const useHttps = options.useHttps ?? vite.config.server.https !== undefined

      // 根据不同情况选择不同的URL
      let sseUrl: string
      if (useHttps && options.cursorUnsecureProxy) {
        // 使用HTTP代理
        sseUrl = `http://${options.mcpHost}:${options.cursorProxyPort}${mcpPath}/sse`
      }
      else {
        // 使用原生Vite服务器
        const protocol = useHttps ? 'https' : 'http'
        sseUrl = `${protocol}://${options.mcpHost}:${port}${mcpPath}/sse`
      }

      if (cursorMcpOptions.enabled) {
        if (existsSync(join(root, '.cursor'))) {
          const mcp = existsSync(join(root, '.cursor/mcp.json'))
            ? JSON.parse(await fs.readFile(join(root, '.cursor/mcp.json'), 'utf-8') || '{}')
            : {}
          mcp.mcpServers ||= {}

          // 将当前URL添加到.cursor/mcp.json
          mcp.mcpServers[cursorMcpOptions.serverName || 'vue-mcp'] = { url: sseUrl }

          if (useHttps && options.cursorUnsecureProxy) {
            debug(`Using HTTP proxy URL for Cursor: ${sseUrl}`)
          }

          await fs.writeFile(join(root, '.cursor/mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`)
        }
      }

      if (printUrl) {
        setTimeout(() => {
          // eslint-disable-next-line no-console
          console.log(`${c.yellow.bold`  ➜  MCP:     `}Server is running at ${sseUrl}`)
        }, 300)
      }
    },
    async resolveId(importee: string) {
      if (importee === vueMcpOptionsImportee) {
        return resolvedVueMcpOptions
      }
      else if (importee.startsWith('virtual:vue-mcp-path:')) {
        const resolved = importee.replace('virtual:vue-mcp-path:', `${vueMcpPath}/`)
        return `${resolved}${vueMcpResourceSymbol}`
      }
    },
    configResolved(resolvedConfig) {
      config = resolvedConfig
    },
    transform(code, id, _options) {
      if (_options?.ssr)
        return

      const appendTo = options.appendTo
      const [filename] = id.split('?', 2)

      if (appendTo
        && (
          (typeof appendTo === 'string' && filename.endsWith(appendTo))
          || (appendTo instanceof RegExp && appendTo.test(filename)))) {
        code = `import 'virtual:vue-mcp-path:overlay.js';\n${code}`
      }

      return code
    },
    transformIndexHtml(html) {
      if (options.appendTo)
        return

      return {
        html,
        tags: [
          {
            tag: 'script',
            injectTo: 'head-prepend',
            attrs: {
              type: 'module',
              src: `${config.base || '/'}@id/virtual:vue-mcp-path:overlay.js`,
            },
          },
        ],
      }
    },
  }
}

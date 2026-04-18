#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { spawn, ChildProcess, SpawnOptions } from 'child_process'

interface Tunnel {
  process: ChildProcess
  url: string
  port: number
}

interface ServerAndTunnel {
  serverProcess: ChildProcess
  tunnelProcess: ChildProcess
  url: string
  port: number
}

const tunnels = new Map<number, Tunnel>()
const serverTunnels = new Map<number, ServerAndTunnel>()

const server = new Server(
  { name: 'sidedoor', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'share_port',
      description:
        'Share a local port publicly using sidedoor. Returns the public URL. Use this when the user wants to share their app, expose localhost, or give someone a link to their running dev server.',
      inputSchema: {
        type: 'object',
        properties: {
          port: {
            type: 'number',
            description: 'The local port to share (e.g. 3000, 5173, 8080)',
          },
        },
        required: ['port'],
      },
    },
    {
      name: 'stop_sharing',
      description: 'Stop sharing a port that was previously shared with sidedoor.',
      inputSchema: {
        type: 'object',
        properties: {
          port: {
            type: 'number',
            description: 'The port to stop sharing',
          },
        },
        required: ['port'],
      },
    },
    {
      name: 'stop_all',
      description: 'Stop all active sidedoor tunnels.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'list_tunnels',
      description: 'List all currently active sidedoor tunnels and their public URLs.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'start_server_and_tunnel',
      description:
        'Start a local dev server with a shell command AND immediately expose it publicly via sidedoor. Returns the public URL. Use this when the user wants to run their app and share it in one step — e.g. "start my app and give me a shareable link".',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to start the local server (e.g. "npm run dev", "python -m http.server 8000")',
          },
          port: {
            type: 'number',
            description: 'The port the server will listen on',
          },
          wait_ms: {
            type: 'number',
            description: 'Milliseconds to wait for the server to start before opening the tunnel (default: 2000)',
          },
        },
        required: ['command', 'port'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'share_port': {
      const port = args?.port as number

      if (tunnels.has(port) || serverTunnels.has(port)) {
        const existing = tunnels.get(port) || serverTunnels.get(port)!
        return { content: [{ type: 'text', text: `Port ${port} is already shared at ${existing.url}` }] }
      }

      try {
        const url = await startTunnel(port)
        return {
          content: [{
            type: 'text',
            text: `Your app is live at ${url}\n\nAnyone with this link can access your local server on port ${port}.`,
          }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed to start tunnel: ${err instanceof Error ? err.message : 'unknown error'}` }],
          isError: true,
        }
      }
    }

    case 'stop_sharing': {
      const port = args?.port as number

      const tunnel = tunnels.get(port)
      if (tunnel) {
        tunnel.process.kill()
        tunnels.delete(port)
        return { content: [{ type: 'text', text: `Stopped sharing port ${port}` }] }
      }

      const st = serverTunnels.get(port)
      if (st) {
        st.tunnelProcess.kill()
        st.serverProcess.kill()
        serverTunnels.delete(port)
        return { content: [{ type: 'text', text: `Stopped server and tunnel on port ${port}` }] }
      }

      return { content: [{ type: 'text', text: `No active tunnel on port ${port}` }] }
    }

    case 'stop_all': {
      let count = 0
      for (const [port, t] of tunnels) {
        t.process.kill()
        tunnels.delete(port)
        count++
      }
      for (const [port, st] of serverTunnels) {
        st.tunnelProcess.kill()
        st.serverProcess.kill()
        serverTunnels.delete(port)
        count++
      }
      return { content: [{ type: 'text', text: count > 0 ? `Stopped ${count} tunnel(s)` : 'No active tunnels' }] }
    }

    case 'list_tunnels': {
      const all = [
        ...Array.from(tunnels.entries()).map(([port, t]) => `  port ${port} → ${t.url}`),
        ...Array.from(serverTunnels.entries()).map(([port, st]) => `  port ${port} → ${st.url} (server + tunnel)`),
      ]
      if (all.length === 0) {
        return { content: [{ type: 'text', text: 'No active tunnels' }] }
      }
      return { content: [{ type: 'text', text: `Active tunnels:\n${all.join('\n')}` }] }
    }

    case 'start_server_and_tunnel': {
      const command = args?.command as string
      const port = args?.port as number
      const waitMs = (args?.wait_ms as number) ?? 2000

      if (tunnels.has(port) || serverTunnels.has(port)) {
        const existing = tunnels.get(port) || serverTunnels.get(port)!
        return { content: [{ type: 'text', text: `Port ${port} is already in use at ${existing.url}` }] }
      }

      try {
        const result = await startServerAndTunnel(command, port, waitMs)
        return {
          content: [{
            type: 'text',
            text: `Server started and live at ${result.url}\n\nCommand: ${command}\nPort: ${port}\n\nAnyone with this link can access your app.`,
          }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed: ${err instanceof Error ? err.message : 'unknown error'}` }],
          isError: true,
        }
      }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
})

function startTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('sidedoor', [String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })

    let resolved = false
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill()
        reject(new Error('timed out waiting for tunnel URL'))
      }
    }, 15_000)

    const onData = (data: Buffer) => {
      const text = data.toString()
      const match = text.match(/Public\s+(https?:\/\/\S+)/)
      if (match && !resolved) {
        resolved = true
        clearTimeout(timeout)
        const url = match[1]
        tunnels.set(port, { process: proc, url, port })
        resolve(url)
      }
    }

    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)

    proc.on('error', (err) => {
      if (!resolved) {
        clearTimeout(timeout)
        reject(new Error(`sidedoor not found — run: npm install -g @sidedoor/cli\n${err.message}`))
      }
    })

    proc.on('exit', (code) => {
      tunnels.delete(port)
      if (!resolved) {
        clearTimeout(timeout)
        reject(new Error(`sidedoor exited with code ${code}`))
      }
    })
  })
}

function startServerAndTunnel(command: string, port: number, waitMs: number): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    const opts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], shell: true }
    const serverProc = spawn(command, [], opts)

    serverProc.on('error', (err) => reject(new Error(`Failed to start server: ${err.message}`)))

    setTimeout(async () => {
      try {
        const url = await new Promise<string>((res, rej) => {
          const proc = spawn('sidedoor', [String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })

          let resolved = false
          const timeout = setTimeout(() => {
            if (!resolved) {
              proc.kill()
              serverProc.kill()
              rej(new Error('timed out waiting for tunnel URL'))
            }
          }, 15_000)

          const onData = (data: Buffer) => {
            const text = data.toString()
            const match = text.match(/Public\s+(https?:\/\/\S+)/)
            if (match && !resolved) {
              resolved = true
              clearTimeout(timeout)
              res(match[1])
            }
          }

          proc.stdout?.on('data', onData)
          proc.stderr?.on('data', onData)

          proc.on('error', (err) => {
            if (!resolved) {
              clearTimeout(timeout)
              serverProc.kill()
              rej(new Error(`sidedoor not found — run: npm install -g @sidedoor/cli\n${err.message}`))
            }
          })

          proc.on('exit', (code) => {
            if (!resolved) {
              clearTimeout(timeout)
              rej(new Error(`sidedoor exited with code ${code}`))
            }
          })

          serverTunnels.set(port, { serverProcess: serverProc, tunnelProcess: proc, url: '', port })
        })

        const st = serverTunnels.get(port)
        if (st) st.url = url
        resolve({ url })
      } catch (err) {
        reject(err)
      }
    }, waitMs)
  })
}

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)

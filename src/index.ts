#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ---- File paths ----

const SIDEDOOR_DIR = join(homedir(), '.sidedoor')
const STATE_FILE = join(SIDEDOOR_DIR, 'mcp-state.json')

// ---- Binary ----

function findBinary(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const direct = join(SIDEDOOR_DIR, 'bin', `sidedoor${ext}`)
  if (existsSync(direct)) return direct
  return 'sidedoor'
}

// ---- Process helpers ----

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function killPid(pid: number) {
  try { process.kill(pid, 'SIGTERM') } catch {}
  setTimeout(() => {
    try { if (isAlive(pid)) process.kill(pid, 'SIGKILL') } catch {}
  }, 2000)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ---- State ----

interface PersistedTunnel {
  port: number
  url: string
  pid: number
}

interface ActiveTunnel {
  pid: number
  url: string
  port: number
  process: ChildProcess | null
}

// Tunnels started by this MCP session.
const activeTunnels = new Map<number, ActiveTunnel>()

function saveState() {
  try {
    mkdirSync(SIDEDOOR_DIR, { recursive: true })
    const state: PersistedTunnel[] = []
    for (const [port, t] of activeTunnels) {
      if (t.pid) state.push({ port, url: t.url, pid: t.pid })
    }
    writeFileSync(STATE_FILE, JSON.stringify(state))
  } catch {}
}

function loadState() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8')
    const state: PersistedTunnel[] = JSON.parse(raw)
    for (const t of state) {
      if (isAlive(t.pid)) {
        activeTunnels.set(t.port, { pid: t.pid, url: t.url, port: t.port, process: null })
      }
    }
    saveState()
  } catch {}
}

// Read all live tunnels from the shared state file — includes tunnels
// started by the desktop app, CLI, or other MCP sessions.
function readAllTunnels(): PersistedTunnel[] {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8')
    const state: PersistedTunnel[] = JSON.parse(raw)
    return state.filter(t => isAlive(t.pid))
  } catch {
    return []
  }
}

loadState()

// ---- Tunnel management ----

function startTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = findBinary()
    const proc = spawn(bin, [String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) { proc.kill(); reject(new Error('timed out waiting for tunnel URL (15s)')) }
    }, 15_000)

    const onData = (data: Buffer) => {
      const text = data.toString()
      const match = text.match(/Public\s+(https?:\/\/\S+)/)
      if (match && !resolved) {
        resolved = true
        clearTimeout(timeout)
        const url = match[1]
        activeTunnels.set(port, { pid: proc.pid!, url, port, process: proc })
        saveState()
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
      activeTunnels.delete(port)
      saveState()
      if (!resolved) {
        clearTimeout(timeout)
        reject(new Error(`sidedoor exited unexpectedly (code ${code})`))
      }
    })
  })
}

function startServerAndTunnel(command: string, port: number, waitMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const serverProc = spawn(command, [], { stdio: ['ignore', 'pipe', 'pipe'], shell: true } as SpawnOptions)
    let done = false

    const fail = (err: Error) => {
      if (!done) { done = true; reject(err) }
    }

    serverProc.on('error', (err) => fail(new Error(`Failed to start server: ${err.message}`)))
    serverProc.on('exit', (code) => fail(new Error(`Server exited before tunnel could start (code ${code})`)))

    const timer = setTimeout(async () => {
      if (done) return
      try {
        const url = await startTunnel(port)
        done = true
        resolve(url)
      } catch (err) {
        serverProc.kill()
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }, waitMs)

    // Server crashed before waitMs — cancel the tunnel attempt
    serverProc.once('exit', () => clearTimeout(timer))
  })
}

// ---- MCP server ----

const server = new Server(
  { name: 'sidedoor', version: '0.1.0' },
  { capabilities: { tools: {}, prompts: {} } }
)

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{
    name: 'sidedoor_behavior',
    description: 'Instructs the AI to automatically open a sidedoor tunnel whenever a local server is started',
  }],
}))

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name === 'sidedoor_behavior') {
    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: 'Whenever you start a local dev server (npm run dev, python manage.py runserver, go run, etc.), automatically use the start_server_and_tunnel sidedoor tool to expose it publicly and show the public URL. If the server is already running, use share_port instead. Always show the URL prominently so it can be copied and shared.',
        },
      }],
    }
  }
  throw new Error(`Unknown prompt: ${request.params.name}`)
})

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'share_port',
      description: 'Share a local port publicly using sidedoor. Returns the public URL. Use this when the user wants to share their app, expose localhost, or give someone a link to their running dev server.',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'number', description: 'The local port to share (e.g. 3000, 5173, 8080)' },
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
          port: { type: 'number', description: 'The port to stop sharing' },
        },
        required: ['port'],
      },
    },
    {
      name: 'stop_all',
      description: 'Stop all active sidedoor tunnels started by this MCP session.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_tunnels',
      description: 'List all currently active sidedoor tunnels and their public URLs — including tunnels started from the terminal, desktop app, or other sessions.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'start_server_and_tunnel',
      description: 'Start a local dev server with a shell command AND immediately expose it publicly via sidedoor. Returns the public URL. Use this when the user wants to run their app and share it in one step.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to start the local server (e.g. "npm run dev")' },
          port: { type: 'number', description: 'The port the server will listen on' },
          wait_ms: { type: 'number', description: 'Milliseconds to wait for the server to start before opening the tunnel (default: 2000)' },
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
      const existing = activeTunnels.get(port)
      if (existing && isAlive(existing.pid)) {
        return { content: [{ type: 'text', text: `Port ${port} is already shared at ${existing.url}` }] }
      }
      try {
        const url = await startTunnel(port)
        return { content: [{ type: 'text', text: `Your app is live at ${url}\nAnyone with this link can access your local server on port ${port}.` }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to start tunnel: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true }
      }
    }

    case 'stop_sharing': {
      const port = args?.port as number
      const tunnel = activeTunnels.get(port)
      if (!tunnel) return { content: [{ type: 'text', text: `No active tunnel on port ${port}` }] }
      killPid(tunnel.pid)
      if (tunnel.process) tunnel.process.kill()
      activeTunnels.delete(port)
      saveState()
      await sleep(1000)
      return { content: [{ type: 'text', text: `Stopped sharing port ${port}` }] }
    }

    case 'stop_all': {
      let count = 0
      for (const [port, t] of activeTunnels) {
        killPid(t.pid)
        if (t.process) t.process.kill()
        activeTunnels.delete(port)
        count++
      }
      saveState()
      if (count > 0) await sleep(1000)
      return { content: [{ type: 'text', text: count > 0 ? `Stopped ${count} tunnel(s)` : 'No active tunnels' }] }
    }

    case 'list_tunnels': {
      const all = readAllTunnels()
      if (all.length === 0) return { content: [{ type: 'text', text: 'No active tunnels' }] }
      const lines = all.map(t => `  port ${t.port} → ${t.url}`).join('\n')
      return { content: [{ type: 'text', text: `Active tunnels:\n${lines}` }] }
    }

    case 'start_server_and_tunnel': {
      const command = args?.command as string
      const port = args?.port as number
      const waitMs = (args?.wait_ms as number) ?? 2000
      const existing = activeTunnels.get(port)
      if (existing && isAlive(existing.pid)) {
        return { content: [{ type: 'text', text: `Port ${port} is already in use at ${existing.url}` }] }
      }
      try {
        const url = await startServerAndTunnel(command, port, waitMs)
        return { content: [{ type: 'text', text: `Server started and live at ${url}\nCommand: ${command}\nPort: ${port}` }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true }
      }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)

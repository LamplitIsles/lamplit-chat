import { McpClient, StreamableHttpTransport, toLlmContent, type McpFetch } from '@earendil-works/pi-mcp'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { Type } from 'typebox'

type Server = { name: string; url: string; bearerToken?: string }
const DISCOVERY_TIMEOUT_MS = 5000
const CALL_TIMEOUT_MS = 30000
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

// Only deployment-owned identity is accepted here, never a browser-provided host or tool argument.
export function injectedServers(config: string | undefined, instanceId: string | null): Server[] {
  if (!config) return []
  const invalid = () => new Error('Invalid MCP_CONFIG: expected instance IDs mapped to name/url/bearerToken server arrays')
  let parsed: unknown
  try { parsed = JSON.parse(config) } catch { throw invalid() }
  if (!object(parsed)) throw invalid()
  for (const [instance, servers] of Object.entries(parsed)) {
    if ((instance !== 'singleton' && !/^[0-9a-f-]{36}$/.test(instance)) || !Array.isArray(servers)) throw invalid()
    const names = new Set<string>()
    for (const server of servers) {
      if (!object(server) || Object.keys(server).some(key => !['name', 'url', 'bearerToken'].includes(key))
        || typeof server.name !== 'string' || !server.name.trim() || names.has(server.name)
        || typeof server.url !== 'string'
        || (server.bearerToken !== undefined && (typeof server.bearerToken !== 'string' || !server.bearerToken.trim() || /[\r\n]/.test(server.bearerToken)))) throw invalid()
      let url: URL
      try { url = new URL(server.url) } catch { throw invalid() }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalid()
      names.add(server.name)
    }
  }
  return (parsed[instanceId ?? 'singleton'] ?? []) as Server[]
}

export async function remoteToolName(server: string, tool: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([server, tool]))))
  const hash = Array.from(digest.slice(0, 6), byte => byte.toString(16).padStart(2, '0')).join('')
  const slug = (value: string, length: number) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, length) || 'tool'
  return `mcp_${slug(server, 16)}_${slug(tool, 24)}_${hash}`
}

// One operation owns its client, deadline and I/O; only JSON tool metadata survives discovery.
async function withClient<T>(server: Server, timeoutMs: number, signal: AbortSignal | undefined, run: (client: McpClient, signal: AbortSignal) => Promise<T>, fetcher: McpFetch): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  const client = new McpClient({ name: 'lamplit-chat', version: '1', requestTimeoutMs: timeoutMs })
  const transport = new StreamableHttpTransport({
    url: server.url, headers: server.bearerToken ? { Authorization: `Bearer ${server.bearerToken}` } : undefined,
    openGetStream: false, reconnect: { maxRetries: 0 },
    fetch: (url, init) => fetcher(url, { ...init, redirect: 'error' }),
  })
  // Closing also aborts pending initialize/notification I/O, which has no public caller-signal option.
  let closePromise: Promise<void> | undefined
  let connecting = true
  const closing = () => { if (connecting) closePromise ??= client.close() }
  controller.signal.addEventListener('abort', closing, { once: true })
  try {
    controller.signal.throwIfAborted()
    await client.connect(transport)
    connecting = false
    return await run(client, controller.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', closing)
    await (closePromise ?? client.close())
  }
}

export async function createInjectedMcpTools(config: string | undefined, instanceId: string | null, existing: readonly ToolRegistration[], fetcher: McpFetch = globalThis.fetch): Promise<ToolRegistration[]> {
  let servers: Server[]
  try { servers = injectedServers(config, instanceId) }
  catch { console.error('Invalid MCP_CONFIG: remote tools disabled; check the deployment secret shape and HTTPS URLs'); return [] }
  const used = new Set(existing.map(tool => tool.name))
  const tools: ToolRegistration[] = []
  await Promise.all(servers.map(async (server, index) => {
    try {
      const remote = await withClient(server, DISCOVERY_TIMEOUT_MS, undefined, (client, signal) => client.listTools({ signal }), fetcher)
      const discovered: ToolRegistration[] = []
      for (const tool of remote) {
        if (!tool.name || tool.inputSchema.type !== 'object') throw new Error('Invalid tool metadata')
        const name = await remoteToolName(server.name, tool.name)
        if (used.has(name)) throw new Error('Tool name collision')
        used.add(name)
        discovered.push({ name, description: tool.description ?? `Remote ${server.name} tool: ${tool.name}`,
          parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema), replay: 'unsafe',
          execute: async (args, _api, context) => {
            try {
              if (!object(args)) throw new Error('Invalid MCP arguments')
              const result = await withClient(server, CALL_TIMEOUT_MS, context.abortSignal, (client, signal) => client.callTool(tool.name, args, { signal }), fetcher)
              const content = toLlmContent(result)
              if (result.content.length && result.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) })
              return { content, isError: result.isError ?? false }
            } catch {
              // HTTP/RPC error bodies may echo credentials; expose neither those bodies nor the URL.
              return { content: [{ type: 'text', text: context.abortSignal?.aborted ? 'Remote MCP call cancelled; delivery may have occurred.' : 'Remote MCP call failed or timed out; delivery may have occurred. Do not automatically retry.' }], isError: true }
            }
          },
        })
      }
      tools.push(...discovered)
    } catch { console.error(`MCP discovery failed for server ${index + 1}; remote tools unavailable until the next harness preparation`) }
  }))
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}

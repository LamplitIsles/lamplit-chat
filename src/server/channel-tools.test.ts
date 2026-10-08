import { describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { callChannelTool, createChannelTools, discoverMatrixSelf } from './channel-tools'

const config = { mcpUrl: 'https://fixture.invalid/mcp', mcpToken: 'synthetic-mcp', webhookToken: 'synthetic-webhook', aliases: [] }
function sdkFixture() {
  const requests: Array<{ method: string; name?: string; args?: unknown }> = []
  let opened = 0, closed = 0
  const fetcher: typeof fetch = async (_url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${config.mcpToken}`)
    expect(init?.redirect).toBe('manual')
    if (init?.method !== 'POST') return new Response(null, { status: 405 })
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '')
    requests.push({ method: body.method, name: body.params?.name, args: body.params?.arguments })
    const server = new McpServer({ name: 'fixture', version: '1' })
    for (const name of ['whoami', 'list_rooms', 'list_room_members', 'read_messages', 'send_message', 'list_destinations', 'list_members', 'read_recent_messages']) {
      server.registerTool(name, { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify(name === 'whoami' ? { user_id: '@self:test' } : { name, owner: 'fixture' }) }] }))
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    opened++
    try { await server.connect(transport); return await transport.handleRequest(new Request(config.mcpUrl, init)) }
    finally { await server.close(); closed++ }
  }
  return { fetcher, requests, counts: () => ({ opened, closed }) }
}
describe('fixed native channel tools with real SDK HTTP interoperability', () => {
  it('uses short original tool names, separate native namespaces and bearer HTTP, closes success transports', async () => {
    const f = sdkFixture()
    for (const [channel, names] of [['keet', ['list_destinations', 'list_members', 'read_recent_messages', 'send_message']], ['matrix', ['whoami', 'list_rooms', 'list_room_members', 'read_messages', 'send_message']]] as const) {
      for (const name of names) expect(JSON.parse(await callChannelTool(config, channel, name, {}, undefined, f.fetcher))).toMatchObject(name === 'whoami' ? { user_id: '@self:test' } : { name })
    }
    expect(createChannelTools({})).toHaveLength(0)
    expect(createChannelTools({ keet: config, matrix: config }).map(tool => tool.name)).toEqual(['keet_list_destinations', 'keet_list_members', 'keet_read_recent_messages', 'keet_send_message', 'matrix_whoami', 'matrix_list_rooms', 'matrix_list_room_members', 'matrix_read_messages', 'matrix_send_message'])
    await vi.waitFor(() => expect(f.counts().closed).toBe(f.counts().opened))
    expect(f.requests.filter(request => request.method === 'tools/call')).toHaveLength(9)
  })
  it('refuses redirects and sanitizes private upstream errors without retrying uncertain sends', async () => {
    let sends = 0
    const f = sdkFixture()
    const redirect: typeof fetch = async () => new Response(null, { status: 302, headers: { location: 'https://stolen.invalid/mcp' } })
    await expect(callChannelTool(config, 'keet', 'list_destinations', {}, undefined, redirect)).rejects.toThrow('keet list_destinations unavailable.')
    const lost: typeof fetch = async (url, init) => {
      const request = init?.method === 'POST' ? JSON.parse(typeof init.body === 'string' ? init.body : '') : {}
      if (request.method === 'tools/call') { sends++; throw new Error('private-token-sensitive-origin') }
      return f.fetcher(url, init)
    }
    await expect(callChannelTool(config, 'matrix', 'send_message', {}, undefined, lost)).rejects.toThrow('send outcome is uncertain')
    expect(sends).toBe(1)
  })
  it('bounds initialization and propagates abort to pending HTTP', async () => {
    let aborted = 0
    const pending: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      const fail = () => { aborted++; reject(new Error('private diagnostics')) }
      if (init?.signal?.aborted) fail()
      else init?.signal?.addEventListener('abort', fail, { once: true })
    })
    await expect(callChannelTool(config, 'matrix', 'whoami', {}, undefined, pending, 25)).rejects.toThrow('matrix whoami unavailable.')
    expect(aborted).toBeGreaterThan(0)
    // Disabled identity is never guessed when its original MCP endpoint is unavailable.
    const mocked = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private upstream'))
    try { await expect(discoverMatrixSelf(config)).rejects.toThrow('Matrix identity unavailable') } finally { mocked.mockRestore() }
  })
})

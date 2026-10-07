import type { CallToolResult, McpFetch } from '@earendil-works/pi-mcp'

export const remoteSchema = { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false }
export function fakeMcp() {
  const requests: { url: string; method: string; auth: string | null; params?: Record<string, unknown>; redirect?: RequestRedirect }[] = []
  let session = 0
  let fail = false
  let hold = false
  let holdCall = false
  let aborted = 0
  let result: CallToolResult = { content: [{ type: 'text', text: 'Remote answer' }, { type: 'image', data: 'Zml4dHVyZQ==', mimeType: 'image/png' }], structuredContent: { fixture: true } }
  const fetch: McpFetch = async (url, init) => {
    if (init?.method === 'DELETE') { requests.push({ url: String(url), method: 'DELETE', auth: new Headers(init.headers).get('authorization') }); return new Response(null, { status: 204 }) }
    const rpc = JSON.parse(init!.body as string)
    requests.push({ url: String(url), method: rpc.method, auth: new Headers(init?.headers).get('authorization'), params: rpc.params, redirect: init?.redirect })
    if (fail) return new Response('secret-fixture-token', { status: 401 })
    if (rpc.id === undefined) return new Response(null, { status: 202 })
    if ((hold && rpc.method === 'initialize') || ((hold || holdCall) && rpc.method === 'tools/call')) return new Promise((_resolve, reject) => {
      const abort = () => { aborted++; reject(new DOMException('Aborted', 'AbortError')) }
      if (init?.signal?.aborted) abort()
      else init?.signal?.addEventListener('abort', abort, { once: true })
    })
    const data = rpc.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Fixture remote echo', inputSchema: remoteSchema, annotations: { readOnlyHint: true } }] }
      : result
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: data }, { headers: { 'mcp-session-id': `fake-${rpc.method === 'initialize' ? ++session : session}` } })
  }
  return { fetch, requests, aborted: () => aborted, fail: () => { fail = true }, hold: () => { hold = true }, holdCall: () => { holdCall = true }, result: (value: CallToolResult) => { result = value } }
}

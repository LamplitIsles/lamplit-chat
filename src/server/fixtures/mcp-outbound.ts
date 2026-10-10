// Node-side, test-owned outbound peer. Unmatched requests never reach the network.
const requests = new Map<string, { method: string; authenticated: boolean }[]>()
let forbiddenFollows = 0
export async function mcpOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.hostname === 'native-history.fixture.invalid' && url.pathname === '/counters' && request.method === 'POST') {
    console.info('native-history test-owned counters', JSON.stringify(await request.json()))
    return new Response(null, { status: 204 })
  }
  if (url.hostname === 'must-not-follow.fixture.invalid') forbiddenFollows++
  if (url.hostname !== 'native-mcp.fixture.invalid') throw new Error('Unmatched test-owned outbound request')
  const scenario = url.searchParams.get('case') ?? 'healthy'
  if (url.pathname === '/inspect') return Response.json({ calls: requests.get(scenario) ?? [], forbiddenFollows })
  if (url.pathname !== '/mcp') throw new Error('Unmatched test-owned endpoint')
  const rpc = request.method === 'DELETE' ? undefined : await request.json() as { id?: number; method: string }
  const method = rpc?.method ?? 'DELETE'
  const records = requests.get(scenario) ?? []
  records.push({ method, authenticated: request.headers.get('authorization') === 'Bearer fictional-native-token' })
  requests.set(scenario, records)
  if (method === scenario) return new Response(null, { status: 302, headers: { location: 'https://must-not-follow.fixture.invalid/mcp' } })
  if (!rpc || rpc.id === undefined) return new Response(null, { status: rpc ? 202 : 204 })
  const result = rpc.method === 'initialize'
    ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
  return Response.json({ jsonrpc: '2.0', id: rpc.id, result }, { headers: { 'mcp-session-id': 'test-owned-session' } })
}

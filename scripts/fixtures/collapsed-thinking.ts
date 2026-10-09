// Test-owned native ingress and fake upstream. No projected DTO or storage writes.
import worker from '../../src/server'
import { PiSession as NativeSession } from '../../src/server/pi-session'
import { PAGE_SIZE } from '@lamplit/contracts'
export { PiRegistry } from '../../src/server/pi-registry'
let response: { text: string; thinking?: string; failed?: boolean }
globalThis.fetch = async (request) => {
  const url = request instanceof Request ? request.url : String(request)
  if (!url.startsWith('https://openrouter.ai/')) throw new Error('Thinking acceptance forbids external services')
  const events = [
    { choices: [{ index: 0, delta: { role: 'assistant', ...(response.thinking !== undefined ? { reasoning_content: response.thinking } : {}), content: response.text }, finish_reason: null }] },
    ...(response.failed ? [{ error: { message: 'Test-owned provider failure', code: 'fixture' } }] : [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }]),
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
export class PiSession extends NativeSession {
  scheduleMemoryExtraction() {}
  async feed(message) {
    response = { text: message.role === 'user' ? '原生输入确认' : message.role === 'notice' ? '' : message.text, ...(message.role === 'agent' && message.thinking !== undefined ? { thinking: message.thinking } : {}), failed: message.role === 'notice' }
    const operationId = crypto.randomUUID()
    await super.submitChat({ operationId, text: message.role === 'user' ? message.text : `Test-owned input ${message.id}` })
    await this.native.wait(operationId)
    await (await this.getHarness()).waitForIdle(this.nativeContext)
    return { accepted: true }
  }
  async disconnectFixture() {
    for (const connection of this.getConnections()) connection.close(1012, 'Test-owned reconnect')
    return { disconnected: true }
  }
}
let sessionId
const live = []
async function fresh(env) {
  sessionId = crypto.randomUUID()
  await env.PiSession.getByName(sessionId).initialize({ id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
}
export default { async fetch(request, env) {
  const url = new URL(request.url)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return new Response('Fixture is loopback-only', { status: 403 })
  const path = url.pathname
  if (path === '/__test/collapsed-thinking/disconnect') return Response.json(await env.PiSession.getByName(sessionId).disconnectFixture())
  if (path === '/__test/collapsed-thinking') {
    const input = await request.json()
    if (input.action === 'reset') { live.length = 0; await fresh(env) }
    else if (input.action === 'message') {
      if (input.history) {
        // Recreate only this fixture through ingress in historical order before
        // the browser opens. Every row is persisted by the real native engine.
        await fresh(env)
        await env.PiSession.getByName(sessionId).feed(input.message)
        for (let i = 0; i < (PAGE_SIZE - live.length * 2) / 2; i++) await env.PiSession.getByName(sessionId).feed({ id: `filler-${i}`, role: 'agent', text: '原生分页记录' })
        for (const message of live) await env.PiSession.getByName(sessionId).feed(message)
      } else {
        live.push(input.message)
        // Assistant image associations are unsupported. The approved boundary
        // covers native thinking/text once; App fixtures own grouped image UI.
        await env.PiSession.getByName(sessionId).feed(input.message)
      }
    } else throw new Error('Unknown thinking fixture action')
    return Response.json({ accepted: true })
  }
  // Fictional authenticated loopback gateway for the frozen runner, which has
  // no login step. The real host still executes its authentication handler.
  const authenticated = new Request(request)
  authenticated.headers.set('authorization', `Basic ${btoa('owner:fixture-password-long-enough')}`)
  return worker.fetch(authenticated, { ...env, COMPANION_SESSION_ID: sessionId })
} }

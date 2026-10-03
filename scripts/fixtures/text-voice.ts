// Test-only native control handoff. Public routes always use the production Worker.
import worker from '../../src/server'
import { PiSession as NativeSession } from '../../src/server/pi-session'
export { PiRegistry } from '../../src/server/pi-registry'
const state = { executions: 0, text: 'recognized final', hold: false, availability: 'enabled', takes: [], releases: [] }
const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url.startsWith('https://example.invalid/')) {
    state.executions++
    let release
    const body = new ReadableStream({ start(controller) {
      release = (text = '完整回复') => { try { controller.enqueue(new TextEncoder().encode(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n')); controller.close() } catch {} }
      state.releases.push(release)
      init?.signal?.addEventListener('abort', () => { state.releases = state.releases.filter(current => current !== release); try { controller.error(new DOMException('Aborted', 'AbortError')) } catch {} }, { once: true })
    } })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  if (url !== 'https://dashscope.aliyuncs.com/api-ws/v1/inference') throw new Error('Fixture forbids external providers')
  const pair = new WebSocketPair(), socket = pair[1]; socket.binaryType = 'arraybuffer'; socket.accept()
  const take = { id: crypto.randomUUID(), bytes: 0, controls: [], closed: false, finishedBytes: 0, firstFrame: [], nonzero: false, text: state.text, hold: state.hold, socket, taskId: null, upstreamEvents: [], nativeEvents: [] }
  state.takes.push(take)
  const send = (event, payload = {}) => { take.upstreamEvents.push({event, taskId: take.taskId}); try { socket.send(JSON.stringify({ header: { event, task_id: take.taskId }, payload })) } catch (error) { take.upstreamEvents.push({error: String(error)}) } }
  take.result = (text) => { send('result-generated', { output: { sentence: { sentence_id: 1, sentence_end: true, text } } }); send('task-finished') }
  take.error = () => { take.pendingError = true }
  const delivery = setInterval(() => { if (take.pendingError) { take.pendingError = false; send('task-failed') } if (take.pendingResult !== undefined) { const text = take.pendingResult; take.pendingResult = undefined; take.result(text) } }, 10)
  socket.addEventListener('close', () => { take.closed = true; clearInterval(delivery) })
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return // Observation is at the native client transport, below.
    const command = JSON.parse(event.data); take.taskId = command.header.task_id
    if (command.header.action === 'run-task') send('task-started')
    if (command.header.action === 'finish-task' && !take.hold) take.result(take.text)
  })
  return new Response(null, { status: 101, webSocket: pair[0] })
}
export class PiSession extends NativeSession {
  scheduleMemoryExtraction() {} // No unrelated fake-provider call.
  async resetFixture() {
    if (this.active) await this.abort()
    for (const release of state.releases.splice(0)) release()
    const metadata = this.sessionStorage.getMetadataSync()
    await this.importSession({ metadata, entries: [], compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, files: [] })
  }
  async disconnectFixture() { for (const connection of this.getConnections()) connection.close(1012, 'Test-owned observation loss') }
  async settleFixture() {
    for (let i = 0; i < 300; i++) { if (!this.active) return; await new Promise(resolve => setTimeout(resolve, 10)) }
    throw new Error('Held native turn did not settle')
  }
}
let sessionId
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname
  const sessionKey = () => env.FIXTURE_HOSTED_INSTANCE ? `${env.FIXTURE_HOSTED_INSTANCE}:${sessionId}` : sessionId
  if (path === '/__test/text' || path === '/__test/voice') {
    const input = await request.json()
    if (input.action === 'reset') {
      if (sessionId) await env.PiSession.getByName(sessionKey()).resetFixture()
      sessionId = env.FIXTURE_HOSTED_INSTANCE ? (await env.PiRegistry.getByName(env.FIXTURE_HOSTED_INSTANCE).ensureDefaultSession()).id : crypto.randomUUID()
      await env.PiSession.getByName(sessionKey()).initialize({ id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
      Object.assign(state, { executions: 0, text: 'recognized final', hold: false, availability: 'enabled', takes: [], releases: [] })
    }
    if (input.action === 'speech') { if (input.text !== undefined) state.text = input.text; if (input.hold !== undefined) state.hold = input.hold; if (input.availability !== undefined) state.availability = input.availability }
    if (input.action === 'complete') { for (const release of state.releases.splice(0)) release(input.text); await env.PiSession.getByName(sessionKey()).settleFixture() }
    if (input.action === 'disconnect') await env.PiSession.getByName(sessionKey()).disconnectFixture()
    if (input.action === 'result') state.takes.find(take => take.id === input.takeId) && (state.takes.find(take => take.id === input.takeId).pendingResult = input.text)
    if (input.action === 'error') state.takes.find(take => take.id === input.takeId)?.error()
    return Response.json({ sessionId, executions: state.executions, takes: state.takes.map(({ socket, result, error, text, hold, taskId, ...take }) => take) })
  }
  const response = await worker.fetch(request, { ...env, COMPANION_SESSION_ID: sessionId, VOICE_API_KEY: state.availability === 'disabled' ? '' : env.VOICE_API_KEY })
  if (path === '/api/voice/capability' && state.availability === 'unreachable' && response.ok) {
    await response.body?.cancel()
    return new Response(null, { status: 503 }) // Fail delivery only after actual native authentication/config read.
  }
  if (path === '/api/voice/stream' && response.webSocket) {
    // Transparent test-owned transport observation; native relay sees every frame/control.
    const upstream = response.webSocket; upstream.accept(); upstream.binaryType = 'arraybuffer'
    const pair = new WebSocketPair(), client = pair[1]; client.accept(); client.binaryType = 'arraybuffer'
    let take
    upstream.addEventListener('message', event => { take ??= state.takes.at(-1); take?.nativeEvents.push(event.data); try { client.send(event.data) } catch {} })
    client.addEventListener('message', event => {
      take ??= state.takes.at(-1)
      if (take) {
        if (typeof event.data === 'string') { const control = JSON.parse(event.data); take.controls.push(control.type); if (control.type === 'finish') take.finishedBytes = take.bytes }
        else { const bytes = new Uint8Array(event.data); if (!take.firstFrame.length) take.firstFrame = Array.from(bytes); take.bytes += bytes.length; take.nonzero ||= bytes.some(byte => byte !== 0) }
      }
      try { upstream.send(event.data) } catch {}
    })
    client.addEventListener('close', () => { if (take) take.closed = true; try { upstream.close() } catch {} })
    upstream.addEventListener('close', () => { if (take) take.closed = true; try { client.close() } catch {} })
    return new Response(null, { status: 101, webSocket: pair[0] })
  }
  if (response.status !== 101 && response.headers.has('set-cookie')) { const headers = new Headers(response.headers); headers.set('set-cookie', headers.get('set-cookie').replace('; Secure', '')); return new Response(response.body, { status: response.status, headers }) }
  return response
} }

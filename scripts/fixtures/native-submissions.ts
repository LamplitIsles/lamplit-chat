// Test-only timing/fake external services around the production native host.
import worker from '../../src/server'
import { PiSession as NativeSession } from '../../src/server/pi-session'
export { PiRegistry } from '../../src/server/pi-registry'
import { PI_IMAGE_LIMITS } from '../../src/server/chat-images'
import { nativeReply } from '../../src/server/fixtures/native-provider'
export const state = { mode: 'submitted', hidden: false, executions: 0, submitCalls: 0, lookupCalls: 0, autoReply: false, acknowledgements: [], publications: [], modelResponses: [], requests: [], browserIds: new Set(), reply: () => '完整原生回复' }
globalThis.fetch = async (request, init) => {
  const url = request instanceof Request ? request.url : String(request)
  if (!url.startsWith('https://openrouter.ai/')) throw new Error('Native acceptance forbids external services')
  state.executions++
  state.requests.push(JSON.parse(String(init?.body)))
  const bytes = await nativeReply('openrouter', state.reply()).arrayBuffer()
  let finish
  const body = new ReadableStream({ start(controller) {
    finish = failed => { try { if (failed) controller.error(new Error('Test-owned reply failure')); else { controller.enqueue(new Uint8Array(bytes)); controller.close() } } catch {} }
    state.modelResponses.push(finish)
    if (state.autoReply) { state.modelResponses.pop(); finish(false) }
    init?.signal?.addEventListener('abort', () => { state.modelResponses = state.modelResponses.filter(item => item !== finish); try { controller.error(new DOMException('Aborted', 'AbortError')) } catch {} }, { once: true })
  } })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
export class PiSession extends NativeSession {
  scheduleMemoryExtraction() {}
  async validateChatInput(input) {
    if (state.mode === 'failed') throw new Error('Definite test-owned admission refusal')
    return super.validateChatInput(input)
  }
  async submitChat(input) {
    state.submitCalls++
    state.browserIds.add(input.operationId)
    const mode = state.mode
    if (mode === 'null') { await new Promise(resolve => state.acknowledgements.push(resolve)); throw new Error('Admission transport ended before execution') }
    if (mode === 'withdrawn') {
      // An actual native helper generation holds the user input in the queue.
      const holder = crypto.randomUUID()
      await this.native.submit('Test-owned queue holder', { operationId: holder })
      this.ctx.waitUntil(this.native.wait(holder))
      await this.waitForFixtureGeneration()
    }
    const receipt = await super.submitChat(input)
    if (mode === 'withdrawn' && receipt.state === 'submitted') await this.native.abort({ operationId: input.operationId })
    if (mode === 'slow' || mode === 'publishFirst') await new Promise(resolve => state.acknowledgements.push(resolve))
    if (mode === 'lost') throw new Error('Lost transport acknowledgement after native admission')
    return receipt
  }
  async waitForFixtureGeneration() {
    const deadline = Date.now() + 5000
    while (!state.modelResponses.length) {
      if (Date.now() >= deadline) throw new Error('Native fixture generation did not reach fake provider')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  async lookupChat(id) { state.lookupCalls++; return super.lookupChat(id) }
  async onConnect(connection, context) {
    const send = connection.send.bind(connection)
    const proxy = new Proxy(connection, { get(target, key) {
      if (key === 'send') return raw => { if (state.hidden && JSON.parse(String(raw)).type === 'update') state.publications.push(() => send(raw)); else send(raw) }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
    return super.onConnect(proxy, context)
  }
  async control(input) {
    if (input.action === 'reset') {
      for (const finish of state.modelResponses.splice(0)) finish()
      for (const release of state.acknowledgements.splice(0)) release()
      await this.native.abort()
      await (await this.getHarness()).waitForIdle(this.nativeContext)
      return {}
    }
    if (input.action === 'mode') { state.mode = input.state; state.hidden = !!input.hidden }
    if (input.action === 'release') for (const release of state.acknowledgements.splice(0)) release()
    if (input.action === 'publish') { state.hidden = false; for (const publish of state.publications.splice(0)) { try { publish() } catch {} } }
    if (input.action === 'replyFailure' || input.action === 'complete') {
      state.autoReply = input.action === 'complete'
      for (const finish of state.modelResponses.splice(0)) finish(input.action === 'replyFailure')
      await (await this.getHarness()).waitForIdle(this.nativeContext)
      state.autoReply = false
    }
    if (input.action === 'consume') {
      // A withdrawn queued submission is terminal. Consume recovery through a
      // fresh native replacement, just as a human-edited draft does.
      const operations = []
      const previousMode = state.mode; state.mode = 'submitted'
      state.autoReply = true
      for (const recovery of await this.chatRecovery()) {
        const operationId = crypto.randomUUID()
        await super.submitChat({ operationId, text: recovery.text || 'Test-owned edited recovery', replacementSourceIds: [recovery.sourceId] })
        operations.push(operationId)
      }
      for (const finish of state.modelResponses.splice(0)) finish()
      for (const operationId of operations) await this.native.wait(operationId)
      state.autoReply = false; state.mode = previousMode
    }
    const submissions = []
    for (const record of this.sessionStorage.chatRecords().values()) if (state.browserIds.has(record.operationId) && (await super.lookupChat(record.operationId))?.state === 'submitted') {
      const { operationId, text, images, replacementSourceIds } = record
      submissions.push({ operationId, text, ...(images ? { images } : {}), ...(replacementSourceIds ? { replacementSourceIds } : {}) })
    }
    return { executions: state.executions, submitCalls: state.submitCalls, lookupCalls: state.lookupCalls, submissions, recovery: await this.chatRecovery(), messages: (await this.getBranch()).entries, limits: PI_IMAGE_LIMITS, album: (await this.readPanelAlbum(null)).images, modelRequests: state.requests }
  }
}
let sessionId
export default { async fetch(request, env) {
  if (['/__test/submissions', '/__test/image-send-recovery'].includes(new URL(request.url).pathname)) {
    const input = await request.json()
    if (input.action === 'reset') {
      if (sessionId) await env.PiSession.getByName(sessionId).control(input)
      sessionId = crypto.randomUUID()
      Object.assign(state, { mode: 'submitted', hidden: false, executions: 0, submitCalls: 0, lookupCalls: 0, autoReply: false, acknowledgements: [], publications: [], modelResponses: [], requests: [], browserIds: new Set(), reply: () => '完整原生回复' })
      await env.PiSession.getByName(sessionId).initialize({ id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
    }
    return Response.json(await env.PiSession.getByName(sessionId).control(input))
  }
  return worker.fetch(request, { ...env, COMPANION_SESSION_ID: sessionId })
} }

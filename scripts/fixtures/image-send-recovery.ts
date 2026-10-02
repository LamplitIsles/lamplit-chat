// Test infrastructure only. The production entry never imports this module.
import worker from '../../src/server'
import { PiSession as NativeSession } from '../../src/server/pi-session'
export { PiRegistry } from '../../src/server/pi-registry'
import { PiSessionStorage } from '../../src/server/pi-session-storage'
import { PI_IMAGE_LIMITS } from '../../src/server/chat-images'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/pi-agent-core/harness/context'
import { insertEntry, branchTip, laneState, setValue } from '@earendil-works/pi-agent-core/harness/session'

const jpeg = btoa(String.fromCharCode(255, 216, 255, 217))
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
export const fixture = { regressions: false, mode: 'consumed', hold: true, disabled: false, uploadFailure: false, modelCalls: 0, requests: [], uploads: [], runs: [], releases: [], voiceCalls: 0, frames: 0, bytes: 0, closes: 0, enabled: true, text: 'recognized final', status: 200 }
const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'native-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}), choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url.startsWith('https://example.invalid/')) {
    fixture.modelCalls++
    fixture.requests.push(JSON.parse(String(init?.body ?? '{}')))
    const reply = fixture.regressions ? 'Complete Pi reply' : fixture.modelCalls === 1 ? '完整图片回复' : '追加图片回复'
    const body = new ReadableStream({ start(controller) {
      const finish = () => { if (fixture.compactionFailure) { controller.error(new Error('Synthetic native summary failure')); return } controller.enqueue(new TextEncoder().encode(chunk({ role: 'assistant', content: reply }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n')); controller.close() }
      if (fixture.hold) fixture.releases.push(finish); else finish()
    } })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  if (url !== 'https://dashscope.aliyuncs.com/api-ws/v1/inference') throw new Error('Fixture forbids external providers')
  fixture.voiceCalls++
  if (fixture.status !== 200) return new Response('Synthetic voice failure', { status: fixture.status })
  const pair = new WebSocketPair(), socket = pair[1]; socket.binaryType = 'arraybuffer'; socket.accept()
  let taskId
  const send = (event, payload = {}) => socket.send(JSON.stringify({ header: { event, task_id: taskId }, payload }))
  socket.addEventListener('close', () => fixture.closes++)
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') { fixture.frames++; fixture.bytes += event.data.byteLength; return }
    const command = JSON.parse(event.data); taskId = command.header.task_id
    if (command.header.action === 'run-task') send('task-started')
    if (command.header.action === 'finish-task') { send('result-generated', { output: { sentence: { sentence_id: 1, sentence_end: true, text: fixture.text } } }); send('task-finished') }
  })
  return new Response(null, { status: 101, webSocket: pair[0] })
}
export class PiSession extends NativeSession {
  fixtureBucket
  // Native storage and harness are retained. Only fake execution/failure scheduling differs.
  async prompt(stream, input) {
    if (fixture.mode === 'rejected') throw new Error('Synthetic pre-admission rejection')
    if (fixture.mode === 'uncertain') {
      const storage = new PiSessionStorage(this.ctx.storage)
      storage.saveInput(input.operationId, input.prompt, input.photoIds ?? [], 'prompt')
      storage.admitPromptSubmission(input.operationId, 'synthetic ambiguous admission', input.photoIds ?? [])
      throw new Error('Synthetic ambiguous native admission')
    }
    return super.prompt(stream, input)
  }
  async submitSteer(input) {
    if (fixture.mode === 'rejected') throw new Error('Synthetic pre-admission rejection')
    const result = await super.submitSteer(input)
    if (fixture.mode === 'unconsumed' && 'entryId' in result) {
      const cancel = await (await this.getLane()).cancelQueued(result.entryId, context)
      if (!cancel.ok || cancel.value.kind !== 'cancelled') throw new Error('Native cancellation did not prove non-consumption')
    }
    return result
  }
  async uploadPhoto(input) {
    if (fixture.uploadFailure) throw new Error('Synthetic R2 write failure')
    const result = await super.uploadPhoto(input)
    if (!fixture.uploads.some(upload => upload.id === input.id)) fixture.uploads.push(input)
    return result
  }
  scheduleMemoryExtraction() {} // Never invoke a second provider/task.
  async schedulePendingDrain() {} // Controls drive the real lane explicitly.
  async summary() {
    const storage = new PiSessionStorage(this.ctx.storage)
    const view = await this.getBranch()
    return { executions: fixture.modelCalls, submissions: [...storage.chatRecords().values()].filter(input => storage.inputEntry(input.operationId)).map(({ kind, turnId, rejected, ...input }) => input), recovery: await this.chatRecovery(), messages: view.entries, limits: PI_IMAGE_LIMITS, album: (await this.readPanelAlbum(null)).images, modelRequests: fixture.requests, uploads: fixture.uploads, runs: fixture.runs }
  }
  async control(input) {
    const storage = this.sessionStorage
    const lane = await this.getLane()
    if (input.action === 'reset') {
      fixture.hold = false; for (const finish of fixture.releases.splice(0)) finish()
      const active = storage.getValueSync(laneState('main'))?.value?.currentOperationId
      if (active) { await lane.requestAbort(active, context); await lane.drive({ operationId: active }, context) }
      // New native session per reset is selected by the outer worker.
    }
    if (input.action === 'mode') {
      fixture.mode = input.state; fixture.hold = false
      for (const finish of fixture.releases.splice(0)) finish()
      if (input.state === 'unconsumed') await this.holdNativeTurn()
      else { const active = storage.getValueSync(laneState('main'))?.value?.currentOperationId; if (active) { await lane.requestAbort(active, context); await lane.drive({ operationId: active }, context) } }
    }
    if (input.action === 'complete') {
      fixture.hold = false
      for (const finish of fixture.releases.splice(0)) finish()
      await this.waitForIdle()
      const id = crypto.randomUUID(), operationId = crypto.randomUUID()
      await this.uploadPhoto({ id, operationId, order: 0, name: 'generated.png', mediaType: 'image/png', original: png, preview: jpeg, model: jpeg })
      const entry = await this.session.appendToBranch('main', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '生成的图片' }, { type: 'image', data: png, mimeType: 'image/png' }], api: 'openai-completions', provider: 'fixture', model: 'fixture-model', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } }, context)
      storage.admitPromptSubmission(operationId, 'fixture generated image', [id]); storage.acceptPromptSubmission(operationId, entry)
    }
    if (input.action === 'history') {
      for (let i = 0; i < 32; i++) await this.session.appendToBranch('main', { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `历史回复 ${i}` }], api: 'openai-completions', provider: 'fixture', model: 'fixture-model', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } }, context)
    }
    if (input.action === 'nativeRecovery') {
      await this.holdNativeTurn()
      const operationId = crypto.randomUUID(), id = crypto.randomUUID()
      await this.uploadPhoto({ id, operationId, order: 0, name: 'native.png', mediaType: 'image/png', original: png, preview: jpeg, model: jpeg })
      const admitted = await super.submitSteer({ submissionId: operationId, prompt: '原生恢复输入', photoIds: [id] })
      if (!('entryId' in admitted)) throw new Error('Native input not accepted')
      const canceled = await lane.cancelQueued(admitted.entryId, context)
      if (!canceled.ok || canceled.value.kind !== 'cancelled') throw new Error('Native recovery was not canceled')
      const active = storage.getValueSync(laneState('main'))?.value?.currentOperationId
      if (active) { await lane.requestAbort(active, context); await lane.drive({ operationId: active }, context) }
    }
    if (input.action === 'regressions') {
      fixture.regressions = true; fixture.hold = false; fixture.mode = 'consumed'
      await this.workspace.mkdir('/workspace/memory', { recursive: true })
      await this.workspace.writeFile('/workspace/memory/2026-10-02.md', '# Fixture diary\n\n原生日记回归内容。')
      await this.saveTimedWake({ title: 'Fixture reminder', reminder: '原生提醒回归内容', plan: { type: 'once', at: new Date(Date.now() + 3_600_000).toISOString() } })
    }
    if (input.action === 'missing') for (const recovery of await this.chatRecovery()) for (const image of recovery.images) await this.env.COMPUTER_R2.delete(this.photoKey(image.attachmentId, 'original'))
    if (input.action === 'consume') {
      fixture.hold = false; for (const finish of fixture.releases.splice(0)) finish()
      const active = storage.getValueSync(laneState('main'))?.value?.currentOperationId
      if (active) { await lane.requestAbort(active, context); await lane.drive({ operationId: active }, context) }
      for (const recovery of await this.chatRecovery()) {
        const entryId = storage.inputEntry(recovery.operationId) ?? crypto.randomUUID()
        const photos = storage.photosForOperation(recovery.operationId)
        const models = await this.modelPhotos(recovery.operationId, photos.map(photo => photo.id))
        const message = { role: 'user', content: [...(recovery.text ? [{ type: 'text', text: recovery.text }] : []), ...models], timestamp: Date.now() }
        await storage.commit([insertEntry({ id: entryId, type: 'message', parentId: storage.getLeafId(), timestamp: Date.now(), message }), setValue(branchTip('main'), entryId)], context)
        const record = storage.chatRecords().get(recovery.operationId)
        if (record?.rejected) storage.setChatRejected(recovery.operationId, false)
        if (!storage.inputEntry(recovery.operationId)) { if (!storage.getPromptSubmission(recovery.operationId)) storage.admitPromptSubmission(recovery.operationId, 'fixture confirmed consumption', photos.map(photo => photo.id)); storage.acceptPromptSubmission(recovery.operationId, entryId) }
      }
    }
    if (input.action === 'disabled') { fixture.disabled = input.enabled; this.fixtureBucket ??= this.env.COMPUTER_R2; this.env.COMPUTER_R2 = input.enabled ? undefined : this.fixtureBucket }
    if (input.action === 'uploadFailure') fixture.uploadFailure = input.enabled
    return this.summary()
  }
  async holdNativeTurn() {
    const active = this.sessionStorage.getValueSync(laneState('main'))?.value?.currentOperationId
    if (!active) { const result = await (await this.getLane()).accept({ kind: 'prompt', operationId: crypto.randomUUID(), prompt: 'fixture holding native turn' }, context); if (!result.ok) throw result.error }
  }
  async waitForIdle() {
    for (let i = 0; i < 200; i++) { if (!this.sessionStorage.getValueSync(laneState('main'))?.value?.currentOperationId) return; await new Promise(resolve => setTimeout(resolve, 25)) }
    throw new Error('Fake native turn did not settle')
  }
}
let sessionId
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname
  if (path === '/__test/image-send-recovery') {
    const input = await request.json()
    if (input.action === 'reset') {
      if (sessionId) { const { runs, ...previous } = await env.PiSession.getByName(sessionId).summary(); fixture.runs.push(previous); await env.PiSession.getByName(sessionId).control(input) }
      sessionId = crypto.randomUUID()
      await env.PiSession.getByName(sessionId).initialize({ id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
      Object.assign(fixture, { regressions: false, mode: 'consumed', hold: true, disabled: false, uploadFailure: false, modelCalls: 0, requests: [], uploads: [], releases: [] })
      return Response.json(await env.PiSession.getByName(sessionId).summary())
    }
    if (input.action === 'regressions') await env.PiRegistry.getByName('singleton').updateRelationship({ mood: { value: 'neutral', note: 'Fixture mood', reason: 'Fixture' }, signature: { value: '原生关系回归内容', reason: 'Fixture' }, affinity: { delta: 1, reason: 'Fixture' } })
    return Response.json(await env.PiSession.getByName(sessionId).control(input))
  }
  if (path === '/__fixture/state') { if (request.method === 'POST') Object.assign(fixture, await request.json()); return Response.json({ ...fixture, calls: fixture.voiceCalls }) }
  if (!sessionId) throw new Error('Reset fixture before browser acceptance')
  const response = await worker.fetch(request, { ...env, COMPANION_SESSION_ID: sessionId, COMPUTER_R2: fixture.disabled ? undefined : env.COMPUTER_R2, VOICE_API_KEY: fixture.enabled ? env.VOICE_API_KEY : '' })
  // Local HTTP fixture only: retain native authenticated cookie without its HTTPS transport flag.
  if (response.status !== 101 && response.headers.has('set-cookie')) { const headers = new Headers(response.headers); headers.set('set-cookie', headers.get('set-cookie').replace('; Secure', '')); return new Response(response.body, { status: response.status, headers }) }
  return response
} }

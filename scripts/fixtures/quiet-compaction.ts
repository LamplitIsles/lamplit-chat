// Isolated test entry only: real PiSession, native harness, SQLite and R2.
import worker from '../../src/server'
import { PiSession as ImageSession, fixture } from './image-send-recovery'
export { PiRegistry } from '../../src/server/pi-registry'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/pi-agent-core/harness/context'
import { laneState } from '@earendil-works/pi-agent-core/harness/session'

export class PiSession extends ImageSession {
  get quietSettings() { return this.sessionStorage.getSetting('fixtureQuiet') ?? { calls: 0, executions: 0, refuseCompact: false, holdReply: false, capacity: null, events: [] } }
  save(value) { this.sessionStorage.setSetting('fixtureQuiet', { ...this.quietSettings, ...value }) }
  get calls() { return this.quietSettings.calls }
  set calls(value) { this.save({ calls: value }) }
  get executions() { return this.quietSettings.executions }
  set executions(value) { this.save({ executions: value }) }
  get refuseCompact() { return this.quietSettings.refuseCompact }
  set refuseCompact(value) { this.save({ refuseCompact: value }) }
  get holdReply() { return this.quietSettings.holdReply }
  set holdReply(value) { this.save({ holdReply: value }) }
  async getHarness() {
    const harness = await super.getHarness()
    const model = harness.models.getModel('configured-provider', 'fixture-model')
    if (model) model.contextWindow = this.quietSettings.capacity === null ? NaN : this.quietSettings.capacity
    return harness
  }
  async runCompact(lane, focus) {
    fixture.hold = true
    return super.runCompact(lane, focus)
  }
  releaseReply
  observedHarness
  async prepare() {
    const harness = await this.getHarness()
    if (this.observedHarness !== harness) {
      this.observedHarness = harness
      for (const type of ['compaction_start', 'compaction_end']) harness.events.on(type, event => {
        this.save({ events: [...this.quietSettings.events, event] })
        if (type === 'compaction_start') this.executions++
      })
    }
    return this.getLane()
  }
  async compactChat(input) {
    this.calls++
    const saved = this.active
    if (this.refuseCompact) this.active = true
    let result
    try { result = await super.compactChat(input) } finally { if (this.refuseCompact) this.active = saved }
    if (result.accepted && this.holdReply) await new Promise(resolve => { this.releaseReply = resolve })
    return result
  }
  async seedUsage(tokens, capacity) {
    const lane = await this.prepare()
    // Fake selected-model metadata and a real native assistant entry, never a DTO override.
    const model = await lane.getModel(context)
    this.save({ capacity })
    model.contextWindow = capacity === null ? NaN : capacity
    await (await this.getLane()).appendMessage( { role: 'assistant', content: [{ type: 'text', text: 'Native observation' }], api: 'openai-completions', provider: model.provider, model: model.id, usage: { input: tokens === null ? -1 : tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens === null ? -1 : tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() }, context)
  }
  async quietState() {
    return { sessionId: this.sessionStorage.getMetadataSync().id, ...await this.chatObservation(), calls: this.calls, executions: this.executions, submissions: [...this.sessionStorage.chatRecords().values()], native: { events: this.quietSettings.events, entries: (await this.getBranch()).entries, modelCalls: fixture.modelCalls, requests: fixture.requests, active: this.active, lane: this.sessionStorage.getValueSync(laneState('main'))?.value } }
  }
  async settle(failed = false) {
    fixture.compactionFailure = failed
    for (const release of fixture.releases.splice(0)) release()
    // Automatic continuation is also native. Release its fake provider response.
    for (let i = 0; i < 300; i++) {
      for (const release of fixture.releases.splice(0)) release()
      if (!this.active && !this.sessionStorage.getValueSync(laneState('main'))?.value?.currentOperationId) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Native operation did not settle')
  }
  async quietControl(input) {
    const lane = await this.prepare()
    if (input.action === 'reset' || input.action === 'session') {
      const evidence = await this.ctx.storage.get('quietEvidence') ?? []
      evidence.push(await this.quietState()); await this.ctx.storage.put('quietEvidence', evidence)
      fixture.compactionFailure = false
      for (const release of fixture.releases.splice(0)) release()
      const active = this.sessionStorage.getValueSync(laneState('main'))?.value?.currentOperationId
      if (active) { await lane.requestAbort(active, context); await lane.drive({ operationId: active }, context) }
      await this.settle()
      const metadata = { id: input.sessionId ?? 'fixture-session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } }
      await this.importSession({ metadata, entries: [], compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, files: [] })
      this.calls = 0; this.executions = 0; this.refuseCompact = false
      fixture.hold = true; fixture.compactionFailure = false; fixture.modelCalls = 0; fixture.requests = []
      await this.prepare()
      await (await this.getLane()).appendMessage( { role: 'user', content: 'Test-owned native conversation', timestamp: Date.now() }, context)
      await this.seedUsage(null, null)
    }
    if (input.action === 'usage') await this.seedUsage(input.tokens, input.capacity)
    if (input.action === 'busy') {
      if (input.enabled) await this.holdNativeTurn()
      else { const active = this.sessionStorage.getValueSync(laneState('main'))?.value?.currentOperationId; if (active) { await lane.requestAbort(active, context); await lane.drive({ operationId: active }, context) } }
    }
    if (input.action === 'refuse') this.refuseCompact = input.enabled
    if (input.action === 'hold') {
      this.holdReply = input.enabled
      // Pi refuses an already compacted tip. Seed a new native context entry for
      // the runner's next deliberate held operation; never fabricate admission.
      if (input.enabled && this.sessionStorage.getEntrySync(this.sessionStorage.getLeafId())?.type === 'compaction') await lane.appendMessage({ role: 'user', content: 'Next test-owned native context', timestamp: Date.now() }, context)
    }
    if (input.action === 'release') { this.holdReply = false; this.releaseReply?.(); this.releaseReply = undefined }
    if (input.action === 'auto') {
      fixture.compactionFailure = false; fixture.hold = true
      const model = await lane.getModel(context)
      await this.seedUsage(model.contextWindow - 1, model.contextWindow)
      this.ctx.waitUntil(lane.prompt('native automatic threshold trigger', undefined, context).then(result => { if (!result.ok) throw result.error }))
      for (let i = 0; i < 100 && this.sessionStorage.getSetting('chatCompaction')?.status !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (input.action === 'finish') await this.settle(input.failed)
    if (input.action === 'disconnect') for (const connection of this.getConnections()) connection.close(1012, 'Test-owned socket loss')
    if (this.chatHost) await (await this.chatHost).refresh()
    return { ...await this.quietState(), evidence: await this.ctx.storage.get('quietEvidence') }
  }
}
const nativeSession = 'quiet-compaction-native'
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname
  const stub = env.PiSession.getByName(nativeSession)
  if (path === '/__test/quiet-compaction' || path === '/__test/quiet-compaction/disconnect') {
    if (path.endsWith('/disconnect')) { await stub.quietControl({ action: 'disconnect' }); return Response.json({ disconnected: true }) }
    const input = await request.json()
    if (input.action === 'reset') await stub.initialize({ id: 'fixture-session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
    return Response.json(await stub.quietControl(input))
  }
  const response = await worker.fetch(request, { ...env, COMPANION_SESSION_ID: nativeSession })
  if (response.status !== 101 && response.headers.has('set-cookie')) { const headers = new Headers(response.headers); headers.set('set-cookie', headers.get('set-cookie').replace('; Secure', '')); return new Response(response.body, { status: response.status, headers }) }
  return response
} }

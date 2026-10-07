// Test-owned actual workerd. Native ingress, public Pi lane, SQLite and shared socket remain real.
import worker from '../../src/server'
import { PiSession as NativeSession } from '../../src/server/pi-session'
import { PiRegistry as NativeRegistry } from '../../src/server/pi-registry'
import { nativeReply } from '../../src/server/fixtures/native-provider'
const fixture = { releases: [], requests: [] }
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (!url.startsWith('https://openrouter.ai/')) throw new Error('Keet fixture forbids all external services')
  const request = JSON.parse(String(init?.body)); fixture.requests.push(request)
  const last = request.messages.filter(message => message.role === 'user').at(-1)
  if (!JSON.stringify(last).includes('普通网页消息')) return nativeReply('openrouter', 'Fictional Keet reply')
  const reply = nativeReply('openrouter', '普通回复')
  const body = new ReadableStream({ start(controller) {
    fixture.releases.push(async () => { controller.enqueue(new Uint8Array(await reply.arrayBuffer())); controller.close() })
  } })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
export class PiSession extends NativeSession {
  scheduleMemoryExtraction() {} // Disable unrelated background model work in this fixture only.
  async settleView() {
    if (this.chatHost) await (await this.chatHost).refresh()
  }
  async finishWeb() {
    for (const release of fixture.releases.splice(0)) await release()
    for (let n = 0; n < 400; n++) {
      if (!(await this.native.pending()).length) { await this.settleView(); return }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Fake native web turn did not settle')
  }
  async seedHistoryPadding() {
    // Ordinary native entries put the already ingress-admitted historical Keet item outside page one.
    // No shared DTO, source row or private prompt is fabricated.
    for (let n = 0; n < 16; n++) { const operationId = crypto.randomUUID(); await this.submitChat({ operationId, text: `Fictional older web history ${n}` }); await this.native.wait(operationId) }
  }
  async publishReminder() {
    const at = new Date(Date.now() + 10).toISOString()
    const wake = await this.saveTimedWake({ title: 'Fixture reminder', reminder: 'Native reminder input', plan: { type: 'once', at } })
    await new Promise(resolve => setTimeout(resolve, 20))
    await this.acceptTimedWake({ wakeId: wake.id, revision: wake.revision, scheduledAt: wake.nextAt, title: wake.title, reminder: wake.reminder })
    await this.drainPendingWork(); await this.finishWeb(); await this.settleView()
  }
  async nativeImageNote(sequence, original) {
    await this.getBranch()
    const entry = this.sessionStorage.entriesInOrder().find(entry => this.sessionStorage.keetSource(entry.id)?.messageId.seq === sequence)
    if (!entry) throw new Error('Missing ingress-admitted native source')
    const text = this.sessionStorage.keetSource(entry.id).text
    if (!text.startsWith(original)) throw new Error('Native original text changed')
    return text.slice(original.length).trim()
  }
  async fixtureState() {
    return { submissions: [...this.sessionStorage.chatRecords().values()].filter(input => !input.text.startsWith('Fictional older web history')).map(input => input.text), requests: fixture.requests,
      branch: await this.getBranch() }
  }
  async disconnectFixture() { for (const connection of this.getConnections()) connection.close(1012, 'Owned fixture reconnect'); return { disconnected: true } }
}
export class PiRegistry extends NativeRegistry {
  async fixtureSelection(id) {
    if (id) await this.ctx.storage.put('ownedKeetFixtureSession', id)
    return this.ctx.storage.get('ownedKeetFixtureSession')
  }
}
let sessionId
let sequence = 0
const events = new Map()
async function incoming(input, env) {
  const stub = env.PiSession.getByName(sessionId)
  let event = events.get(input.id)
  if (!event) {
    // Native private attribution/reaction context proves the real provider projection stays private.
    event = { type: 'message', eventId: crypto.randomUUID(), sequence: ++sequence,
      messageId: { deviceId: 'fictional-native-peer', seq: sequence }, timestamp: Date.now(),
      destination: { kind: input.channel, groupName: input.destination }, senderLabel: input.senderLabel, text: input.text,
      trigger: input.channel === 'dm' ? 'dm' : 'mention',
      reactionContext: [{ targetMessageId: { deviceId: 'fictional-native-peer', seq: 0 }, targetText: 'native-only context sentinel', emoji: '❤️', externalCount: 1 }],
      ...(input.hasImage ? { images: [{ status: 'unavailable', mediaType: 'image/png', name: 'keet-original.png' }] } : {}) }
    events.set(input.id, event)
  }
  const response = await worker.fetch(new Request('http://127.0.0.1/api/keet/events', { method: 'POST', headers: { authorization: 'Bearer fixture-ingest' }, body: JSON.stringify(event) }), { ...env, COMPANION_SESSION_ID: sessionId })
  if (!response.ok) throw new Error(`Native ingress failed: ${response.status} ${await response.text()}`)
  await stub.drainPendingWork(); await stub.settleView()
  if (input.id.startsWith('older-')) await stub.finishWeb()
  return input.hasImage ? { imageNote: await stub.nativeImageNote(event.sequence, event.text) } : {}
}
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname
  sessionId ??= await env.PiRegistry.getByName('singleton').fixtureSelection()
  if (path === '/__test/keet-source-restoration/disconnect') return Response.json(await env.PiSession.getByName(sessionId).disconnectFixture())
  if (path === '/__test/keet-source-restoration') {
    const input = await request.json()
    if (input.action === 'reset') {
      if (sessionId) await env.PiSession.getByName(sessionId).finishWeb()
      sessionId = (await env.PiRegistry.getByName('singleton').createSession({ name: 'Fictional native Keet fixture' })).id
      await env.PiRegistry.getByName('singleton').fixtureSelection(sessionId)
      events.clear(); sequence = 0; fixture.requests.length = 0
      // Seed the historical input through the same real webhook before the current turn.
      // The runner's later history control replays the identical event, testing native idempotency.
      await incoming({ id: 'older-group', channel: 'group', senderLabel: 'Alice', destination: 'Room', text: '历史群组原文', hasImage: true }, env)
      await incoming({ id: 'older-dm', channel: 'dm', senderLabel: 'Alice', destination: 'Peer', text: '历史私聊原文', hasImage: true }, env)
      await env.PiSession.getByName(sessionId).seedHistoryPadding()
    }
    const stub = env.PiSession.getByName(sessionId)
    let result = {}
    if (input.action === 'incoming') result = await incoming(input, env)
    if (input.action === 'complete') await stub.finishWeb()
    if (input.action === 'reminder') await stub.publishReminder()
    return Response.json({ ...await stub.fixtureState(), ...result })
  }
  if (!sessionId) return new Response('Reset owned fixture first', { status: 503 })
  // Bootstrap the owned browser with the real native Basic -> cookie path.
  // Other native routes keep their actual cookie/bearer checks; no production entry imports this fixture.
  if ((path === '/' || path === '/chat') && !request.headers.has('authorization')) {
    const headers = new Headers(request.headers); headers.set('authorization', `Basic ${btoa('owner:' + env.AUTH_PASSWORD)}`)
    request = new Request(request, { headers })
  }
  const response = await worker.fetch(request, { ...env, COMPANION_SESSION_ID: sessionId })
  if (response.status !== 101 && response.headers.has('set-cookie')) {
    const headers = new Headers(response.headers); headers.set('set-cookie', headers.get('set-cookie').replace('; Secure', ''))
    return new Response(response.body, { status: response.status, headers })
  }
  return response
} }

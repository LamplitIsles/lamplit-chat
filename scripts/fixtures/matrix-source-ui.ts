// Test-owned workerd controls around the real Worker, Pi lane, SQLite and public socket.
import worker from '../../src/server'
import { PiSession as NativeSession } from '../../src/server/pi-session'
import { PiRegistry as NativeRegistry } from '../../src/server/pi-registry'
import { appendNative } from '../../src/server/fixtures/native-session'
import { nativeReply } from '../../src/server/fixtures/native-provider'
const fixture = { releases: [], requests: [] }
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (!url.startsWith('https://openrouter.ai/')) throw new Error('Matrix fixture forbids external services')
  const request = JSON.parse(String(init?.body)); fixture.requests.push(request)
  // Background extraction stays scheduled and consumes only this test-owned fake.
  if (JSON.stringify(request.messages).includes('Extract only durable user preferences')) return nativeReply('openrouter', '', { name: 'record_memory_changes', arguments: { operations: [] } })
  const last = request.messages.filter(message => message.role === 'user').at(-1)
  if (!JSON.stringify(last).includes('普通网页消息')) return nativeReply('openrouter', 'Fictional Matrix reply')
  const reply = nativeReply('openrouter', '普通回复')
  return new Response(new ReadableStream({ start(controller) {
    fixture.releases.push(async () => { controller.enqueue(new Uint8Array(await reply.arrayBuffer())); controller.close() })
  } }), { headers: { 'content-type': 'text/event-stream' } })
}
export class PiSession extends NativeSession {
  async settleView() { if (this.chatHost) await (await this.chatHost).refresh() }
  async finishWeb() {
    for (let n = 0; n < 400; n++) {
      for (const release of fixture.releases.splice(0)) await release()
      if (!(await this.native.pending()).length) { await this.settleView(); return }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Native fake-provider turn did not settle')
  }
  async settleIncoming() {
    // Do not replace/suppress scheduling. Await the ingress operation admitted by production.
    for (let n = 0; n < 400; n++) {
      const next = this.sessionStorage.nextKeet()
      if (!next) { await this.finishWeb(); return }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Native ingress did not settle')
  }
  async seedHistoryPadding(createdAt) {
    const lane = await this.getLane()
    // Real persisted native history between the old Matrix event and the recent page.
    for (let n = 0; n < 30; n++) await appendNative(lane, { role: 'user', content: `Fictional older history ${n}`, timestamp: createdAt + 1000 + n }, this.nativeContext)
    await this.settleView()
  }
  async publishReminder() {
    const wake = await this.saveTimedWake({ title: 'Fixture reminder', reminder: 'Native reminder input', plan: { type: 'once', at: new Date(Date.now() + 10).toISOString() } })
    await new Promise(resolve => setTimeout(resolve, 20))
    await this.acceptTimedWake({ wakeId: wake.id, revision: wake.revision, scheduledAt: wake.nextAt, title: wake.title, reminder: wake.reminder })
    await this.finishWeb()
  }
  async fixtureState() {
    return { submissions: [...this.sessionStorage.chatRecords().values()].map(record => record.text), requests: fixture.requests, branch: await this.getBranch() }
  }
  async disconnectFixture() { for (const connection of this.getConnections()) connection.close(1012, 'Owned fixture reconnect'); return { disconnected: true } }
}
export class PiRegistry extends NativeRegistry {
  async fixtureSelection(id) {
    if (id) await this.ctx.storage.put('ownedMatrixFixtureSession', id)
    return this.ctx.storage.get('ownedMatrixFixtureSession')
  }
}
let sessionId
async function incoming(input, env) {
  const send = async event => {
    const response = await worker.fetch(new Request('http://127.0.0.1/api/matrix/events', { method: 'POST', headers: { authorization: 'Bearer fixture-matrix-token' }, body: JSON.stringify(event) }), { ...env, COMPANION_SESSION_ID: sessionId })
    if (!response.ok) throw new Error(`Native Matrix ingress failed: ${response.status} ${await response.text()}`)
  }
  const event = { type: 'message', room_id: input.roomId, event_id: `$fixture-${input.id}`, sender_id: input.senderId, sender_display_name: input.senderDisplayName, body: input.text, mentions: ['@self:example.test'], timestamp: input.createdAt, truncated: false }
  await send({ ...event, event_id: `${event.event_id}-context`, body: 'native-only context sentinel', mentions: [] })
  await send(event)
  const stub = env.PiSession.getByName(sessionId)
  await stub.settleIncoming()
  if (input.history) await stub.seedHistoryPadding(input.createdAt)
}
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname
  sessionId ??= await env.PiRegistry.getByName('singleton').fixtureSelection()
  if (path === '/__test/matrix-source-ui/disconnect') return Response.json(await env.PiSession.getByName(sessionId).disconnectFixture())
  if (path === '/__test/matrix-source-ui') {
    const input = await request.json()
    if (input.action === 'reset') {
      if (sessionId) await env.PiSession.getByName(sessionId).finishWeb()
      sessionId = (await env.PiRegistry.getByName('singleton').createSession({ name: 'Fictional native Matrix fixture' })).id
      await env.PiRegistry.getByName('singleton').fixtureSelection(sessionId)
      fixture.requests.length = 0
    }
    const stub = env.PiSession.getByName(sessionId)
    if (input.action === 'incoming') await incoming(input, env)
    else if (input.action === 'complete') await stub.finishWeb()
    else if (input.action === 'reminder') await stub.publishReminder()
    else if (!['reset', 'state'].includes(input.action)) throw new Error('Unknown Matrix fixture control')
    return Response.json(await stub.fixtureState())
  }
  if (!sessionId) return new Response('Reset owned fixture first', { status: 503 })
  // Exercise native Basic-to-cookie bootstrap; subsequent native socket auth stays real.
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

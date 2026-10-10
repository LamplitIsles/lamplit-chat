// Test-owned native tasks, model metadata and provider timing; no public DTO override.
import worker from '../../src/server'
import { PiSession as NativeSession } from '../../src/server/pi-session'
export { PiRegistry } from '../../src/server/pi-registry'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { appendNative, selectedNativeModel } from '../../src/server/fixtures/native-session'
import { nativeReply } from '../../src/server/fixtures/native-provider'
const fixture = { releases: [], failed: false, autoReply: false, executions: 0, requests: [] }
globalThis.fetch = async (input, init) => {
  if (!String(input instanceof Request ? input.url : input).startsWith('https://openrouter.ai/')) throw new Error('Native compact fixture forbids external services')
  fixture.executions++; fixture.requests.push(JSON.parse(String(init?.body)))
  const bytes = await nativeReply('openrouter', 'Test-owned continuity checkpoint').arrayBuffer()
  let finish
  return new Response(new ReadableStream({ start(controller) {
    finish = () => { try { if (fixture.failed) controller.error(new Error('Test-owned compaction failure')); else { controller.enqueue(new Uint8Array(bytes)); controller.close() } } catch {} }
    fixture.releases.push(finish)
    if (fixture.autoReply) { fixture.releases.pop(); finish() }
    init?.signal?.addEventListener('abort', () => { fixture.releases = fixture.releases.filter(f => f !== finish); try { controller.error(new DOMException('Aborted','AbortError')) } catch {} }, {once:true})
  }}), {headers:{'content-type':'text/event-stream'}})
}
export class PiSession extends NativeSession {
  calls = 0; refuse = false; held = false; releaseReply
  scheduleMemoryExtraction() {}
  async compactChat(input) {
    this.calls++
    if (this.refuse) { // Refusal uses the production native-busy guard.
      const previous = this.active; this.active = true
      try { return await super.compactChat(input) } finally { this.active = previous }
    }
    const result = await super.compactChat(input)
    if (result.accepted && this.held) await new Promise(resolve => { this.releaseReply = resolve })
    return result
  }
  async seedUsage(tokens, capacity) {
    const lane = await this.getLane(), model = await selectedNativeModel(lane, this.nativeContext)
    model.contextWindow = capacity ?? NaN
    await appendNative(lane, {role:'user',content:'Test-owned retained context '+ 'x'.repeat(4000),timestamp:Date.now()},this.nativeContext)
    const message = fauxAssistantMessage('Native usage observation')
    await appendNative(lane,{...message, provider:model.provider,model:model.id, usage:{...message.usage,input:tokens ?? -1,output:0,cacheRead:0,cacheWrite:0,totalTokens:tokens ?? -1}},this.nativeContext)
  }
  async settle(failed = false) {
    fixture.failed = failed; fixture.autoReply = true
    for (const release of fixture.releases.splice(0)) release()
    await (await this.getHarness()).waitForIdle(this.nativeContext)
    fixture.autoReply = false; fixture.failed = false
    await this.maintainNativeWork()
  }
  async quietControl(input) {
    if (input.action === 'cleanup') { await this.native.abort(); await this.settle(); return {} }
    if (input.action === 'reset') {
      this.calls = 0; fixture.executions = 0; fixture.requests = []
      await this.updateCompactionSettings({enabled:true,reserveTokens:1000,keepRecentTokens:100})
      await this.seedUsage(null,null)
    }
    if (input.action === 'usage') await this.seedUsage(input.tokens,input.capacity)
    if (input.action === 'busy') {
      if (input.enabled) { const id=crypto.randomUUID(); await this.native.submit('Test-owned busy generation',{operationId:id}); this.ctx.waitUntil(this.native.wait(id)) }
      else { await this.native.abort(); await this.settle(); fixture.executions = 0 }
    }
    if (input.action === 'refuse') this.refuse = input.enabled
    if (input.action === 'hold') { this.held = input.enabled; if(input.enabled) await this.seedUsage(12000,100000) }
    if (input.action === 'release') { this.held = false; this.releaseReply?.(); this.releaseReply = undefined }
    if (input.action === 'auto') {
      await this.seedUsage(99999,100000)
      const operationId=crypto.randomUUID(); await this.native.submit('Native threshold trigger',{operationId}); this.ctx.waitUntil(this.native.wait(operationId))
    }
    if (input.action === 'finish') await this.settle(input.failed)
    if (input.action === 'disconnect') for (const connection of this.getConnections()) connection.close(1012,'Test-owned disconnect')
    if(this.chatHost) await (await this.chatHost).refresh()
    return {...await this.chatObservation(), calls:this.calls, executions:fixture.executions, submissions:await Promise.all([...this.sessionStorage.chatRecords().values()].map(async record=>{const entry=record.entryId&&await(await this.history()).entry(record.entryId);return {...record,text:entry?.type==='message'&&typeof entry.message.content==='string'?entry.message.content:record.text}})), native:{entries:(await this.getBranch()).entries,requests:fixture.requests}}
  }
}
let sessionId
const oldSessions = []
export default {async fetch(request,env) {
  const path=new URL(request.url).pathname
  if(path.startsWith('/__test/quiet-compaction')) {
    const input=path.endsWith('/disconnect') ? {action:'disconnect'} : await request.json()
    if(input.action==='reset' || input.action==='session') {
      if(input.action==='reset') for(const id of [...oldSessions,...(sessionId?[sessionId]:[])]) await env.PiSession.getByName(id).quietControl({action:'cleanup'})
      if(sessionId) { oldSessions.push(sessionId); await env.PiSession.getByName(sessionId).quietControl({action:'disconnect'}) }
      sessionId=crypto.randomUUID()
      await env.PiSession.getByName(sessionId).initialize({id:input.sessionId ?? sessionId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lineage:{type:'new'}})
      if(input.action==='reset') return Response.json(await env.PiSession.getByName(sessionId).quietControl(input))
    }
    if(input.action==='release') for(const id of oldSessions) await env.PiSession.getByName(id).quietControl(input)
    return Response.json(await env.PiSession.getByName(sessionId).quietControl(input))
  }
  const response=await worker.fetch(request,{...env,COMPANION_SESSION_ID:sessionId})
  if(response.status!==101 && response.headers.has('set-cookie')) {const headers=new Headers(response.headers);headers.set('set-cookie',headers.get('set-cookie').replace('; Secure',''));return new Response(response.body,{status:response.status,headers})}
  return response
}}

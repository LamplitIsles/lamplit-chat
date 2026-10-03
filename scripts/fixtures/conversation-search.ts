// Test-owned workerd entry only. Seed native entries/archives; never fabricate public hits/context.
import worker from '../../src/server'
import { PiSession as ImageSession, fixture } from './image-send-recovery'
import { PiRegistry as NativeRegistry } from '../../src/server/pi-registry'
import { searchId } from '../../src/server/conversation-search'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/pi-agent-core/harness/context'
import { branchTip, setValue } from '@earendil-works/pi-agent-core/harness/session'
const at = '2026-10-02T12:00:00Z', timestamp = Date.parse(at)
const suffix = ' <img src=x onerror=alert(1)>'

export class PiSession extends ImageSession {
  async seedSearchArchive() {
    const metadata = this.sessionStorage.getMetadataSync()
    const entries = []
    const add = (id, text, summary = false, parentId = entries.at(-1)?.id ?? null) => {
      entries.push({ id, parentId, seq: entries.length + 1, timestamp, ...(summary
        ? { type: 'compaction', summary: text, retainedTail: [], tokensBefore: 100, fromHook: false }
        : { type: 'message', message: { role: 'user', content: text, timestamp } }) })
    }
    add('before-original', 'before original branch')
    add('archive-0', '灯塔 lighthouse repeated' + suffix)
    // A native compaction preserves the original entry in source storage.
    add('nearby-original', 'nearby summary ' + '🕯'.repeat(13000), true)
    add('archive-2', '灯塔 lighthouse archiveSummary3142' + suffix, true)
    // A separate native branch isolates the repeated target's context.
    add('before-repeated', 'before imported branch', false, null)
    add('archive-1', '灯塔 lighthouse repeated' + suffix)
    add('nearby-repeated', 'nearby summary ' + '🕯'.repeat(13000), true)
    for (let i = 3; i < 22; i++) add(`archive-${i}`, `灯塔 lighthouse record ${i}` + suffix)
    await this.importSession({ metadata, entries, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, files: [] })
    // Real outbox and existing targeted summary refresh feed the same native FTS.
    return metadata.id
  }
  async resetSearchChat() {
    fixture.hold = false; fixture.mode = 'consumed'; fixture.regressions = true
    for (const release of fixture.releases.splice(0)) release()
    const metadata = this.sessionStorage.getMetadataSync()
    await this.importSession({ metadata, entries: [], compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, files: [] })
    await this.sessionStorage.commit([setValue(branchTip('main'), null)], context)
  }
  async searchState() {
    const branch = await this.getBranch()
    return { sessionId: this.sessionStorage.getMetadataSync().id, messages: branch.entries.filter(e => e.type === 'message' && (e.message?.role === 'user' || e.message?.role === 'assistant')).map(e => ({ id: e.id, text: typeof e.message.content === 'string' ? e.message.content : e.message.content.filter(p => p.type === 'text').map(p => p.text).join('\n') })) }
  }
}

export class PiRegistry extends NativeRegistry {
  calls = []
  failures = new Set()
  holdKey
  releases = []
  async deliver(method, key, read) {
    this.calls.push(`${method === 'search' ? 'search' : 'read'}:${key}`)
    if (this.failures.has(method)) throw new Error('Synthetic native method delivery failure')
    const result = await read()
    if (key === this.holdKey) await new Promise(resolve => this.releases.push(resolve))
    return result
  }
  search(input) { return this.deliver('search', input.query, () => super.search(input)) }
  searchRead(input) { return this.deliver('searchRead', input.id, () => super.searchRead(input)) }
  async searchControl(input) {
    if (input.action === 'reset') {
      this.calls = []; this.failures.clear(); this.holdKey = undefined
      for (const release of this.releases.splice(0)) release()
      let ids = await this.ctx.storage.get('searchFixtureIds')
      if (!ids) {
        const active = await this.ensureDefaultSession()
        const archive = await this.createSession({ name: 'archive-session' })
        await this.session(archive.id).seedSearchArchive()
        const time = { raw: at, interpretation: 'utc', epochMs: timestamp }
        const start = await this.historyRequest('start', { input: { conversation: { source: 'deepseek', conversationId: 'search-import-fixture', title: 'import-session', createdAt: time, updatedAt: time, selectedLeafId: 'archive-22' } } })
        if (start.status !== 200) throw new Error('Native import fixture start failed')
        const status = start.body
        const nodes = ['before-imported', 'archive-22'].map((id, index) => ({ id, messageId: id, parentId: index ? 'before-imported' : null, alternativeGroupId: null, sourceOrder: index, selected: true, speaker: 'fixture', role: 'user', time, parts: [{ type: 'text', text: index ? '灯塔 lighthouse record 22 archiveImported3142' + suffix : 'before imported branch' }] }))
        for (const [action, data] of [['append', { batch: 0, nodes }], ['commit', { batches: 1 }]]) {
          const result = await this.historyRequest(action, { id: status.importId, input: data })
          if (result.status !== 200) throw new Error('Native import fixture commit failed')
        }
        ids = { active: active.id, archive: archive.id, imported: status.archiveId }
        await this.ctx.storage.put('searchFixtureIds', ids)
      }
      const events = await this.session(ids.archive).flushOutbox()
      await this.applyIndexEvents(ids.archive, events)
      await this.session(ids.archive).acknowledgeOutbox(events.map(e => e.eventId))
      await this.session(ids.active).resetSearchChat()
    }
    if (input.action === 'failure') input.enabled ? this.failures.add(input.method) : this.failures.delete(input.method)
    if (input.action === 'hold') this.holdKey = input.key
    if (input.action === 'release') { this.holdKey = undefined; for (const release of this.releases.splice(0)) release() }
    const ids = await this.ctx.storage.get('searchFixtureIds')
    return { ...await this.session(ids.active).searchState(), calls: this.calls, archiveSessionId: ids.archive,
      recordIds: { original: searchId(ids.archive, 'archive-0'), repeated: searchId(ids.archive, 'archive-1'), summary: searchId(ids.archive, 'archive-2'), imported: searchId(ids.imported, 'archive-22') } }
  }
}
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/__test/conversation-search') return Response.json(await env.PiRegistry.getByName('singleton').searchControl(await request.json()))
  const response = await worker.fetch(request, env)
  if (response.status !== 101 && response.headers.has('set-cookie')) { const headers = new Headers(response.headers); headers.set('set-cookie', headers.get('set-cookie').replace('; Secure', '')); return new Response(response.body, { status: response.status, headers }) }
  return response
} }

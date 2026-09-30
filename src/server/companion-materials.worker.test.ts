import { env } from 'cloudflare:workers'
import { SELF, runInDurableObject } from 'cloudflare:test'
import { beforeEach, expect, it, vi } from 'vitest'
import server from '../server'
import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'
import type { MaterialFile, EffectiveCompaction } from '../shared/companion-materials'
import type { Memory } from '../shared/pi-contract'

let owner: string
beforeEach(() => { owner = crypto.randomUUID() })
const registry = () => env.PiRegistry.getByName(owner) as DurableObjectStub<PiRegistry>
async function request(path: string, method = 'GET', data?: unknown, origin?: string) {
  return server.fetch(new Request(`http://example.test/api/companion-materials/${path}`, { method, headers: {
    'x-lamplit-instance': owner, 'x-lamplit-internal-secret': 'fictional-secret', ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(origin ? { origin } : {}),
  }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fictional-secret' })
}
async function json<T>(response: Promise<Response>): Promise<T> { const r = await response; expect(r.ok).toBe(true); return r.json() }

it('edits actual root originals without a configured model, preserves empty files, and shares compaction override/version', async () => {
  const modelFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external calls allowed'))
  try {
    expect(await json(request('files'))).toEqual({ files: [] })
    const defaultPrompt = await json<EffectiveCompaction>(request('compaction'))
    expect(defaultPrompt).toMatchObject({ mode: 'default', version: 'default' })
    const agents = await json<MaterialFile>(request('files/AGENTS.md', 'POST', { content: 'Read SOUL.md when needed.' }))
    const soul = await json<MaterialFile>(request('files/SOUL.md', 'POST', { content: '' }))
    expect(soul.bytes).toBe(0)
    expect((await request('files/SOUL.md', 'POST', { content: 'overwrite' })).status).toBe(409)
    const updated = await json<MaterialFile>(request('files/SOUL.md', 'PUT', { content: 'Fictional moonflower', expectedVersion: soul.version }))
    expect(updated.version).not.toBe(soul.version)
    expect((await request('files/SOUL.md', 'PUT', { content: 'lost edit', expectedVersion: soul.version })).status).toBe(409)
    expect(await json(request('files/SOUL.md'))).toEqual(updated)
    const sessionId = (await registry().ensureDefaultSession()).id
    const session = env.PiSession.getByName(`${owner}:${sessionId}`) as DurableObjectStub<PiSession>
    expect(await session.readWorkspaceFile('/workspace/AGENTS.md')).toMatchObject({ content: agents.content })
    expect(await session.readWorkspaceFile('/workspace/SOUL.md')).toMatchObject({ content: updated.content })
    const custom = await json<EffectiveCompaction>(request('compaction', 'PUT', { content: 'Only fictional continuity.', expectedVersion: 'default' }))
    const original = await json<MaterialFile>(request('files/COMPACTION.md'))
    expect(original).toMatchObject({ content: custom.content, version: custom.version })
    expect((await request('files/COMPACTION.md', 'PUT', { content: ' ', expectedVersion: custom.version })).status).toBe(400)
    expect((await request('compaction', 'DELETE', { expectedVersion: 'default' })).status).toBe(409)
    expect(await json(request('compaction', 'DELETE', { expectedVersion: custom.version }))).toEqual(defaultPrompt)
    expect(await json(request('compaction', 'DELETE', { expectedVersion: 'default' }))).toEqual(defaultPrompt)
    expect((await request('files/COMPACTION.md')).status).toBe(404)
    expect(await json(request('files'))).toEqual({ files: [{ name: 'AGENTS.md', bytes: agents.bytes }, { name: 'SOUL.md', bytes: updated.bytes }] })
    expect(modelFetch).not.toHaveBeenCalled()
  } finally { modelFetch.mockRestore() }
})

it('rejects traversal, oversized UTF8/JSON, foreign owner/origin, arbitrary selectors, and missing selfhost configuration', async () => {
  for (const name of ['a%2Fb.md', 'a%5Cb.md', '%00.md', 'directory', '%2E%2E%2Fsecret.md']) expect((await request(`files/${name}`, 'POST', { content: 'fiction' })).status).toBe(400)
  const max = '灯'.repeat(42_666) + 'ab'
  const file = await json<MaterialFile>(request('files/boundary.md', 'POST', { content: max }))
  expect(file.bytes).toBe(128_000)
  expect((await request('files/boundary.md', 'PUT', { content: max + 'x', expectedVersion: file.version })).status).toBe(413)
  expect((await request('files/huge.md', 'POST', { content: 'x'.repeat(800_000) })).status).toBe(413)
  expect((await request('files?sessionId=other')).status).toBe(400)
  const forbidden = await request('files/a.md', 'POST', { content: 'x' }, 'https://foreign.invalid')
  expect(forbidden.status).toBe(403)
  expect(await forbidden.json()).toEqual({ error: { code: 'forbidden' } })
  expect(forbidden.headers.get('cache-control')).toBe('private, no-store')
  expect(forbidden.headers.get('x-content-type-options')).toBe('nosniff')
  expect(forbidden.headers.get('content-type')).toContain('application/json')
  for (const path of ['../companion-config', '../companion-materials-extra/files']) {
    const other = await request(path, 'GET', undefined, 'https://foreign.invalid')
    expect(other.status).toBe(403)
    expect(await other.text()).toBe('Forbidden')
  }
  expect((await SELF.fetch('http://example.test/api/companion-materials/files')).status).toBe(401)
  const selfhost = await server.fetch(new Request('http://example.test/api/companion-materials/files', { headers: { authorization: `Basic ${btoa('fixture:fixture-password-long-enough')}` } }), env)
  expect(selfhost.status).toBe(409)
  expect(await selfhost.json()).toEqual({ error: { code: 'unconfigured' } })
  owner = crypto.randomUUID()
  expect((await request('files/boundary.md')).status).toBe(404)
})

it('filters directories/nested files, bounds root listing and refuses busy operations before writes', async () => {
  const id = (await registry().ensureDefaultSession()).id
  const stub = env.PiSession.getByName(`${owner}:${id}`) as DurableObjectStub<PiSession>
  await runInDurableObject(stub, async instance => {
    // Existing test-owned Workspace seam; no real user files or configuration.
    const workspace = Reflect.get(instance, 'workspace') as import('./computer-workspace').ComputerWorkspace
    await workspace.mkdir('/workspace/directory.md', { recursive: true })
    await workspace.writeFile('/workspace/directory.md/child.md', 'nested fixture')
    await workspace.writeFile('/workspace/notes.txt', 'fixture')
  })
  expect(await json(request('files'))).toEqual({ files: [] })
  await runInDurableObject(stub, async instance => {
    Reflect.set(instance, 'active', true)
    try { expect(await instance.materialsRequest({ action: 'file-create', id: 'busy.md', input: { content: 'pending' } })).toEqual({ status: 409, body: { error: { code: 'busy' } } }) }
    finally { Reflect.set(instance, 'active', false) }
  })
  expect((await request('files/busy.md')).status).toBe(404)
  await runInDurableObject(stub, async instance => {
    const workspace = Reflect.get(instance, 'workspace') as import('./computer-workspace').ComputerWorkspace
    for (let i = 0; i < 200; i++) await workspace.writeFile(`/workspace/fixture-${i}.md`, '')
  })
  expect((await request('files')).status).toBe(413)
})

it('CAS edits/deletes existing memories, preserving original metadata and chat, with stable administration ordering', async () => {
  const first = await registry().setMemory({ kind: 'instruction', content: 'Fictional first agreement', sourceSessionId: 'fictional-session' })
  const second = await registry().setMemory({ kind: 'fact', content: 'Fictional second fact' })
  await runInDurableObject(registry(), (_instance, state) => {
    state.storage.sql.exec('UPDATE pi_registry_memories SET created_at=?, source_entry_id=? WHERE id=?', '2026-01-01T00:00:00.000Z', 'fictional-entry', first.id)
    state.storage.sql.exec('UPDATE pi_registry_memories SET created_at=? WHERE id=?', '2026-02-01T00:00:00.000Z', second.id)
  })
  const scopedId = (await registry().ensureDefaultSession()).id
  await runInDurableObject(env.PiSession.getByName(`${owner}:${scopedId}`), instance => {
    // Bindings use selfhost test Env; emulate the hosted identity for this test-owned DO.
    Reflect.set(instance, 'instanceId', () => owner)
  })
  const before = await json<{ memories: Memory[] }>(request('memories'))
  expect(before.memories.map(m => m.id)).toEqual([second.id, first.id])
  const original = before.memories[1]
  const edited = await json<{ memory: Memory }>(request(`memories/${first.id}`, 'PUT', { content: 'Corrected fictional agreement', expectedUpdatedAt: first.updatedAt }))
  expect(edited.memory).toEqual({ ...original, content: 'Corrected fictional agreement', updatedAt: expect.any(String) })
  expect(edited.memory.updatedAt).not.toBe(first.updatedAt)
  for (const method of ['PUT', 'DELETE']) expect((await request(`memories/${first.id}`, method, { ...(method === 'PUT' ? { content: 'stale' } : {}), expectedUpdatedAt: first.updatedAt })).status).toBe(409)
  expect((await request('memories', 'POST', { content: 'never add' })).status).toBe(405)
  expect((await request('memories/missing', 'PUT', { content: 'never add', expectedUpdatedAt: first.updatedAt })).status).toBe(404)
  const main = (await registry().ensureDefaultSession()).id
  expect(await json(request(`memories/${first.id}`, 'DELETE', { expectedUpdatedAt: edited.memory.updatedAt }))).toEqual({ deleted: true })
  expect((await request(`memories/${first.id}`, 'DELETE', { expectedUpdatedAt: edited.memory.updatedAt })).status).toBe(404)
  expect(await registry().hasReadySession(main)).toBe(true)
  expect((await registry().listMemories()).map(m => m.id)).toEqual([second.id])
})

it('concurrent create/update requests have one winner and do not overwrite it', async () => {
  const creates = await Promise.all([request('files/race.md', 'POST', { content: 'first fiction' }), request('files/race.md', 'POST', { content: 'second fiction' })])
  expect(creates.map(r => r.status).sort((a, b) => a - b)).toEqual([201, 409])
  const current = await json<MaterialFile>(request('files/race.md'))
  const updates = await Promise.all([request('files/race.md', 'PUT', { content: 'new first', expectedVersion: current.version }), request('files/race.md', 'PUT', { content: 'new second', expectedVersion: current.version })])
  expect(updates.map(r => r.status).sort((a, b) => a - b)).toEqual([200, 409])
  const winner = await updates.find(r => r.status === 200)!.json()
  expect(await json(request('files/race.md'))).toEqual(winner)
})

it('actual PiSession autoloads only AGENTS and compacts with API originals, native storage, and restored usage', async () => {
  const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/pi-agent-core/harness/context')
  const { StorageBackedSession } = await import('@earendil-works/pi-agent-core/harness/session')
  const { PiSessionStorage } = await import('./pi-session-storage')
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url instanceof Request ? url.url : url.toString()).toBe('https://example.invalid/v1/chat/completions')
    bodies.push(JSON.parse(init!.body as string))
    return new Response([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Offline continuity summary' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  try {
    await json(request('files/AGENTS.md', 'POST', { content: 'Fictional AGENTS autoload sentinel. Read SOUL.md when needed.' }))
    await json(request('files/SOUL.md', 'POST', { content: 'Fictional SOUL private sentinel.' }))
    await json(request('compaction', 'PUT', { content: 'Fictional full custom checkpoint policy.', expectedVersion: 'default' }))
    const id = (await registry().ensureDefaultSession()).id
    const stub = env.PiSession.getByName(`${owner}:${id}`) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, async instance => {
      const harness = await Reflect.get(instance, 'getHarness').call(instance) as import('./create-pi-harness').PiHarness
      const lane = await harness.lane('main', context)
      await lane.prompt('Fictional greeting', undefined, context)
      expect(JSON.stringify(bodies[0].messages[0])).toContain('AGENTS autoload sentinel')
      expect(JSON.stringify(bodies[0])).not.toContain('SOUL private sentinel')
      for (let i = 0; i < 6; i++) await lane.appendMessage({ role: 'user', content: 'Fictional compaction evidence ' + 'x'.repeat(3000), timestamp: Date.now() }, context)
      await harness.setCompactionSettings({ enabled: true, reserveTokens: 1000, keepRecentTokens: 100 }, context)
      const summary = await instance.compact()
      expect(summary.summary).toBe('Offline continuity summary')
      expect(bodies.at(-1)!.messages[0].content).toBe('Fictional full custom checkpoint policy.')
    })
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      const restored = new StorageBackedSession(storage.coreMetadata(), storage)
      const entries = await (await restored.branch('main', context))!.findEntries({ order: 'oldestFirst' }, context)
      expect(entries.at(-1)).toMatchObject({ type: 'compaction', summary: 'Offline continuity summary', usage: { totalTokens: 25 } })
      expect(await restored.getStats(context)).toMatchObject({ usage: { totalTokens: 50 } })
    })
  } finally { fake.mockRestore() }
})


it('rejects root symlink aliases and conflicts on dangling links without changing targets', async () => {
  const id = (await registry().ensureDefaultSession()).id
  const stub = env.PiSession.getByName(`${owner}:${id}`) as DurableObjectStub<PiSession>
  await runInDurableObject(stub, async instance => {
    const workspace = Reflect.get(instance, 'workspace') as import('./computer-workspace').ComputerWorkspace
    await workspace.mkdir('/workspace/nested', { recursive: true })
    await workspace.writeFile('/workspace/nested/original.md', 'Nested fictional original')
    await workspace.fs.symlink('/workspace/nested/original.md', '/workspace/alias.md')
    await workspace.fs.symlink('/workspace/missing.md', '/workspace/dangling.md')
    await workspace.fs.symlink('/workspace/nested/original.md', '/workspace/COMPACTION.md')
  })
  expect(await json(request('files'))).toEqual({ files: [] })
  for (const name of ['alias.md', 'dangling.md', 'COMPACTION.md']) {
    expect((await request(`files/${name}`)).status).toBe(400)
    expect((await request(`files/${name}`, 'PUT', { content: 'Never overwrite', expectedVersion: 'default' })).status).toBe(400)
    expect((await request(`files/${name}`, 'POST', { content: 'Never create' })).status).toBe(409)
  }
  for (const method of ['GET', 'PUT', 'DELETE']) expect((await request('compaction', method, method === 'GET' ? undefined : { ...(method === 'PUT' ? { content: 'Never overwrite' } : {}), expectedVersion: 'default' })).status).toBe(400)
  await runInDurableObject(stub, async instance => {
    const workspace = Reflect.get(instance, 'workspace') as import('./computer-workspace').ComputerWorkspace
    expect(await workspace.readFile('/workspace/nested/original.md')).toBe('Nested fictional original')
    expect(await workspace.fs.readlink('/workspace/dangling.md')).toBe('/workspace/missing.md')
    expect(await workspace.fs.readlink('/workspace/COMPACTION.md')).toBe('/workspace/nested/original.md')
  })
})

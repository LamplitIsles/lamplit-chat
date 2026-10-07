import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { NativeFixture } from './fixtures/native-session'
import { nativeReply } from './fixtures/native-provider'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'
import { PiSessionStorage } from './pi-session-storage'
import type { SessionIndexEvent } from '../shared/pi-contract'

type RegistryStub = DurableObjectStub<PiRegistry>
const registry = () => env.PiRegistry.getByName('singleton') as RegistryStub
const session = (id: string) => env.PiSession.getByName(id) as DurableObjectStub<PiSession>

describe('durable sessions', () => {
  it('registers file tools without code execution, Git, publish, or app tools', async () => {
    const created = await registry().createSession({ name: 'Free tool surface' })
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, async (instance) => {
      const lane = await (instance as unknown as NativeFixture).getLane()
      const names = (await lane.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)
      expect(names).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'list', 'find', 'grep', 'session_search']))
      for (const forbidden of ['exec', 'javascript', 'publish', 'initialize_app']) expect(names).not.toContain(forbidden)
    })
  })

  it('keeps exclusive operations blocked while actual native work is active and reuses durable submission identity', async () => {
    const created = await registry().createSession({ name: 'Native exclusivity' })
    const stub = session(created.id)
    let release!: () => void
    const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return nativeReply('openrouter', 'Finished native fixture')
    })
    try {
      await runInDurableObject(stub, async instance => {
        vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
        const input = { operationId: crypto.randomUUID(), text: 'Hold native fixture' }
        const first = await instance.submitChat(input)
        expect(first.state).toBe('submitted')
        expect(await instance.submitChat(input)).toMatchObject({ state: 'submitted' })
        await expect(instance.submitChat({ ...input, text: 'conflict' })).rejects.toThrow('identity conflict')
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        expect(await instance.materialsRequest({ action: 'file-create', id: 'busy.md', input: { content: 'fixture' } })).toMatchObject({ status: 409 })
        await expect(instance.updateCompactionSettings({ enabled: true, reserveTokens: 1000, keepRecentTokens: 100 })).rejects.toThrow('currently running')
        release()
        await (instance as unknown as NativeFixture).native.wait(input.operationId)
        expect(await instance.lookupChat(input.operationId)).toMatchObject({ state: 'submitted', messageId: expect.any(String) })
      })
      expect(fake).toHaveBeenCalledTimes(1)
    } finally { release?.(); fake.mockRestore() }
  })

  it('refuses photo correlation without a frozen group when an upload row exists', async () => {
    const created = await registry().createSession({ name: 'Unfrozen upload' })
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, (_instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      const operationId = crypto.randomUUID()
      state.storage.sql.exec('INSERT INTO conversation_photos(id, operation_id, name, media_type, fingerprint, created_at, ordinal, original_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', crypto.randomUUID(), operationId, 'upload.jpg', 'image/jpeg', 'fingerprint', Date.now(), 0, 4)
      expect(() => storage.acceptPhotos(operationId, 'entry')).toThrow('Photo group was not frozen')
    })
  })

  it('reports an operation that was never admitted as missing', async () => {
    const created = await registry().createSession({ name: 'Admission lookup' })
    const operationId = crypto.randomUUID()
    await expect(session(created.id).lookupChat(operationId)).resolves.toBeNull()
  })

  it('reads only dated memory files from the session workspace', async () => {
    const created = await registry().createSession({ name: 'Diary source' })
    const current = session(created.id)
    await runInDurableObject(current, async instance => {
      const workspace = Reflect.get(instance, 'workspace') as import('./computer-workspace').ComputerWorkspace
      await workspace.mkdir('/workspace/memory', { recursive: true })
      for (const [name, content] of [['2026-09-27.md', '# Today'], ['2026-09-26.md', '# Yesterday'], ['notes.md', 'Private note'], ['2026-09-25.md', 'x'.repeat(128 * 1024 + 1)]]) await workspace.writeFile(`/workspace/memory/${name}`, content)
    })

    expect(await current.listDiary()).toEqual(['2026-09-27.md', '2026-09-26.md', '2026-09-25.md'])
    expect(await current.readDiary('2026-09-27.md')).toEqual({ name: '2026-09-27.md', text: '# Today' })
    expect(await current.readDiary('2026-09-25.md')).toEqual({ tooLarge: true })
    expect(await current.readDiary('notes.md')).toBeNull()
    expect(await current.readDiary('../USER.md')).toBeNull()
  })

  it('creates isolated named sessions and persists metadata', async () => {
    const first = await registry().createSession({ name: 'First session' })
    const second = await registry().createSession({ name: 'Second session' })

    expect(first.id).not.toBe(second.id)
    expect((await session(first.id).getOverview()).name).toBe('First session')
    expect(await session(first.id).listFiles()).toEqual([])
    expect((await session(second.id).getOverview()).name).toBe('Second session')
    expect((await registry().listSessions()).map(({ id }) => id)).toEqual(expect.arrayContaining([first.id, second.id]))
  })

  it('indexes transcript text idempotently for UI and model search', async () => {
    const created = await registry().createSession({ name: 'Search source' })
    const event: SessionIndexEvent = {
      eventId: crypto.randomUUID(),
      type: 'message',
      entryId: 'message-1',
      entrySeq: 1,
      role: 'user',
      timestamp: new Date().toISOString(),
      text: 'Durable aardvark protocol notes',
    }

    await registry().applyIndexEvents(created.id, [event, event])
    const results = await registry().searchSessions({ query: 'aardvark' })

    expect(results).toHaveLength(1)
    expect(results[0].session.id).toBe(created.id)
    expect(results[0].matches).toHaveLength(1)
    expect(results[0].matches[0].text).toContain('aardvark')
  })

  it('finds a Chinese word inside a longer message through FTS', async () => {
    const created = await registry().createSession({ name: '中文检索' })
    await registry().applyIndexEvents(created.id, [{
      eventId: crypto.randomUUID(), type: 'message', entryId: 'zh-message', entrySeq: 1,
      role: 'user', timestamp: new Date().toISOString(), text: '今天喜欢梅花茶和散步',
    }])
    expect((await registry().searchSessions({ query: '梅花' })).map(({ session }) => session.id)).toContain(created.id)
  })

  it('tombstones and removes deleted sessions from discovery', async () => {
    const created = await registry().createSession({ name: 'Delete me' })
    await registry().deleteSession(created.id)

    expect((await registry().listSessions()).some(({ id }) => id === created.id)).toBe(false)
  })

  it('keeps global memory after its source session is deleted', async () => {
    const source = await registry().createSession({ name: 'Memory source' })
    const memory = await registry().setMemory({
      kind: 'preference',
      content: `Prefers concise test responses ${source.id}`,
      sourceSessionId: source.id,
    })

    await registry().deleteSession(source.id)

    expect((await registry().listMemories()).some(({ id }) => id === memory.id)).toBe(true)
    await registry().deleteMemory(memory.id)
  })

  it('applies extracted memory idempotently from an indexed source entry', async () => {
    const source = await registry().createSession({ name: 'Extraction source' })
    const entryId = crypto.randomUUID()
    await registry().applyIndexEvents(source.id, [{
      eventId: crypto.randomUUID(),
      type: 'message',
      entryId,
      entrySeq: 1,
      role: 'user',
      timestamp: new Date().toISOString(),
      text: 'I prefer deterministic memory tests.',
    }])
    const input = {
      extractionId: crypto.randomUUID(),
      sessionId: source.id,
      throughRevision: 1,
      operations: [{
        action: 'add' as const,
        kind: 'preference' as const,
        content: `Prefers deterministic memory tests ${source.id}`,
        sourceEntryId: entryId,
      }],
    }

    await registry().applyMemoryExtraction(input)
    await registry().applyMemoryExtraction(input)

    const matches = (await registry().listMemories()).filter(({ content }) => content === input.operations[0].content)
    expect(matches).toHaveLength(1)
    await registry().deleteMemory(matches[0].id)
  })

})

import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { AgentLane } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'
import { PiSessionStorage } from './pi-session-storage'
import type { SessionIndexEvent } from '../shared/pi-contract'

type RegistryStub = DurableObjectStub<PiRegistry>
type SessionStub = {
  getOverview(): ReturnType<import('./pi-session').PiSession['getOverview']>
  getBranch(leafId?: string): ReturnType<import('./pi-session').PiSession['getBranch']>
  listFiles(): ReturnType<import('./pi-session').PiSession['listFiles']>
  importSession(snapshot: unknown): ReturnType<import('./pi-session').PiSession['getOverview']>
  exportClone(): Promise<{ files: Array<{ path: string; content: string; encoding?: 'base64' }> }>
  readWorkspaceFile(path: string): ReturnType<import('./pi-session').PiSession['readWorkspaceFile']>
  listDiary(): ReturnType<import('./pi-session').PiSession['listDiary']>
  readDiary(name: string): ReturnType<import('./pi-session').PiSession['readDiary']>
  getPromptAdmission(operationId: string): ReturnType<import('./pi-session').PiSession['getPromptAdmission']>
}

const registry = () => env.PiRegistry.getByName('singleton') as RegistryStub
const session = (id: string) => env.PiSession.getByName(id) as unknown as SessionStub

describe('durable sessions', () => {
  it('registers file tools without code execution, Git, publish, or app tools', async () => {
    const created = await registry().createSession({ name: 'Free tool surface' })
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, async (instance) => {
      const lane = await (instance as unknown as { getLane(): Promise<AgentLane> }).getLane()
      const names = await lane.getActiveTools(BACKGROUND_CONTEXT)
      expect(names).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'list', 'find', 'grep', 'session_search']))
      for (const forbidden of ['exec', 'javascript', 'publish', 'initialize_app']) expect(names).not.toContain(forbidden)
    })
  })

  it('keeps exclusive operations blocked throughout restart recovery', async () => {
    const created = await registry().createSession({ name: 'Recovery exclusivity' })
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, async (instance, state) => {
      const internals = instance as unknown as {
        getLane(): Promise<AgentLane>
        flushOutboxToRegistry(): Promise<void>
        scheduleMemoryExtraction(): void
        schedulePendingDrain(): Promise<void>
        active: boolean
        promptOperationId?: string
      }
      const lane = await internals.getLane()
      const operationId = crypto.randomUUID()
      new PiSessionStorage(state.storage).admitPromptSubmission(operationId, 'test-fingerprint')
      const accepted = await lane.accept({ kind: 'prompt', operationId, prompt: 'Recovery test' }, BACKGROUND_CONTEXT)
      expect(accepted.ok).toBe(true)

      let finishResume!: (result: Awaited<ReturnType<AgentLane['resume']>>) => void
      const pendingResume = new Promise<Awaited<ReturnType<AgentLane['resume']>>>((resolve) => { finishResume = resolve })
      const getLane = vi.spyOn(internals, 'getLane').mockResolvedValue(lane)
      const resume = vi.spyOn(lane, 'resume').mockReturnValue(pendingResume)
      const flush = vi.spyOn(internals, 'flushOutboxToRegistry').mockResolvedValue()
      const memory = vi.spyOn(internals, 'scheduleMemoryExtraction').mockImplementation(() => {})
      const drain = vi.spyOn(internals, 'schedulePendingDrain').mockResolvedValue()
      try {
        await instance.onStart()
        expect(resume).toHaveBeenCalledTimes(1)
        expect(internals.active).toBe(true)
        expect(internals.promptOperationId).toBe(operationId)
        await expect(instance.compact()).rejects.toThrow('Pi is currently running.')
        await expect(instance.exportSession()).rejects.toThrow('Pi is currently running.')
      } finally {
        finishResume({ ok: true, value: { operationId, status: 'completed' } } as Awaited<ReturnType<AgentLane['resume']>>)
        await vi.waitFor(() => expect(internals.active).toBe(false))
        await vi.waitFor(() => expect(drain).toHaveBeenCalled())
        expect(internals.promptOperationId).toBeUndefined()
        flush.mockRestore()
        memory.mockRestore()
        drain.mockRestore()
        resume.mockRestore()
        getLane.mockRestore()
      }
    })
  })

  it('persists one prompt identity and rejects conflicting reuse', async () => {
    const created = await registry().createSession({ name: 'Prompt ledger' })
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    const operationId = crypto.randomUUID()
    await runInDurableObject(stub, (_instance, state) => {
      const ledger = new PiSessionStorage(state.storage)
      const first = ledger.admitPromptSubmission(operationId, 'fingerprint-1')
      expect(first.created).toBe(true)
      expect(first.record).toMatchObject({ operationId, state: 'submitting' })
      expect(ledger.admitPromptSubmission(operationId, 'fingerprint-1').created).toBe(false)
      expect(() => ledger.admitPromptSubmission(operationId, 'fingerprint-2')).toThrow('identity conflict')
      expect(ledger.acceptPromptSubmission(operationId, 'user-entry')).toMatchObject({ state: 'accepted', entryId: 'user-entry' })
      expect(ledger.acceptPromptSubmission(operationId, 'user-entry').entryId).toBe('user-entry')
      expect(() => ledger.acceptPromptSubmission(operationId, 'other-entry')).toThrow('entry identity conflict')
    })
    await runInDurableObject(stub, (_instance, state) => {
      expect(new PiSessionStorage(state.storage).getPromptSubmission(operationId))
        .toMatchObject({ operationId, fingerprint: 'fingerprint-1', state: 'accepted', entryId: 'user-entry' })
    })
  })

  it('recovers a pre-upgrade text-only prompt without a frozen photo group', async () => {
    const created = await registry().createSession({ name: 'Legacy prompt recovery' })
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    const operationId = crypto.randomUUID()
    const prompt = 'Text sent before photo support'
    await runInDurableObject(stub, async (instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt)))
      const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
      state.storage.sql.exec("INSERT INTO pi_prompt_submissions(operation_id, fingerprint, state, entry_id, created_at) VALUES (?, ?, 'submitting', NULL, ?)", operationId, fingerprint, new Date().toISOString())
      const lane = await (instance as unknown as { getLane(): Promise<AgentLane> }).getLane()
      const accepted = await lane.accept({ kind: 'prompt', operationId, prompt }, BACKGROUND_CONTEXT)
      expect(accepted.ok).toBe(true)
      const admission = await instance.getPromptAdmission(operationId)
      expect(admission).toMatchObject({ state: 'accepted' })
      if (admission.state !== 'accepted') throw new Error('Legacy prompt was not recovered.')
      const entryId = admission.entryId
      expect(storage.getPromptSubmission(operationId)).toMatchObject({ state: 'accepted', entryId })
      expect(state.storage.sql.exec('SELECT 1 FROM conversation_photo_groups WHERE operation_id = ?', operationId).toArray()).toHaveLength(0)

      const events: unknown[] = []
      await instance.prompt({ send: (event: unknown) => { events.push(event) }, end: () => {} } as unknown as Parameters<PiSession['prompt']>[0], { operationId, prompt })
      expect(events).toContainEqual({ type: 'accepted', operationId, entryId })
      expect(storage.photosForEntry(entryId)).toHaveLength(0)
    })
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
    await expect(session(created.id).getPromptAdmission(operationId))
      .resolves.toEqual({ state: 'missing', operationId })
  })

  it('reads only dated memory files from the session workspace', async () => {
    const created = await registry().createSession({ name: 'Diary source' })
    const current = session(created.id)
    await current.importSession({
      metadata: { id: created.id, createdAt: created.createdAt, updatedAt: created.updatedAt, lineage: { type: 'new' } },
      entries: [],
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      files: [
        { path: '/memory/2026-09-27.md', content: '# Today' },
        { path: '/memory/2026-09-26.md', content: '# Yesterday' },
        { path: '/memory/notes.md', content: 'Private note' },
        { path: '/memory/2026-09-25.md', content: 'x'.repeat(128 * 1024 + 1) },
      ],
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

  it('forks before a selected user message and copies the current workspace', async () => {
    const source = await registry().createSession({ name: 'Fork source' })
    const timestamp = new Date().toISOString()
    const messageTimestamp = Date.now()
    await session(source.id).importSession({
      metadata: { id: source.id, createdAt: source.createdAt, updatedAt: timestamp, lineage: { type: 'new' } },
      entries: [
        { type: 'message', id: 'user-1', parentId: null, seq: 1, timestamp: messageTimestamp, message: { role: 'user', content: 'First prompt', timestamp: messageTimestamp } },
        { type: 'message', id: 'assistant-1', parentId: 'user-1', seq: 2, timestamp: messageTimestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'First answer' }], api: 'openai-completions', provider: 'test', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: messageTimestamp } },
        { type: 'message', id: 'user-2', parentId: 'assistant-1', seq: 3, timestamp: messageTimestamp, message: { role: 'user', content: 'Fork this prompt', timestamp: messageTimestamp } },
      ],
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      files: [{ path: '/notes.txt', content: 'current workspace' }],
    })

    const forked = await registry().forkSession({ sourceSessionId: source.id, entryId: 'user-2', name: 'Forked' })
    const branch = await session(forked.id).getBranch()
    expect(branch.entries[0]?.timestamp).toBe(new Date(messageTimestamp).toISOString())

    expect(branch.entries.filter(({ type }) => type === 'message').map(({ id }) => id)).toEqual(['user-1', 'assistant-1'])
    expect((await session(forked.id).readWorkspaceFile('/notes.txt')).content).toBe('current workspace')
    expect(await session(forked.id).listFiles()).toContainEqual(expect.objectContaining({ path: '/workspace/notes.txt', size: 17 }))
    expect((await session(forked.id).getOverview()).lineage).toEqual({
      type: 'fork',
      parentSessionId: source.id,
      sourceEntryId: 'user-2',
    })
    expect((await registry().searchSessions({ query: 'First answer' })).some(({ session: item }) => item.id === forked.id)).toBe(true)
  })

  it('preserves binary workspace files in session snapshots', async () => {
    const source = await registry().createSession({ name: 'Binary source' })
    await session(source.id).importSession({
      metadata: { id: source.id, createdAt: source.createdAt, updatedAt: source.updatedAt, lineage: { type: 'new' } },
      entries: [],
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      files: [{ path: '/asset.bin', content: 'AP+AQA==', encoding: 'base64' }],
    })

    expect((await session(source.id).exportClone()).files).toContainEqual({
      path: '/workspace/asset.bin',
      content: 'AP+AQA==',
      encoding: 'base64',
    })
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

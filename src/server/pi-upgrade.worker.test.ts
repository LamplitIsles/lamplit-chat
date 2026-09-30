import { env, runInDurableObject } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { StorageBackedSession, laneConfig, list, type CommittedWrite } from '@earendil-works/pi-agent-core/harness/session'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/pi-agent-core/harness/context'
import { Type } from 'typebox'
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-agent-core'
import { createPiHarness } from './create-pi-harness'
import fixture from './fixtures/pi-0871-writes.json'
import { PiV4Storage } from './pi-v4-storage'
import type { PiSession } from './pi-session'

it('reads 0.87.1 committed writes and preserves branches, state and associations after append and reconstruction', async () => {
  expect(fixture.sourceVersion).toBe('0.87.1')
  const stub = env.PiSession.getByName('pi-upgrade-fixture') as DurableObjectStub<PiSession>
  await runInDurableObject(stub, async (_instance, state) => {
    new PiV4Storage(state.storage)
    for (const write of fixture.writes) {
      state.storage.sql.exec('INSERT INTO pi_v4_writes(seq, data) VALUES (?, ?)', write.seq, JSON.stringify(write))
    }
    const metadata = { storageVersion: 4, id: 'fixture', createdAt: fixture.timestamp, updatedAt: fixture.timestamp }
    const storage = new PiV4Storage(state.storage)
    const session = new StorageBackedSession(metadata, storage)
    const attach = async (session: StorageBackedSession) => {
      const harness = await createPiHarness({
        session, env: { MODEL_API_KEY: 'fixture-key', MODEL_BASE_URL: 'https://example.invalid/v1', AI_MODEL: 'fixture-model' } as unknown as Env,
        tools: [{ name: 'read', label: 'read', description: 'read', parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }],
        memory: { getMemoryContext: async () => '', getRelationshipContext: async () => '' }, compaction: DEFAULT_COMPACTION_SETTINGS,
        loadInstructions: async () => null, getUserTimeZone: async () => 'Asia/Shanghai',
      })
      const lane = await harness.lane('main', context)
      expect(await lane.getActiveTools(context)).toEqual(['read'])
      expect(await lane.getThinkingLevel(context)).toBe('medium')
      expect(await lane.inspectExecution(context)).toMatchObject({ current: null, lastOperationId: null })
      return lane
    }
    const main = await attach(session)
    expect(state.storage.sql.exec('SELECT seq FROM pi_v4_writes').toArray()).toHaveLength(fixture.writes.length)
    expect((await main.findEntries({ order: 'oldestFirst' }, context)).map(entry => entry.id)).toEqual(['old-user', 'old-answer'])
    expect(await (await session.branch('alternate', context))!.getTipId(context)).toBe('other-user')
    expect(await session.getName(context)).toBe('Synthetic 0.87.1 session')
    expect((await session.getValue(laneConfig('main'), context))?.value).toMatchObject({ thinkingLevel: 'medium', activeToolNames: ['read'] })
    const id = await main.appendMessage({ role: 'user', content: 'New 0.99.1 prompt', timestamp: fixture.timestamp + 1000 }, context)
    const rebuiltStorage = new PiV4Storage(state.storage)
    const rebuilt = new StorageBackedSession(metadata, rebuiltStorage)
    const entries = await (await attach(rebuilt)).findEntries({ order: 'oldestFirst' }, context)
    expect(entries.map(entry => entry.id)).toEqual(['old-user', 'old-answer', id])
    expect(entries[2]).toMatchObject({ parentId: 'old-answer', message: { content: 'New 0.99.1 prompt' } })
    expect(await (await rebuilt.branch('alternate', context))!.getTipId(context)).toBe('other-user')
    expect(await rebuilt.getValue(laneConfig('main'), context)).toEqual(await session.getValue(laneConfig('main'), context))
    expect(await rebuilt.readList(list('fixture', 'events'), undefined, context)).toEqual([{ seq: 8, value: { entryId: 'old-answer' } }])
    expect(await rebuiltStorage.scanUsage({}, context)).toMatchObject([{ entryId: 'old-answer', usage: { totalTokens: 6 } }])
    expect(await rebuilt.getStats(context)).toMatchObject({ messageCount: 4, usage: { totalTokens: 6 } })
    const persisted = state.storage.sql.exec<{ data: string }>('SELECT data FROM pi_v4_writes ORDER BY seq').toArray()
    expect(persisted.slice(0, fixture.writes.length).map(row => JSON.parse(row.data) as CommittedWrite)).toEqual(fixture.writes)
  })
})

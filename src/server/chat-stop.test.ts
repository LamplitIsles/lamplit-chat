import { expect, it } from 'vitest'
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/pi-agent-core/harness/context'
import { MemorySessionRepo, operationResult, pendingEntry } from '@earendil-works/pi-agent-core/harness/session'
import { createPiHarness } from './create-pi-harness'
import { stopPiChatTurn } from './chat-adapter'
import type { LaneCommand, LaneState } from '../../node_modules/@earendil-works/pi-agent-core/dist/harness/runtime/types'

async function fixture() {
  const session = await new MemorySessionRepo().create({}, context)
  const harness = await createPiHarness({
    env: { MODEL_API_KEY: 'fixture', MODEL_BASE_URL: 'https://example.invalid/v1', AI_MODEL: 'fixture', AI_MEMORY_MODEL: 'fixture', MODEL_CONTEXT_WINDOW: '128000', MODEL_MAX_TOKENS: '4096', PI_SYSTEM_PROMPT: '' },
    session, tools: [], memory: { getMemoryContext: async () => '', getRelationshipContext: async () => '' },
    compaction: DEFAULT_COMPACTION_SETTINGS, loadInstructions: async () => null, getUserTimeZone: async () => 'UTC',
  })
  return { session, harness, lane: await harness.lane('main', context) }
}

it('does not cancel a newer operation queued ahead of the stop request', async () => {
  const f = await fixture()
  try {
    await f.lane.accept({ kind: 'prompt', operationId: 'A', prompt: 'fixture' }, context)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    // The native serializer is used only to force the reviewed interleaving.
    const lane = f.lane as typeof f.lane & { command<T>(plan: (state: LaneState) => Promise<LaneCommand<T>>, ctx: typeof context): Promise<T> }
    const transition = lane.command(async state => {
      entered(); await gate
      if (!state.operation) throw new Error('Expected admitted operation')
      return { kind: 'commit', writes: [], next: { ...state, operation: { ...state.operation, meta: { ...state.operation.meta, operationId: 'B' } } }, materialize: () => null, events: () => [] }
    }, context)
    await started
    const stopping = stopPiChatTurn(f.lane, 'A')
    release(); await transition
    expect(await stopping).toEqual({ stopped: false })
    const current = (await f.lane.inspectExecution(context)).current
    expect(current?.id).toBe('B')
    expect((await f.session.getValue(operationResult('B'), context))).toBeUndefined()
  } finally { await f.harness.close(context) }
})

it('stops before generation, persists an aborted outcome and removes unconsumed steer', async () => {
  const f = await fixture()
  try {
    await f.lane.accept({ kind: 'prompt', operationId: 'A', prompt: 'fixture' }, context)
    const steer = await f.lane.steer('queued input', undefined, context)
    if (!steer.ok) throw steer.error
    expect(await f.session.getValue(pendingEntry(steer.value.entryId), context)).toBeDefined()
    expect(await stopPiChatTurn(f.lane, 'A')).toEqual({ stopped: true })
    expect((await f.session.getValue(operationResult('A'), context))?.value.status).toBe('aborted')
    expect(await f.session.getValue(pendingEntry(steer.value.entryId), context)).toBeUndefined()
    expect((await f.session.getEntries([steer.value.entryId], context)).size).toBe(0)
    expect(await stopPiChatTurn(f.lane, 'A')).toEqual({ stopped: false })
  } finally { await f.harness.close(context) }
})

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { PiRegistry } from './pi-registry'

const registry = () => env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>

describe('shared relationship journal', () => {
  it('persists changes, keeps the latest state, and pages history newest first', async () => {
    const initial = await registry().getRelationshipSnapshot({ limit: 1 })
    expect(initial).toMatchObject({ state: { mood: 'neutral', affinity: 50, signature: '' }, records: [], hasEarlier: false })

    await registry().updateRelationship({ mood: { value: 'bright', note: '好奇', reason: 'We talked about a new idea.' }, affinity: { delta: 3, reason: 'A warm conversation.' } })
    await registry().updateRelationship({ signature: { value: '今天也在这里', reason: 'A phrase that feels right.' } })

    const first = await registry().getRelationshipSnapshot({ limit: 1 })
    expect(first.state).toEqual({ mood: 'bright', note: '好奇', affinity: 53, signature: '今天也在这里' })
    expect(first.records).toHaveLength(1)
    expect(first.records[0]?.changes.signature?.reason).toBe('A phrase that feels right.')
    expect(first.hasEarlier).toBe(true)
    expect(first.predecessor?.changes.mood?.value).toBe('bright')

    const second = await registry().getRelationshipSnapshot({ limit: 1, before: first.nextBefore })
    expect(second.records[0]?.changes.affinity?.value).toBe(53)
    expect(second.hasEarlier).toBe(false)
    expect(second.state).toEqual(first.state)
  })
})

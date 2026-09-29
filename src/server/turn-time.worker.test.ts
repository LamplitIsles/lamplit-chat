import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { PiRegistry } from './pi-registry'

describe('shared user time zone', () => {
  it('falls back, validates reports, and survives Durable Object activation', async () => {
    const stub = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
    await runInDurableObject(stub, async (registry) => {
      expect(await registry.getUserTimeZone()).toBe('Asia/Shanghai')
      expect(await registry.reportUserTimeZone('America/New_York')).toBe('America/New_York')
      expect(await registry.reportUserTimeZone('Not/A_Zone')).toBe('America/New_York')
      expect(await registry.reportUserTimeZone('+05:00')).toBe('America/New_York')
      expect(await registry.reportUserTimeZone(' America/Los_Angeles ')).toBe('America/New_York')
    })
    await runInDurableObject(stub, async (registry) => {
      expect(await registry.getUserTimeZone()).toBe('America/New_York')
    })
  })
})

import { env } from 'cloudflare:workers'
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import type { NativeFixture } from './fixtures/native-session'
import { PiSessionStorage } from './pi-session-storage'
import { nextWake } from './timed-wake'
import { occurrenceKey, type TimedWake, type WakeSource } from '../shared/timed-wake'
const source = (wake: TimedWake): WakeSource => ({ wakeId: wake.id, revision: wake.revision, scheduledAt: wake.nextAt, title: wake.title, reminder: wake.reminder })
async function fresh() {
  const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
  const created = await registry.createSession({ name: 'Synthetic wake session' })
  const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
  await stub.fetch(new Request('http://fixture.invalid/'))
  await runInDurableObject(stub, instance => {
    // Memory extraction is independent background model work, outside these wake fixtures.
    vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
  })
  return stub
}
describe('timed wakes in local workerd', () => {
  beforeEach(() => {
    const original = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith('https://openrouter.ai/')) return original(input, init)
      return new Response(
      'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Synthetic wake answer"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
    })
  })
  afterEach(() => { vi.restoreAllMocks() })
  it('validates CRUD, quota, browser zone absence and session isolation', async () => {
    const a = await fresh(), b = await fresh()
    await runInDurableObject(a, async instance => {
      await expect(instance.saveTimedWake({ title: '', reminder: 'x', plan: { type: 'once', at: new Date(Date.now() + 100000).toISOString() } })).rejects.toThrow('Title')
      await expect(instance.saveTimedWake({ title: 'x', reminder: 'x', plan: { type: 'once', at: '2026-02-30T12:00:00Z' } })).rejects.toThrow('calendar')
      await expect(instance.saveTimedWake({ title: 'x', reminder: 'x', plan: { type: 'once', at: '2026-01-01T12:00:00' } })).rejects.toThrow('offset')
      await expect(instance.saveTimedWake({ title: 'x', reminder: 'x', plan: { type: 'daily', time: '09:00', timeZone: '' } })).rejects.toThrow('IANA')
      const first = await instance.saveTimedWake({ title: 'tea', reminder: 'Take a break', plan: { type: 'once', at: new Date(Date.now() + 120000).toISOString() } })
      const changed = await instance.saveTimedWake({ title: 'walk', reminder: 'Walk', plan: first.plan }, first.id)
      expect(changed.revision).not.toBe(first.revision)
      await instance.acceptTimedWake(source(first))
      expect(await instance.listTimedWakes()).toEqual([changed])
      expect(await instance.cancelTimedWake(changed.id)).toBe(true)
      await instance.acceptTimedWake(source(changed))
      expect(await instance.listTimedWakes()).toEqual([])
      for (let i = 0; i < 32; i++) await instance.saveTimedWake({ title: `${i}`, reminder: 'quota fixture', plan: first.plan })
      await expect(instance.saveTimedWake({ title: '33', reminder: 'limit', plan: first.plan })).rejects.toThrow('32')
    })
    await expect(b.listTimedWakes()).resolves.toEqual([])
  })
  it('skips unaccepted late occurrences, retaining interval anchor without writing messages', async () => {
    const stub = await fresh()
    await runInDurableObject(stub, async (instance, _state) => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const wake = await instance.saveTimedWake({ title: 'repeat', reminder: 'synthetic', plan: { type: 'interval', anchor: new Date(Date.now() + 120000).toISOString(), seconds: 60 } })
      const late = { ...wake, nextAt: new Date(Date.now() - 60001).toISOString() }
      storage.setSetting('timedWakes', [late])
      await instance.acceptTimedWake(source(late))
      const [next] = await instance.listTimedWakes()
      expect(Date.parse(next.nextAt)).toBeGreaterThan(Date.now())
      expect((Date.parse(next.nextAt) - Date.parse(wake.plan.type === 'interval' ? wake.plan.anchor : '')) % 60000).toBe(0)
      expect(storage.entriesInOrder().filter(e => e.type === 'message')).toHaveLength(0)
      expect(storage.wakeReceipt(source(late))).toBeUndefined()
      storage.setSetting('timedWakes', [{ ...late, plan: { type: 'once', at: late.nextAt } }])
      await instance.acceptTimedWake(source(late))
      expect(await instance.listTimedWakes()).toEqual([])
    })
  })
  it('calculates real timezone and DST dates in workerd without a timer', () => {
    expect(nextWake({ type: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, Date.parse('2026-01-01T00:00:00Z'))).toBe('2026-01-01T01:00:00.000Z')
    expect(nextWake({ type: 'daily', time: '02:30', timeZone: 'America/New_York' }, Date.parse('2026-03-08T05:00:00Z'))).toBe('2026-03-08T07:30:00.000Z')
    expect(nextWake({ type: 'daily', time: '01:30', timeZone: 'America/New_York' }, Date.parse('2026-11-01T05:30:00Z'))).toBe('2026-11-02T06:30:00.000Z')
    expect(nextWake({ type: 'weekly', weekday: 0, time: '09:00', timeZone: 'Europe/Berlin' }, Date.parse('2026-03-28T12:00:00Z'))).toBe('2026-03-29T07:00:00.000Z')
  })
  it('accepts on an actual SDK alarm without a browser, preserves source and deduplicates native execution', async () => {
    const stub = await fresh()
    let snapshot!: WakeSource
    const fake = vi.mocked(globalThis.fetch)
    await runInDurableObject(stub, async instance => { snapshot = source(await instance.saveTimedWake({ title: 'tea', reminder: 'fixture wake text', plan: { type: 'once', at: new Date(Date.now() + 1000).toISOString() } })) })
    await new Promise(resolve => setTimeout(resolve, 2100))
    await runDurableObjectAlarm(stub)
    await runInDurableObject(stub, async instance => {
      const native = instance as unknown as NativeFixture
      await native.native.wait(`wake:${occurrenceKey(snapshot)}`)
      await instance.acceptTimedWake(snapshot)
      const branch = await instance.getBranch()
      expect(branch.entries.filter(entry => entry.wakeSource)).toMatchObject([{ wakeSource: snapshot }])
      expect(branch.entries.filter(entry => entry.message?.role === 'assistant')).toHaveLength(1)
      expect(await instance.listTimedWakes()).toEqual([])
    })
    expect(fake).toHaveBeenCalledTimes(1)
  })
  it.each([59000, 60000, 60001])('uses the native request identity at lateness %i and advances future schedules before model work', async lateness => {
    const stub = await fresh()
    await runInDurableObject(stub, async instance => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const time = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(time)
      try {
        const wake = await instance.saveTimedWake({ title: 'repeat', reminder: 'boundary fixture', plan: { type: 'interval', anchor: new Date(time + 120000).toISOString(), seconds: 60 } })
        const due = { ...wake, nextAt: new Date(time - lateness).toISOString() }
        storage.setSetting('timedWakes', [due])
        const snapshot = source(due)
        await instance.acceptTimedWake(snapshot)
        expect(Date.parse((await instance.listTimedWakes())[0]!.nextAt)).toBeGreaterThan(time)
        if (lateness <= 60000) {
          const operationId = storage.wakeReceipt(snapshot)!
          expect(operationId).toBeTruthy()
          await (instance as unknown as NativeFixture).native.wait(operationId)
          await instance.acceptTimedWake(snapshot)
          expect((await instance.getBranch()).entries.filter(entry => entry.wakeSource)).toHaveLength(1)
        } else {
          expect(storage.wakeReceipt(snapshot)).toBeUndefined()
          expect(storage.entriesInOrder()).toEqual([])
        }
      } finally { clock.mockRestore() }
    })
  })
  it('reconciles a persisted domain wake association against the same native submission after host restart', async () => {
    const stub = await fresh()
    await runInDurableObject(stub, async instance => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const time = Date.now(), wake = await instance.saveTimedWake({ title: 'once', reminder: 'restart fixture', plan: { type: 'once', at: new Date(time + 120000).toISOString() } })
      const due = { ...wake, nextAt: new Date(time - 1000).toISOString() }, snapshot = source(due)
      storage.setSetting('timedWakes', [due])
      await instance.acceptTimedWake(snapshot)
      const operationId = storage.wakeReceipt(snapshot)!
      await (instance as unknown as NativeFixture).native.wait(operationId)
      // Recreate the window where domain acknowledgement was lost after native admission.
      storage.setSetting('pendingWakes', [snapshot])
      await instance.onStart()
      await vi.waitFor(() => expect(storage.getSetting('pendingWakes')).toEqual([]), { timeout: 10000 })
      expect((await instance.getBranch()).entries.filter(entry => entry.wakeSource)).toHaveLength(1)
    })
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1)
  })
})

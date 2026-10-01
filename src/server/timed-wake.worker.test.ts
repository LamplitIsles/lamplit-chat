import { env } from 'cloudflare:workers'
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import type { AgentLane } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import { laneState, pendingEntry } from '@earendil-works/pi-agent-core/harness/session'
import { PiSessionStorage } from './pi-session-storage'
import { prepareOpenOperationResume } from './prompt-lifecycle'
import { nextWake } from './timed-wake'
import type { TimedWake, WakeSource } from '../shared/timed-wake'
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
      if (!url.startsWith('https://example.invalid/')) return original(input, init)
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
  it('uses the SDK alarm to durably accept without a browser, deduplicates and preserves source', async () => {
    const stub = await fresh()
    let snapshot!: WakeSource
    await runInDurableObject(stub, async instance => {
      const wake = await instance.saveTimedWake({ title: 'tea', reminder: 'synthetic reminder', plan: { type: 'once', at: new Date(Date.now() + 1000).toISOString() } })
      snapshot = source(wake)
    })
    await new Promise(resolve => setTimeout(resolve, 2100))
    await runDurableObjectAlarm(stub)
    await runInDurableObject(stub, async (instance, _state) => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const entryId = storage.wakeReceipt(snapshot)!
      expect(entryId).toBeTruthy()
      const pending = storage.getValueSync(pendingEntry(entryId))?.value
      const committed = storage.getEntrySync(entryId)
      expect(pending?.type === 'message' ? pending.payload : committed?.type === 'message' ? committed.message : undefined).toMatchObject({ role: 'custom', details: snapshot })
      await instance.acceptTimedWake(snapshot)
      expect(storage.wakeReceipt(snapshot)).toBe(entryId)
      expect(await instance.listTimedWakes()).toEqual([])
      expect((storage.getValueSync(laneState('main'))?.value.inbox ?? []).length).toBeLessThanOrEqual(1)
    })
    await new Promise(resolve => setTimeout(resolve, 1100))
    await runDurableObjectAlarm(stub)
    await runInDurableObject(stub, async instance => {
      const branch = await instance.getBranch()
      expect(branch.entries.filter(entry => entry.wakeSource)).toHaveLength(1)
      expect(branch.entries.some(entry => entry.message?.role === 'assistant')).toBe(true)
    })
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
  it('advances repeats before model work and recovers accepted custom input without a browser ledger', async () => {
    const stub = await fresh()
    await runInDurableObject(stub, async (instance, _state) => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const wake = await instance.saveTimedWake({ title: 'repeat', reminder: 'synthetic', plan: { type: 'interval', anchor: new Date(Date.now() + 120000).toISOString(), seconds: 60 } })
      const due = { ...wake, nextAt: new Date(Date.now() - 500).toISOString() }
      storage.setSetting('timedWakes', [due])
      await instance.acceptTimedWake(source(due))
      expect(Date.parse((await instance.listTimedWakes())[0].nextAt)).toBeGreaterThan(Date.now())
      const lane = await (instance as unknown as { getLane(): Promise<AgentLane> }).getLane()
      const operationId = crypto.randomUUID()
      expect((await lane.accept({ kind: 'prompt', operationId, prompt: '' }, BACKGROUND_CONTEXT)).ok).toBe(true)
      const { operationMeta } = await import('@earendil-works/pi-agent-core/harness/session')
      expect(await prepareOpenOperationResume(lane, BACKGROUND_CONTEXT, () => undefined,
        async id => (await storage.getValue(operationMeta(id), BACKGROUND_CONTEXT))?.value,
        id => storage.getEntrySync(id), () => { throw new Error('must not use browser ledger') })).toEqual({ operationId, browserPrompt: false })
      expect(storage.entriesInOrder().find(e => e.type === 'message' && e.message.role === 'custom')).toMatchObject({ message: { details: source(due) } })
      // Finish the accepted test-owned operation; actual failure is covered below.
      await lane.drive({ operationId, waitForRetry: true }, BACKGROUND_CONTEXT)
      expect(await instance.listTimedWakes()).toHaveLength(1)
    })
  })
  it('accepts exactly at 60 seconds and skips after lane acquisition without faulting later inputs', async () => {
    const stub = await fresh()
    await runInDurableObject(stub, async instance => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const fixed = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(fixed)
      const wake = await instance.saveTimedWake({ title: 'boundary', reminder: 'synthetic', plan: { type: 'once', at: new Date(fixed + 120000).toISOString() } })
      const due = { ...wake, nextAt: new Date(fixed - 60000).toISOString() }
      storage.setSetting('timedWakes', [due])
      await instance.acceptTimedWake(source(due))
      expect(storage.wakeReceipt(source(due))).toBeTruthy()
      const next = { ...due, id: crypto.randomUUID() }
      storage.setSetting('timedWakes', [next])
      const internal = instance as unknown as { getLane(): Promise<AgentLane> }
      const lane = await internal.getLane()
      const slow = vi.spyOn(internal, 'getLane').mockImplementation(async () => { clock.mockReturnValue(fixed + 1); return lane })
      await instance.acceptTimedWake(source(next))
      expect(storage.wakeReceipt(source(next))).toBeUndefined()
      expect(await instance.listTimedWakes()).toEqual([])
      slow.mockRestore(); clock.mockRestore()
      await expect(lane.inspectExecution(BACKGROUND_CONTEXT)).resolves.toBeDefined()
      await instance.prompt({ send() {}, end() {} } as unknown as Parameters<PiSession['prompt']>[0], { operationId: crypto.randomUUID(), prompt: 'Synthetic question after cutoff' })
      const later = await instance.saveTimedWake({ title: 'later', reminder: 'synthetic', plan: { type: 'once', at: new Date(Date.now() + 120000).toISOString() } })
      const laterDue = { ...later, nextAt: new Date(Date.now() - 500).toISOString() }
      storage.setSetting('timedWakes', [laterDue])
      await instance.acceptTimedWake(source(laterDue)); await instance.drainPendingWork()
      const entries = (await instance.getBranch()).entries
      expect(entries.some(e => e.wakeSource?.wakeId === next.id)).toBe(false)
      expect(entries.some(e => e.wakeSource?.wakeId === later.id)).toBe(true)
      expect(entries.filter(e => e.message?.role === 'assistant')).toHaveLength(2)
    })
  })
  it('waits behind a real in-flight synthetic model answer without interrupting or overlapping it', async () => {
    const stub = await fresh()
    await runInDurableObject(stub, async instance => {
      let release!: () => void
      let requests = 0
      let simultaneous = 0
      let maxSimultaneous = 0
      const completion = (text: string, finish: boolean) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: finish ? {} : { role: 'assistant', content: text }, finish_reason: finish ? 'stop' : null }] })}\n\n`
      const fixtureFetch = vi.mocked(globalThis.fetch).getMockImplementation()!
      const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!url.startsWith('https://example.invalid/') || !(typeof init?.body === 'string' && init.body.includes('Synthetic busy cutoff human question'))) return fixtureFetch(input, init)
        const number = ++requests; simultaneous++; maxSimultaneous = Math.max(maxSimultaneous, simultaneous)
        const body = new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(completion(number === 1 ? 'Human answer' : 'Wake answer', false)))
          const finish = () => { controller.enqueue(new TextEncoder().encode(completion('', true) + 'data: [DONE]\n\n')); controller.close(); simultaneous-- }
          if (number === 1) release = finish; else finish()
        } })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      })
      const answer = instance.prompt({ send() {}, end() {} } as unknown as Parameters<PiSession['prompt']>[0], { operationId: crypto.randomUUID(), prompt: 'Synthetic busy cutoff human question' })
      await vi.waitFor(() => expect(requests).toBe(1))
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const fixed = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(fixed)
      const expired = await instance.saveTimedWake({ title: 'busy expiry', reminder: 'synthetic', plan: { type: 'once', at: new Date(fixed + 120000).toISOString() } })
      const expiredDue = { ...expired, nextAt: new Date(fixed - 60000).toISOString() }
      storage.setSetting('timedWakes', [expiredDue])
      const internal = instance as unknown as { getLane(): Promise<AgentLane> }
      const lane = await internal.getLane()
      const slow = vi.spyOn(internal, 'getLane').mockImplementation(async () => { clock.mockReturnValue(fixed + 1); return lane })
      await instance.acceptTimedWake(source(expiredDue))
      expect(storage.wakeReceipt(source(expiredDue))).toBeUndefined()
      expect(await instance.listTimedWakes()).toEqual([])
      await expect(lane.inspectExecution(BACKGROUND_CONTEXT)).resolves.toMatchObject({ current: expect.anything() })
      slow.mockRestore(); clock.mockRestore()
      const wake = await instance.saveTimedWake({ title: 'busy', reminder: 'synthetic', plan: { type: 'once', at: new Date(Date.now() + 120000).toISOString() } })
      const due = { ...wake, nextAt: new Date(Date.now() - 500).toISOString() }
      storage.setSetting('timedWakes', [due])
      await instance.acceptTimedWake(source(due))
      await instance.drainPendingWork()
      expect(requests).toBe(1)
      expect(storage.wakeReceipt(source(due))).toBeTruthy()
      release(); await answer
      await instance.drainPendingWork()
      expect(requests).toBe(2); expect(maxSimultaneous).toBe(1)
      const branch = await instance.getBranch()
      expect(branch.entries.filter(e => e.wakeSource)).toHaveLength(1)
      expect(branch.entries.filter(e => e.message?.role === 'assistant').map(e => e.message?.content)).toEqual(expect.arrayContaining([
        expect.arrayContaining([expect.objectContaining({ text: 'Human answer' })]), expect.arrayContaining([expect.objectContaining({ text: 'Wake answer' })]),
      ]))
      mock.mockRestore()
    })
  })
  it('runs through Pi after restart and keeps the next SDK schedule through actual model failure', async () => {
    const stub = await fresh()
    await runInDurableObject(stub, async instance => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const wake = await instance.saveTimedWake({ title: 'failure', reminder: 'synthetic', plan: { type: 'interval', anchor: new Date(Date.now() + 120000).toISOString(), seconds: 60 } })
      const due = { ...wake, nextAt: new Date(Date.now() - 500).toISOString() }
      storage.setSetting('timedWakes', [due])
      await instance.acceptTimedWake(source(due))
      const next = (await instance.listTimedWakes())[0]
      const fail = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Synthetic failure', { status: 400 }))
      await instance.drainPendingWork()
      expect(fail).toHaveBeenCalled()
      expect(await instance.listTimedWakes()).toEqual([next])
      expect((await instance.listSchedules()).some(s => s.callback === 'acceptTimedWake' && (s.payload as WakeSource).scheduledAt === next.nextAt)).toBe(true)
      const recovered = new PiSessionStorage((instance as unknown as { ctx: DurableObjectState }).ctx.storage)
      expect(recovered.wakeReceipt(source(due))).toBe(storage.wakeReceipt(source(due)))
      expect((await instance.getBranch()).entries.filter(e => e.wakeSource)).toHaveLength(1)
      await instance.acceptTimedWake(source(due))
      expect((await instance.getBranch()).entries.filter(e => e.wakeSource)).toHaveLength(1)
      fail.mockRestore()
      // Reconstruct the process after losing registration, retaining accepted history/settings.
      for (const scheduled of await instance.listSchedules()) if (scheduled.callback === 'acceptTimedWake') await instance.cancelSchedule(scheduled.id)
      const internal = instance as unknown as { sessionStorage: PiSessionStorage; coreSession?: unknown; harness?: unknown }
      internal.sessionStorage = recovered; internal.coreSession = undefined; internal.harness = undefined
      await instance.onStart()
      await vi.waitFor(async () => expect((await instance.listSchedules()).some(s => s.callback === 'acceptTimedWake' && (s.payload as WakeSource).scheduledAt === next.nextAt)).toBe(true))
    })
  })
  it('reconstructs an accepted occurrence and resumes beyond the lateness window without a browser ledger', async () => {
    const stub = await fresh()
    await runInDurableObject(stub, async (instance, state) => {
      const internal = instance as unknown as {
        getLane(): Promise<AgentLane>; sessionStorage: PiSessionStorage; coreSession?: unknown; harness?: unknown; active: boolean
      }
      const wake = await instance.saveTimedWake({ title: 'restart', reminder: 'synthetic restart', plan: { type: 'once', at: new Date(Date.now() + 120000).toISOString() } })
      const due = { ...wake, nextAt: new Date(Date.now() - 500).toISOString() }
      internal.sessionStorage.setSetting('timedWakes', [due])
      await instance.acceptTimedWake(source(due))
      const lane = await internal.getLane()
      expect((await lane.accept({ kind: 'prompt', operationId: crypto.randomUUID(), prompt: '' }, BACKGROUND_CONTEXT)).ok).toBe(true)
      internal.sessionStorage = new PiSessionStorage(state.storage)
      internal.coreSession = undefined; internal.harness = undefined
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000)
      await instance.onStart()
      await vi.waitFor(() => expect(internal.active).toBe(false))
      clock.mockRestore()
      const branch = await instance.getBranch()
      expect(branch.entries.filter(entry => entry.wakeSource)).toHaveLength(1)
      expect(branch.entries.some(entry => entry.message?.role === 'assistant')).toBe(true)
      await instance.acceptTimedWake(source(due))
      expect((await instance.getBranch()).entries.filter(entry => entry.wakeSource)).toHaveLength(1)
    })
  })
  it('allows in-window public admission to commit across the deadline without fault or duplicate', async () => {
    const stub = await fresh()
    await runInDurableObject(stub, async instance => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const fixed = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(fixed)
      const wake = await instance.saveTimedWake({ title: 'commit crossing', reminder: 'synthetic', plan: { type: 'once', at: new Date(fixed + 120000).toISOString() } })
      const due = { ...wake, nextAt: new Date(fixed - 60000).toISOString() }
      storage.setSetting('timedWakes', [due])
      const originalCommit = storage.commit.bind(storage)
      const delayed = vi.spyOn(storage, 'commit').mockImplementation(async (...args) => {
        if (args[0].some(w => w.kind === 'value' && w.op === 'set' && w.namespace === pendingEntry('').namespace && w.key.startsWith(pendingEntry('').key))) clock.mockReturnValue(fixed + 1)
        return originalCommit(...args)
      })
      await instance.acceptTimedWake(source(due))
      const receipt = storage.wakeReceipt(source(due))
      expect(receipt).toBeTruthy()
      await instance.acceptTimedWake(source(due))
      expect(storage.wakeReceipt(source(due))).toBe(receipt)
      delayed.mockRestore(); clock.mockRestore()
      await instance.drainPendingWork()
      const branch = await instance.getBranch()
      expect(branch.entries.filter(e => e.wakeSource)).toHaveLength(1)
      expect(branch.entries.filter(e => e.message?.role === 'assistant')).toHaveLength(1)
      await instance.prompt({ send() {}, end() {} } as unknown as Parameters<PiSession['prompt']>[0], { operationId: crypto.randomUUID(), prompt: 'Synthetic question after acceptance' })
      expect((await instance.getBranch()).entries.filter(e => e.message?.role === 'assistant')).toHaveLength(2)
    })
  })
  it('blocks busy followUp generation until its next SDK schedule is registered', async () => {
    const stub = await fresh()
    await runInDurableObject(stub, async instance => {
      let finishHuman!: () => void, allowSchedule!: () => void
      let requests = 0, registrationWaiting = false, registeredAtWakeRequest = false
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      const chunk = (text: string, done: boolean) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: done ? {} : { role: 'assistant', content: text }, finish_reason: done ? 'stop' : null }] })}\n\n`
      const fixtureFetch = vi.mocked(globalThis.fetch).getMockImplementation()!
      const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!url.startsWith('https://example.invalid/') || !(typeof init?.body === 'string' && init.body.includes('Synthetic registration race human question'))) return fixtureFetch(input, init)
        const number = ++requests
        if (number >= 2) {
          const next = storage.timedWakes()[0]
          registeredAtWakeRequest = (await instance.listSchedules()).some(s => s.callback === 'acceptTimedWake' && (s.payload as WakeSource).scheduledAt === next.nextAt)
          return new Response('Synthetic wake model failure', { status: 400 })
        }
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk('Human answer', false)))
          finishHuman = () => { controller.enqueue(new TextEncoder().encode(chunk('', true) + 'data: [DONE]\n\n')); controller.close() }
        } }), { headers: { 'content-type': 'text/event-stream' } })
      })
      const answer = instance.prompt({ send() {}, end() {} } as unknown as Parameters<PiSession['prompt']>[0], { operationId: crypto.randomUUID(), prompt: 'Synthetic registration race human question' })
      await vi.waitFor(() => expect(requests).toBe(1))
      const wake = await instance.saveTimedWake({ title: 'registration race', reminder: 'synthetic', plan: { type: 'interval', anchor: new Date(Date.now() + 120000).toISOString(), seconds: 60 } })
      const due = { ...wake, nextAt: new Date(Date.now() - 500).toISOString() }
      storage.setSetting('timedWakes', [due])
      for (const scheduled of await instance.listSchedules()) if (scheduled.callback === 'acceptTimedWake') await instance.cancelSchedule(scheduled.id)
      const originalSchedule = instance.schedule.bind(instance)
      const schedule = vi.spyOn(instance, 'schedule').mockImplementation(async (...args) => {
        if (args[1] === 'acceptTimedWake' && !registrationWaiting) {
          registrationWaiting = true
          await new Promise<void>(resolve => { allowSchedule = resolve })
        }
        return originalSchedule(...args)
      })
      const acceptance = instance.acceptTimedWake(source(due))
      await vi.waitFor(() => expect(registrationWaiting).toBe(true))
      finishHuman()
      await vi.waitFor(() => expect(storage.entriesInOrder().some(e => e.type === 'message' && e.message.role === 'custom')).toBe(true))
      // The continuation has consumed the input, but cannot call the model while insertion is gated.
      await new Promise(resolve => setTimeout(resolve, 50))
      const prematureRequests = requests
      allowSchedule()
      await acceptance; await answer
      await instance.drainPendingWork()
      expect(prematureRequests).toBe(1)
      expect(requests).toBe(2)
      expect(registeredAtWakeRequest).toBe(true)
      const next = storage.timedWakes()[0]
      expect((await instance.listSchedules()).some(s => s.callback === 'acceptTimedWake' && (s.payload as WakeSource).scheduledAt === next.nextAt)).toBe(true)
      schedule.mockRestore(); mock.mockRestore()
    })
  })
  it('calculates real timezone and DST dates in workerd without a timer', () => {
    expect(nextWake({ type: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, Date.parse('2026-01-01T00:00:00Z'))).toBe('2026-01-01T01:00:00.000Z')
    expect(nextWake({ type: 'daily', time: '02:30', timeZone: 'America/New_York' }, Date.parse('2026-03-08T05:00:00Z'))).toBe('2026-03-08T07:30:00.000Z')
    expect(nextWake({ type: 'daily', time: '01:30', timeZone: 'America/New_York' }, Date.parse('2026-11-01T05:30:00Z'))).toBe('2026-11-02T06:30:00.000Z')
    expect(nextWake({ type: 'weekly', weekday: 0, time: '09:00', timeZone: 'Europe/Berlin' }, Date.parse('2026-03-28T12:00:00Z'))).toBe('2026-03-29T07:00:00.000Z')
  })
})

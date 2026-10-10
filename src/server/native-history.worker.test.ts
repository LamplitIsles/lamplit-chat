import { nativeReply } from './fixtures/native-provider'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import type { NativeFixture } from './fixtures/native-session'
import worker from '../server'

it('reads stable bounded native pages through the real socket without mirroring history', async () => {
  const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external requests authorized'))
  const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
  const created = await registry.createSession({ name: 'Native history' })
  const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
  const texts = Array.from({ length: 95 }, (_, i) => `original ${i}`)
  await runInDurableObject(stub, async instance => {
    const fixture = instance as unknown as NativeFixture
    const lane = await fixture.getLane()
    await lane.commit(async tx => {
      for (let i = 0; i < texts.length; i++) {
        await tx.appendEntry(lane.id, { kind: 'pi.user', model: [{ role: 'user', content: texts[i], timestamp: 1700000000000 + i }] })
        if (i === 35) await tx.appendEntry(lane.id, { kind: 'pi.compaction', head: 'self', model: [{ role: 'user', content: 'silent checkpoint', timestamp: 1700000000035 }] })
        if (i === 70) await tx.appendEntry(lane.id, { kind: 'pi.reset', head: 'self', model: [] })
        if (i % 10 === 0) await tx.appendEntry(lane.id, { kind: 'pi.system', model: [{ role: 'system', content: '', sections: {}, timestamp: 1 }] })
      }
      await tx.appendEntry(lane.id, { kind: 'pi.assistant', model: [{ ...fauxAssistantMessage('last answer'), timestamp: 1700000000100 }] })
    }, fixture.nativeContext)
  })
  let socket: WebSocket | undefined
  let client: Awaited<ReturnType<typeof openChat>> | undefined
  let latestView: ChatView | undefined
  const connect = async () => {
    let view: ChatView | undefined
    const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), { ...env, COMPANION_SESSION_ID: created.id } as Env)
    expect(response.status).toBe(101)
    socket = response.webSocket!; socket.accept()
    client = await openChat(socket, next => { view = next; latestView = next }, () => {})
    return view!
  }
  try {
    const initial = await connect()
    expect(initial.messages.length).toBeLessThanOrEqual(30)
    let before = initial.before
    const messages = [...initial.messages]
    expect(before).not.toBeNull()
    await runInDurableObject(stub, async instance => {
      const f = instance as unknown as NativeFixture
      const lane = await f.getLane(); await lane.commit(async tx => { await tx.appendEntry(lane.id, { kind: 'pi.user', model: [{ role: 'user', content: 'concurrent append', timestamp: 1700000000200 }] }) }, f.nativeContext)
    })
    while (before) {
      const page = await client!.history(before)
      expect(page.messages.length).toBeLessThanOrEqual(30)
      messages.unshift(...page.messages); before = page.before
    }
    expect(messages.map(m => m.text)).toEqual([...texts, 'last answer'])
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length)
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM conversation_archive').one().n).toBe(0)
    })
    client!.close(); socket!.close()
    await connect()
    // The shared host initially publishes its captured snapshot, then refreshes.
    await vi.waitFor(() => expect(latestView?.messages.at(-1)?.text).toBe('concurrent append'), { timeout: 2000 })
    expect(outbound).not.toHaveBeenCalled()
  } finally { client?.close(); socket?.close(); outbound.mockRestore() }
})

it('keeps per-record continuation across a multi-message entry and advances empty system pages', async () => {
  const stub = env.PiSession.getByName('native-many-models') as DurableObjectStub<PiSession>
  await runInDurableObject(stub, async (instance, state) => {
    await instance.initialize({ id: 'native-many-models', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lineage: { type: 'new' } })
    const f = instance as unknown as NativeFixture
    const lane = await f.getLane()
    const { NativeHistory } = await import('./native-history')
    const { PiSessionStorage } = await import('./pi-session-storage')
    const texts = Array.from({ length: 73 }, (_, i) => `block ${i}`)
    await lane.commit(async tx => {
      await tx.appendEntry(lane.id, { kind: 'fictional.multi', model: texts.map((content, i) => ({ role: 'user', content, timestamp: 1000 + i })) })
      for (let i = 0; i < 65; i++) await tx.appendEntry(lane.id, { kind: 'pi.system', model: [{ role: 'system', content: '', sections: {}, timestamp: 1 }] })
    }, f.nativeContext)
    const reader = new NativeHistory(new PiSessionStorage(state.storage), lane, f.nativeContext)
    let page = await reader.page()
    expect(page.entries).toEqual([])
    expect(page.before).not.toBeNull()
    const entries = [...page.entries]
    let pages = 1
    while (page.before) { expect(page.before.length).toBeLessThanOrEqual(300); page = await reader.page(page.before); entries.unshift(...page.entries); expect(page.entries.length).toBeLessThanOrEqual(30); pages++ }
    expect(pages).toBeGreaterThanOrEqual(5)
    expect(entries.map(entry => entry.type === 'message' ? entry.message.content : '')).toEqual(texts)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(73)
    await expect(reader.page('malformed')).rejects.toThrow('Invalid history cursor')
    const other = new NativeHistory(new PiSessionStorage(state.storage), lane, f.nativeContext)
    const first = await other.page()
    const [payload, signature] = first.before!.split('.')
    const token = JSON.parse(atob(payload)); token[0] = 'different-session'
    await expect(reader.page(`${btoa(JSON.stringify(token))}.${signature}`)).rejects.toThrow('Invalid history cursor')
  })
})

it('keeps unchanged application SQLite and public page work bounded as native history grows', async () => {
  const measurements: Array<{ rows: number; queries: number; nativePages: number }> = []
  for (const count of [60, 600]) {
    const stub = env.PiSession.getByName(`bounded-history-${count}`) as DurableObjectStub<PiSession>
    const measurement = await runInDurableObject(stub, async (instance, state) => {
      await instance.initialize({ id: `bounded-history-${count}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lineage: { type: 'new' } })
      const f = instance as unknown as NativeFixture
      const lane = await f.getLane()
      await lane.commit(async tx => { for (let i = 0; i < count; i++) await tx.appendEntry(lane.id, { kind: 'pi.user', model: [{ role: 'user', content: `bounded ${i}`, timestamp: i }] }) }, f.nativeContext)
      await instance.getBranch() // Explicit warmup; native cold open is outside measured application phase.
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = []
      const original = state.storage.sql.exec.bind(state.storage.sql)
      const sql = vi.spyOn(state.storage.sql, 'exec').mockImplementation((query, ...bindings) => {
        const cursor = original(query, ...bindings)
        if (/conversation_archive|native_entry_ids|chat_submissions|pi_session_|conversation_photos|keet_|external_native_inputs|native_history_refs/.test(query)) cursors.push(cursor)
        return cursor
      })
      let nativePages = 0
      const resolve = f.getLane.bind(f)
      const pages = vi.spyOn(f, 'getLane').mockImplementation(async () => {
        const actual = await resolve()
        const entries = actual.entries.bind(actual)
        vi.spyOn(actual, 'entries').mockImplementation((...args) => { nativePages++; return entries(...args) })
        return actual
      })
      try {
        const branch = await instance.getBranch()
        expect(branch.entries).toHaveLength(30)
        return { rows: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0), queries: cursors.length, nativePages }
      } finally { sql.mockRestore(); pages.mockRestore() }
    })
    measurements.push(measurement)
  }
  expect(measurements[1].rows).toBeLessThanOrEqual(measurements[0].rows + 5)
  expect(measurements[1].queries).toBeLessThanOrEqual(measurements[0].queries + 5)
  expect(measurements[0].nativePages).toBe(31)
  expect(measurements[1].nativePages).toBe(31)
  await fetch('https://native-history.fixture.invalid/counters', { method: 'POST', body: JSON.stringify({ phase: 'unchanged warm branch', nativeRecords: [60, 600], measurements }) })
})

it('indexes and reads original native text and summaries without replay and retires completed memory candidates', async () => {
  const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
  const created = await registry.createSession({ name: 'Native index' })
  const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
  let userId = ''
  await runInDurableObject(stub, async instance => {
    const f = instance as unknown as NativeFixture
    const lane = await f.getLane()
    await lane.commit(async tx => {
      userId = `native:${(await tx.appendEntry(lane.id, { kind: 'pi.user', model: [{ role: 'user', content: 'original unique moonflower', timestamp: 1700000000000 }] })).id}`
      await tx.appendEntry(lane.id, { kind: 'pi.compaction', head: 'self', model: [{ role: 'user', content: 'summary unique heliotrope', timestamp: 1700000000001 }] })
      await tx.appendEntry(lane.id, { kind: 'pi.user', model: [{ role: 'user', content: 'tail original context', timestamp: 1700000000002 }] })
    }, f.nativeContext)
  })
  const events = await stub.flushOutbox()
  expect(events.filter(event => event.type === 'message')).toHaveLength(3)
  await registry.applyIndexEvents(created.id, events)
  await stub.acknowledgeOutbox(events.map(event => event.eventId))
  expect((await registry.search({ query: 'moonflower' })).hits).toMatchObject([{ kind: 'message' }])
  expect((await registry.search({ query: 'heliotrope' })).hits).toMatchObject([{ kind: 'compaction' }])
  const read = await stub.readSearchRecord(userId)
  expect(read.record).toMatchObject({ content: 'original unique moonflower', createdAt: '2023-11-14T22:13:20.000Z' })
  expect(read.context.items.map(item => item.content)).toEqual(['original unique moonflower', 'summary unique heliotrope', 'tail original context'])
  expect(await stub.flushOutbox()).toEqual([])
  const memoryRequests: unknown[] = []
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!(input instanceof Request ? input.url : input.toString()).includes('openrouter.ai')) throw new Error('Unmatched external request denied')
    memoryRequests.push(JSON.parse(init!.body as string))
    return nativeReply('openrouter', '', { name: 'record_memory_changes', arguments: { operations: [] } })
  })
  try {
    await runInDurableObject(stub, async instance => {
      await (instance as unknown as { extractNextMemoryBatch(): Promise<void> }).extractNextMemoryBatch()
      const f = instance as unknown as NativeFixture
      await f.native.dispose()
      await instance.getBranch()
      await (instance as unknown as { extractNextMemoryBatch(): Promise<void> }).extractNextMemoryBatch()
    })
    expect(memoryRequests).toHaveLength(1)
    expect(JSON.stringify(memoryRequests[0])).toContain('original unique moonflower')
  } finally { provider.mockRestore() }
})

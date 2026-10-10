import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView, ChatMessage } from '@lamplit/contracts'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import type { NativeFixture } from './fixtures/native-session'
import { nativeReply } from './fixtures/native-provider'
import worker from '../server'

async function session() {
  const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
  const created = await registry.createSession({ name: 'Deterministic history repair' })
  const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
  await runInDurableObject(stub, instance => {
    vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
  })
  return { registry, stub, id: created.id }
}

it('publishes a captured queued input once when native placement occurs between pending and page reads', async () => {
  const { stub, id } = await session()
  const views: ChatView[] = []
  const response = await worker.fetch(new Request('https://repair.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://repair.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), { ...env, COMPANION_SESSION_ID: id } as Env)
  const socket = response.webSocket!; socket.accept()
  const client = await openChat(socket, view => views.push(view), () => {})
  let release: (() => void) | undefined
  let first = true
  const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (!(input instanceof Request ? input.url : input.toString()).includes('openrouter.ai')) throw new Error('Unmatched external request denied')
    const reply = nativeReply('openrouter', 'Fixture answer')
    if (!first) return reply
    first = false
    const bytes = await reply.arrayBuffer()
    return new Response(new ReadableStream({ start(controller) { release = () => { controller.enqueue(new Uint8Array(bytes)); controller.close(); release = undefined } } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const active = crypto.randomUUID(), queued = crypto.randomUUID()
  try {
    await client.submit({ operationId: active, text: 'held generation' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await client.submit({ operationId: queued, text: 'exact queued original' })).toMatchObject({ state: 'submitted', messageId: null })
    await runInDurableObject(stub, async instance => {
      const f = instance as unknown as NativeFixture & { pendingChatMessages(): Promise<ChatMessage[]>; getChatHost(): Promise<{ refresh(): Promise<void> }> }
      const pending = f.pendingChatMessages.bind(f)
      vi.spyOn(f, 'pendingChatMessages').mockImplementationOnce(async () => {
        const captured = await pending()
        expect(captured.some(message => message.operationId === queued)).toBe(true)
        release!()
        await f.native.wait(queued)
        return captured
      })
      await (await f.getChatHost()).refresh()
    })
    await vi.waitFor(() => expect(views.at(-1)?.messages.some(message => message.operationId === queued)).toBe(true))
    for (const view of views) expect(new Set(view.messages.map(message => message.id)).size).toBe(view.messages.length)
    expect(views.at(-1)?.messages.filter(message => message.operationId === queued)).toMatchObject([{ text: 'exact queued original', id: `submission:${queued}` }])
    expect(await stub.chatRecovery()).toEqual([])
    expect(await client.lookup(queued)).toMatchObject({ state: 'submitted', messageId: `submission:${queued}` })
  } finally {
    await runInDurableObject(stub, async instance => { release?.(); await (instance as unknown as NativeFixture).native.wait(active) })
    client.close(); socket.close(); fake.mockRestore(); vi.restoreAllMocks()
  }
})

async function seed(stub: DurableObjectStub<PiSession>, count: number) {
  await runInDurableObject(stub, async instance => {
    const f = instance as unknown as NativeFixture
    const lane = await f.getLane()
    await lane.commit(async tx => {
      for (let i = 0; i < count; i++) await tx.appendEntry(lane.id, { kind: 'pi.user', model: [{ role: 'user', content: `fixture durable preference ${i}`, timestamp: 1700000000000 + i }] })
    }, f.nativeContext)
  })
}

it('delivers each bounded observation count across reopen and keeps exact batch retries idempotent', async () => {
  const { stub, registry, id } = await session()
  await seed(stub, 70)
  const identities: string[] = []
  for (const count of [30, 60, 70]) {
    const events = await stub.flushOutbox()
    expect(events.filter(event => event.type === 'message').length).toBeLessThanOrEqual(30)
    identities.push(events.find(event => event.type === 'touch')!.eventId)
    await registry.applyIndexEvents(id, events)
    await registry.applyIndexEvents(id, events) // Lost acknowledgement: exact batch retry.
    expect((await registry.listSessions()).find(summary => summary.id === id)?.messageCount).toBe(count)
    await stub.acknowledgeOutbox(events.map(event => event.eventId))
    await runInDurableObject(stub, instance => (instance as unknown as NativeFixture).native.dispose())
  }
  expect(new Set(identities).size).toBe(3)
  expect(await stub.flushOutbox()).toEqual([])
  vi.restoreAllMocks()
})

it('extracts only indexed sources, drains bounded remaining batches and does not repeat after reopen', async () => {
  const { stub, registry, id } = await session()
  await seed(stub, 60)
  const first = await stub.flushOutbox()
  await registry.applyIndexEvents(id, first)
  await stub.acknowledgeOutbox(first.map(event => event.eventId))
  // Drive the batches explicitly; scheduled indexing must not change the retry fixture.
  await runInDurableObject(stub, async instance => { for (const job of await instance.listSchedules()) await instance.cancelSchedule(job.id) })
  const sources: string[][] = []
  const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!(input instanceof Request ? input.url : input.toString()).includes('openrouter.ai')) throw new Error('Unmatched external request denied')
    const request = JSON.parse(init!.body as string)
    const content = request.messages.at(-1).content
    const entries = JSON.parse(typeof content === 'string' ? content : content[0].text).newTranscriptEntries as Array<{ id: string }>
    sources.push(entries.map(entry => entry.id))
    return nativeReply('openrouter', '', { name: 'record_memory_changes', arguments: { operations: [{ action: 'add', kind: 'preference', content: `Fixture preference from ${entries[0].id}`, sourceEntryId: entries[0].id }] } })
  })
  const extract = () => runInDurableObject(stub, instance => (instance as unknown as { extractNextMemoryBatch(): Promise<void> }).extractNextMemoryBatch())
  try {
    await runInDurableObject(stub, instance => {
      const store = (instance as unknown as { sessionStorage: import('./pi-session-storage').PiSessionStorage }).sessionStorage
      const acknowledge = store.acknowledgeReferences.bind(store)
      vi.spyOn(store, 'acknowledgeReferences').mockImplementationOnce((kind, ids) => {
        if (kind === 'memorized') throw new Error('Test-owned lost memory acknowledgement')
        acknowledge(kind, ids)
      })
    })
    await expect(extract()).rejects.toThrow('Test-owned lost memory acknowledgement')
    expect((await registry.listMemories()).filter(memory => memory.sourceSessionId === id)).toHaveLength(1)
    await runInDurableObject(stub, instance => (instance as unknown as NativeFixture).native.dispose())
    await extract()
    expect(sources[0]).toHaveLength(30)
    expect(sources[1]).toEqual(sources[0])
    expect((await registry.listMemories()).filter(memory => memory.sourceSessionId === id)).toHaveLength(1)
    const second = await stub.flushOutbox()
    await registry.applyIndexEvents(id, second)
    await stub.acknowledgeOutbox(second.map(event => event.eventId))
    await extract()
    expect(sources[2]).toHaveLength(30)
    expect(new Set(sources.flat()).size).toBe(60)
    expect((await registry.listMemories()).filter(memory => memory.sourceSessionId === id)).toHaveLength(2)
    await runInDurableObject(stub, instance => (instance as unknown as NativeFixture).native.dispose())
    await runInDurableObject(stub, instance => instance.getBranch()) // Reads cannot initiate extraction.
    await extract()
    expect(fake).toHaveBeenCalledTimes(3)
    expect((await registry.listMemories()).filter(memory => memory.sourceSessionId === id)).toHaveLength(2)
  } finally { fake.mockRestore(); vi.restoreAllMocks() }
})

it('keeps older recovery and reconciliation reachable behind retained consumed drafts without replaying unknown admissions', async () => {
  const { stub } = await session()
  const { PiSessionStorage } = await import('./pi-session-storage')
  const older = crypto.randomUUID()
  const unknown = Array.from({ length: 25 }, () => crypto.randomUUID())
  await runInDurableObject(stub, (_instance, state) => {
    const store = new PiSessionStorage(state.storage)
    store.recordChat(older, { operationId: older, text: 'immutable withdrawn original', turnId: older, rejected: true })
    store.withdrawInput(older)
    for (const id of unknown) store.recordChat(id, { operationId: id, text: 'unknown original retained', turnId: id })
    for (let i = 0; i < 21; i++) {
      const id = crypto.randomUUID()
      store.recordChat(id, { operationId: id, text: 'immutable consumed original', turnId: id, rejected: true })
      store.withdrawInput(id); store.markReplaced(id)
    }
  })
  const fake = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external requests authorized'))
  try {
    expect(await stub.chatRecovery()).toMatchObject([{ sourceId: older, text: 'immutable withdrawn original', replacementEligible: true }])
    await runInDurableObject(stub, async (instance, state) => {
      const lookup = instance.lookupChat.bind(instance)
      const inspected: string[] = []
      vi.spyOn(instance, 'lookupChat').mockImplementation(async id => { inspected.push(id); return lookup(id) })
      for (let i = 0; i < 3; i++) await instance.getBranch()
      expect(unknown.every(id => inspected.includes(id))).toBe(true)
      const f = instance as unknown as NativeFixture
      const lane = await f.getLane()
      expect((await lane.entries({}, 30, undefined, f.nativeContext)).items.some(entry => entry.kind === 'pi.user')).toBe(false)
      const store = new PiSessionStorage(state.storage)
      expect(store.chatRecords().size).toBe(47)
      expect(store.chatRecord(older)?.text).toBe('immutable withdrawn original')
    })
    expect(fake).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks() }
})

it('bounds real socket presentation, observation and consecutive pages with settled source and media metadata', async () => {
  const { PiSessionStorage } = await import('./pi-session-storage')
  type Counters = { phase: string; rows: number; writes: number; queries: number; nativePages: number; otherRows: number; inputEntriesWrites: number }
  const measurements: Counters[][] = []
  for (const count of [60, 600]) {
    const { stub, id } = await session()
    const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (!(input instanceof Request ? input.url : input.toString()).includes('openrouter.ai')) throw new Error('Unmatched external request denied')
      return nativeReply('openrouter', 'Actual settled operation reply')
    })
    await runInDurableObject(stub, async (instance, state) => {
      const f = instance as unknown as NativeFixture
      const operationId = crypto.randomUUID()
      await instance.submitChat({ operationId, text: 'Actual settled operation' })
      await f.native.wait(operationId); await instance.lookupChat(operationId)
      const store = new PiSessionStorage(state.storage), lane = await f.getLane()
      const inputEntries: Record<string, string> = {}
      await lane.commit(async tx => {
        for (let i = 0; i < count; i++) {
          const operation = crypto.randomUUID(), timestamp = 1700000000000 + i
          const entryId = `native:${(await tx.appendEntry(lane.id, { kind: 'pi.user', model: [{ role: 'user', content: `private native input ${i}`, timestamp }] })).id}`
          // Test-owned settled associations use actual native IDs, not guessed bodies/times.
          store.recordChat(operation, { operationId: operation, text: '', turnId: operation, entryId, createdAt: timestamp })
          store.correlateInput(operation, entryId); inputEntries[operation] = entryId
          if (i % 5 === 0) {
            await store.admitKeet({ type: 'message', eventId: crypto.randomUUID(), sequence: i + 1, messageId: { deviceId: 'fictional-device', seq: i + 1 }, timestamp, destination: { groupName: 'Fixture room', kind: 'group' }, senderLabel: 'Fixture sender', text: `public source body ${i}`, addressing: { mentionsIdentity: true } })
            const sequence = store.nextKeet()!.sequence
            store.acceptKeet(sequence, entryId); store.settleKeet(sequence)
            const photo = { id: crypto.randomUUID(), operationId: operation, name: 'fixture.jpg', mediaType: 'image/jpeg', created: timestamp, order: 0 }
            store.reservePhoto(photo, 'fictional-fingerprint', 6); store.completePhoto(photo.id, 'fictional-fingerprint'); store.freezePhotos(operation, [photo.id]); store.acceptPhotos(operation, entryId)
            for (const variant of ['original', 'preview']) await env.COMPUTER_R2!.put(`conversation-photos/${id}/${photo.id}/${variant}`, new Uint8Array([255,216,255,0,255,217]))
          }
        }
      }, f.nativeContext)
      store.setSetting('inputEntries', inputEntries) // Existing aggregate metadata must never be rewritten by reads.
      await f.native.dispose()
    })
    const cursors: Array<{ cursor: SqlStorageCursor<Record<string, SqlStorageValue>>; app: boolean; inputEntriesWrite: boolean }> = []
    let nativePages = 0
    await runInDurableObject(stub, (instance, state) => {
      const original = state.storage.sql.exec.bind(state.storage.sql)
      vi.spyOn(state.storage.sql, 'exec').mockImplementation((query, ...bindings) => {
        const cursor = original(query, ...bindings)
        cursors.push({ cursor, app: /conversation_archive|native_entry_ids|chat_submissions|chat_replaced|pi_session_|conversation_photos|keet_|external_native_inputs|native_history_refs/.test(query), inputEntriesWrite: /INSERT|UPDATE|DELETE/i.test(query) && /pi_session_settings/.test(query) && (bindings.includes('inputEntries') || /'inputEntries'/.test(query)) })
        return cursor
      })
      const f = instance as unknown as NativeFixture, resolve = f.getLane.bind(f)
      const wrapped = new WeakSet<object>()
      vi.spyOn(f, 'getLane').mockImplementation(async () => {
        const lane = await resolve()
        if (!wrapped.has(lane)) {
          wrapped.add(lane)
          const entries = lane.entries.bind(lane)
          vi.spyOn(lane, 'entries').mockImplementation((...args) => { nativePages++; expect(args[1]).toBeLessThanOrEqual(30); return entries(...args) })
        }
        return lane
      })
    })
    const phases: Counters[] = []
    const capture = (phase: string) => runInDurableObject(stub, () => {
      const application = cursors.filter(item => item.app)
      phases.push({ phase, rows: application.reduce((sum, item) => sum + item.cursor.rowsRead, 0), writes: application.reduce((sum, item) => sum + item.cursor.rowsWritten, 0), queries: application.length, nativePages, otherRows: cursors.filter(item => !item.app).reduce((sum, item) => sum + item.cursor.rowsRead, 0), inputEntriesWrites: cursors.filter(item => item.inputEntriesWrite).reduce((sum, item) => sum + item.cursor.rowsWritten, 0) })
      cursors.length = 0; nativePages = 0
    })
    await runInDurableObject(stub, async instance => { const f = instance as unknown as NativeFixture; const lane = await f.getLane(); await lane.context(f.nativeContext) })
    await capture('native cold reopen and context')
    let view: ChatView | undefined
    const response = await worker.fetch(new Request('https://repair.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://repair.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), { ...env, COMPANION_SESSION_ID: id } as Env)
    const socket = response.webSocket!; socket.accept()
    const client = await openChat(socket, next => { view = next }, () => {})
    try {
      expect(view!.messages.some(message => message.source?.kind === 'keet' && message.text.startsWith('public source body'))).toBe(true)
      expect(view!.messages.some(message => message.images?.some(image => image.availability === 'available'))).toBe(true)
      await capture('socket presentation and observation')
      let before = view!.before!
      for (let page = 0; page < 2; page++) {
        const next = await client.history(before)
        expect(next.messages).toHaveLength(15); expect(next.before).not.toBeNull()
        before = next.before!
        await capture(`consecutive page ${page + 1}`)
      }
      await runInDurableObject(stub, async instance => { await (await (instance as unknown as { getChatHost(): Promise<{ refresh(): Promise<void> }> }).getChatHost()).refresh() })
      await capture('unchanged warm socket observation')
      expect(fake).toHaveBeenCalledTimes(1) // History/observation never invoke a model.
      expect(phases.every(phase => phase.inputEntriesWrites === 0)).toBe(true)
      measurements.push(phases)
    } finally { client.close(); socket.close(); vi.restoreAllMocks() }
  }
  await fetch('https://native-history.fixture.invalid/counters', { method: 'POST', body: JSON.stringify({ phase: 'socket/source/media repair acceptance', nativeFixtureRecords: [60, 600], measurements }) })
  for (let phase = 1; phase < measurements[0].length; phase++) {
    // Indexed photo and submission lookups have a few additional SQLite index reads
    // at larger cardinality; initial connection performs two presentations.
    expect(measurements[1][phase].rows).toBeLessThanOrEqual(measurements[0][phase].rows + (phase === 1 ? 10 : 5))
    expect(measurements[1][phase].queries).toBeLessThanOrEqual(measurements[0][phase].queries + 5)
    expect(measurements[1][phase].nativePages).toBe(measurements[0][phase].nativePages)
  }

})

it('continues real scheduled memory maintenance in bounded batches until every indexed input is processed', async () => {
  const { stub, registry, id } = await session()
  await seed(stub, 70)
  const batches: string[][] = []
  const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!(input instanceof Request ? input.url : input.toString()).includes('openrouter.ai')) throw new Error('Unmatched external request denied')
    const content = JSON.parse(init!.body as string).messages.at(-1).content
    const entries = JSON.parse(typeof content === 'string' ? content : content[0].text).newTranscriptEntries as Array<{ id: string }>
    batches.push(entries.map(entry => entry.id))
    return nativeReply('openrouter', '', { name: 'record_memory_changes', arguments: { operations: [{ action: 'add', kind: 'fact', content: `Fixture scheduled fact ${entries[0].id}`, sourceEntryId: entries[0].id }] } })
  })
  try {
    await runInDurableObject(stub, async instance => {
      const f = instance as unknown as { scheduleMemoryExtraction: () => void; memoryExtraction?: Promise<void> }
      vi.mocked(f.scheduleMemoryExtraction).mockRestore()
      await instance.maintainSessionMemory(); await f.memoryExtraction
      expect(batches).toHaveLength(0) // Observation has remaining native records.
      expect((await instance.listSchedules()).filter(job => job.callback === 'maintainSessionMemory')).toHaveLength(1)
      for (let i = 0; i < 3; i++) {
        await instance.maintainSessionMemory(); await f.memoryExtraction
        expect((await instance.listSchedules()).filter(job => job.callback === 'maintainSessionMemory')).toHaveLength(1)
      }
      expect(batches.map(batch => batch.length)).toEqual([30, 30, 10])
      expect(new Set(batches.flat()).size).toBe(70)
      await (instance as unknown as NativeFixture).native.dispose()
      await instance.maintainSessionMemory(); await f.memoryExtraction
      expect(batches).toHaveLength(3)
      for (const job of await instance.listSchedules()) await instance.cancelSchedule(job.id)
    })
    expect((await registry.listMemories()).filter(memory => memory.sourceSessionId === id)).toHaveLength(3)
  } finally { fake.mockRestore(); vi.restoreAllMocks() }
})

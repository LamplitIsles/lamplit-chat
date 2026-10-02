import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView, ImageUpload, Submission } from '@lamplit/contracts'
import type { AgentLane } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/pi-agent-core/harness/context'
import worker from '../server'
import type { PiSession } from './pi-session'
import { PiSessionStorage } from './pi-session-storage'

const authorization = `Basic ${btoa('owner:fixture-password-long-enough')}`
const jpeg = btoa(String.fromCharCode(255, 216, 255, 0, 255, 217))
const model = btoa(String.fromCharCode(255, 216, 255, 42, 255, 217))
async function fixture() {
  const id = crypto.randomUUID()
  const stub = env.PiSession.getByName(id) as DurableObjectStub<PiSession>
  await stub.initialize({ id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
  await runInDurableObject(stub, instance => { vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void; schedulePendingDrain(): Promise<void> }, 'scheduleMemoryExtraction').mockImplementation(() => {}) })
  const bindings: Env = Object.assign({}, env, { COMPANION_SESSION_ID: id })
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set('authorization', authorization)
    return worker.fetch(new Request(`http://images.fixture${path}`, { ...init, headers }), bindings)
  }
  const upload = (input: ImageUpload) => request('/api/chat/images', { method: 'POST', headers: { origin: 'http://images.fixture', 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const makeUpload = (operationId = crypto.randomUUID()): ImageUpload => ({ sessionId: id, operationId, images: [{ id: 'public-image', order: 0, name: 'fixture.jpg', mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model }] })
  let view: ChatView | undefined
  const response = await request('/api/chat/socket', { headers: { origin: 'http://images.fixture', upgrade: 'websocket' } })
  const socket = response.webSocket!; socket.accept()
  const client = await openChat(socket, value => { view = value }, () => {})
  return { id, stub, request, upload, makeUpload, client, view: () => view, close: () => { client.close(); socket.close() } }
}

it('validates public intake before allocation, enforces session/operation ownership and serves bounded originals', async () => {
  const f = await fixture(), other = await fixture()
  try {
    const input = f.makeUpload()
    for (const bad of [
      { ...input, sessionId: other.id },
      { ...input, images: [{ ...input.images[0]!, original: 'AA==' }] },
      { ...input, images: [{ ...input.images[0]!, order: 1 }] },
      { ...input, images: [{ ...input.images[0]!, model: '////' }] },
      { ...input, images: [{ ...input.images[0]!, original: jpeg.slice(0, -1) }] },
      { ...input, images: [input.images[0]!, { ...input.images[0]!, id: 'second-image', order: 1, model: btoa(String.fromCharCode(255, 216, 255, 0, 0, 0)) }] },
    ]) expect((await f.upload(bad)).status).toBeGreaterThanOrEqual(400)
    expect(await runInDurableObject(f.stub, (_instance, state) => new PiSessionStorage(state.storage).allPhotoIds())).toEqual([])
    expect((await f.request('/api/chat/images', { method: 'POST', headers: { origin: 'http://evil.fixture', 'content-type': 'application/json' }, body: JSON.stringify(input) })).status).toBe(403)
    const uploaded = await (await f.upload(input)).json() as { images: Submission['images'] }
    const image = uploaded.images![0]!
    expect((await f.upload(input)).status).toBe(200)
    expect((await f.upload({ ...input, images: [{ ...input.images[0]!, name: 'changed.jpg' }] })).status).toBe(400)
    expect((await f.stub.listConversationPhotos()).images).toEqual([])
    expect((await f.request(`/api/chat/media/${image.attachmentId}/original`)).status).toBe(404) // staging alone is not membership
    expect((await other.request(`/api/chat/media/${image.attachmentId}/model`)).status).toBe(404)
    expect((await worker.fetch(new Request(`http://images.fixture/api/chat/media/${image.attachmentId}/original`), env)).status).toBe(401)
    await expect(f.client.submit({ operationId: crypto.randomUUID(), text: '', images: uploaded.images })).rejects.toThrow()
    let driveCalls = 0
    await runInDurableObject(f.stub, async instance => {
      const lane = await (instance as unknown as { getLane(): Promise<AgentLane> }).getLane()
      vi.spyOn(lane, 'drive').mockImplementation(async () => { driveCalls++; return { ok: true, value: { kind: 'waiting', reason: 'deferred' } } as Awaited<ReturnType<AgentLane['drive']>> })
    })
    const submitted = { operationId: input.operationId, text: '', images: uploaded.images }
    expect((await f.client.submit(submitted)).state).toBe('consumed')
    await expect(f.client.submit({ ...submitted, text: 'changed' })).rejects.toThrow()
    expect((await f.client.submit(submitted)).state).toBe('consumed')
    await runInDurableObject(f.stub, (_instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      const nativeEntry = storage.entriesInOrder().find(e => e.type === 'message' && e.message.role === 'user')
      expect(nativeEntry).toMatchObject({ message: { content: [{ type: 'image', mimeType: 'image/jpeg', data: model }] } })
      expect(storage.entriesInOrder().filter(e => e.type === 'message' && e.message.role === 'user')).toHaveLength(1)
      expect(driveCalls).toBe(1)
    })
    const read = await f.request(`/api/chat/media/${image.attachmentId}/model`)
    expect(read.status).toBe(200); expect(read.headers.get('cache-control')).toBe('no-store')
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(Uint8Array.from(atob(model), c => c.charCodeAt(0)))
    // Existing generated/native originals have a separate 32 MiB read ceiling.
    const large = new Uint8Array(8_000_001); large.set([255, 216]); large.set([255, 217], large.length - 2)
    await env.COMPUTER_R2!.put(`conversation-photos/${f.id}/${image.attachmentId}/original`, large)
    expect((await f.request(`/api/chat/media/${image.attachmentId}/original`)).status).toBe(200)
  } finally { f.close(); other.close(); vi.restoreAllMocks() }
})

it('projects proven native-origin dropped input, restages edited recovery and never resurrects a replaced source', async () => {
  const f = await fixture()
  try {
    const operation = crypto.randomUUID(), photoId = crypto.randomUUID()
    await f.stub.uploadPhoto({ operationId: operation, id: photoId, order: 0, name: 'native.jpg', mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model })
    await runInDurableObject(f.stub, async instance => {
      const internals = instance as unknown as { getLane(): Promise<AgentLane>; schedulePendingDrain(): Promise<void> }
      const lane = await internals.getLane()
      vi.spyOn(internals, 'schedulePendingDrain').mockResolvedValue()
      const accepted = await lane.accept({ kind: 'prompt', operationId: crypto.randomUUID(), prompt: 'fixture holds a turn' }, context)
      if (!accepted.ok) throw accepted.error
      const steer = await instance.submitSteer({ submissionId: operation, prompt: '  native exact input\n ', photoIds: [photoId] })
      expect(steer.state).toBe('accepted')
      if (!('entryId' in steer)) throw new Error('No native entry')
      expect(await instance.chatRecovery()).toEqual([]) // still queued, not unconsumed
      const canceled = await lane.cancelQueued(steer.entryId, context)
      expect(canceled).toMatchObject({ ok: true, value: { kind: 'cancelled' } })
    })
    const recovery = await f.stub.chatRecovery()
    expect(recovery).toMatchObject([{ sourceId: operation, operationId: operation, text: '  native exact input\n ', replacementEligible: true, state: 'unconsumed', images: [{ attachmentId: photoId }] }])
    expect((await f.request(`/api/chat/media/${photoId}/original`)).status).toBe(200)
    const fresh = f.makeUpload()
    const images = (await (await f.upload(fresh)).json() as { images: Submission['images'] }).images
    const input = { operationId: fresh.operationId, text: 'edited', images, replacementSourceIds: [operation] }
    expect((await f.client.submit(input)).state).toBe('accepted')
    expect(await f.stub.chatRecovery()).toEqual([])
    // Idempotent retry must reconcile before checking the now-replaced source.
    expect((await f.client.submit(input)).state).toBe('accepted')
    await expect(f.client.submit({ operationId: crypto.randomUUID(), text: 'again', replacementSourceIds: [operation] })).rejects.toThrow()
    expect((await f.request(`/api/chat/media/${photoId}/original`)).status).toBe(404)
    await runInDurableObject(f.stub, async instance => {
      const lane = await (instance as unknown as { getLane(): Promise<AgentLane> }).getLane()
      const drive = vi.spyOn(lane, 'drive').mockResolvedValue({ ok: true, value: { kind: 'waiting', reason: 'deferred' } } as Awaited<ReturnType<AgentLane['drive']>>)
      try {
        const steer = await instance.getSteerAdmission(fresh.operationId)
        expect(steer).toMatchObject({ state: 'accepted' })
        if (!('entryId' in steer)) throw new Error('No steer')
        const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
        expect(storage.getValueSync((await import('@earendil-works/pi-agent-core/harness/session')).pendingEntry(steer.entryId))?.value).toMatchObject({ payload: { content: [{ type: 'text', text: 'edited' }, { type: 'image', data: model, mimeType: 'image/jpeg' }] } })
      } finally { drive.mockRestore() }
    })
  } finally { f.close(); vi.restoreAllMocks() }
})

it('rejects consumed recovery atomically even when native consumption races shared validation', async () => {
  const f = await fixture()
  try {
    const id = crypto.randomUUID()
    await runInDurableObject(f.stub, async (instance) => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      storage.recordChat(id, { operationId: id, text: 'rejected input', kind: 'prompt', turnId: id, rejected: true })
      expect(storage.eligible(id)).toBe(true)
      expect(storage.recordChat(id, { operationId: id, text: 'rejected input', kind: 'steer', turnId: null })).toBe(false)
      expect(() => storage.recordChat(id, { operationId: id, text: 'changed input', kind: 'prompt', turnId: id })).toThrow('identity conflict')
      const next = crypto.randomUUID()
      // The exact source was consumed after preliminary validation, before the new harness commit.
      storage.recordChat(next, { operationId: next, text: 'replacement', kind: 'prompt', turnId: next, replacementSourceIds: [id] })
      storage.setChatRejected(id, false)
      const lane = await (instance as unknown as { getLane(): Promise<AgentLane> }).getLane()
      await expect(lane.accept({ kind: 'prompt', operationId: next, prompt: 'replacement' }, context)).rejects.toThrow()
      expect(storage.replaced(id)).toBe(false)
      expect(storage.entriesInOrder().some(e => e.type === 'message' && e.message.role === 'user')).toBe(false)
    })
  } finally { f.close(); vi.restoreAllMocks() }
})

it('never turns an envelope or missing native ledger into replayable recovery; media-disabled text remains usable', async () => {
  const f = await fixture()
  try {
    const id = crypto.randomUUID()
    await runInDurableObject(f.stub, instance => {
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      storage.recordChat(id, { operationId: id, text: 'uncertain', kind: 'prompt', turnId: id })
    })
    expect((await f.client.lookup(id)).state).toBe('uncertain')
    expect(await f.stub.chatRecovery()).toMatchObject([{ operationId: id, state: 'uncertain', replacementEligible: false }])
    await expect(f.client.submit({ operationId: crypto.randomUUID(), text: 'unsafe retry', replacementSourceIds: [id] })).rejects.toThrow()
    expect((await worker.fetch(new Request('http://images.fixture/api/chat/images', { method: 'POST', headers: { authorization, origin: 'http://images.fixture', 'content-type': 'application/json' }, body: JSON.stringify(f.makeUpload()) }), Object.assign({}, env, { COMPANION_SESSION_ID: f.id, COMPUTER_R2: undefined }))).status).toBe(503)
  } finally { f.close(); vi.restoreAllMocks() }
})

it('keeps partial R2 uploads unusable until every exact variant is retried, and enforces body/variant caps', async () => {
  const f = await fixture()
  try {
    const input = f.makeUpload()
    await runInDurableObject(f.stub, instance => {
      const bucket = (instance as unknown as { env: Env }).env.COMPUTER_R2!
      vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('Test-owned partial write failure'))
    })
    expect((await f.upload(input)).status).toBe(400)
    expect(await runInDurableObject(f.stub, (_instance, state) => new PiSessionStorage(state.storage).photosForOperation(input.operationId))).toEqual([])
    expect((await f.stub.listConversationPhotos()).images).toEqual([])
    expect((await f.upload(input)).status).toBe(200)
    const large = new Uint8Array(160_001); large.set([255, 216, 255]); large.set([255, 217], large.length - 2)
    let binary = ''; for (let i = 0; i < large.length; i += 32768) binary += String.fromCharCode(...large.subarray(i, i + 32768))
    expect((await f.upload({ ...input, images: [{ ...input.images[0]!, preview: btoa(binary) }] })).status).toBe(400)
    expect((await f.request('/api/chat/images', { method: 'POST', headers: { origin: 'http://images.fixture', 'content-type': 'application/json', 'content-length': '36000001' }, body: '{}' })).status).toBe(413)
  } finally { f.close(); vi.restoreAllMocks() }
})

it('the real native fake model receives the exact uploaded JPEG bytes for both prompt and active-turn steer', async () => {
  const requests: unknown[] = []
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith('https://example.invalid/')) return original(input, init)
    if (typeof init?.body !== 'string') throw new Error('Expected native model JSON request body')
    requests.push(JSON.parse(init.body))
    return new Response('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Native model observed image"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const f = await fixture()
  try {
    const first = f.makeUpload()
    const images = (await (await f.upload(first)).json() as { images: Submission['images'] }).images
    await f.client.submit({ operationId: first.operationId, text: 'image prompt', images })
    await vi.waitFor(() => expect(requests.length).toBe(1))
    expect(JSON.stringify(requests[0])).toContain(`data:image/jpeg;base64,${model}`)
    await vi.waitFor(async () => expect(f.view()?.activeTurnId).toBeNull())
    const activeId = crypto.randomUUID()
    await runInDurableObject(f.stub, async instance => {
      const internals = instance as unknown as { getLane(): Promise<AgentLane>; schedulePendingDrain(): Promise<void> }
      vi.spyOn(internals, 'schedulePendingDrain').mockResolvedValue()
      const result = await (await internals.getLane()).accept({ kind: 'prompt', operationId: activeId, prompt: 'active fixture turn' }, context)
      if (!result.ok) throw result.error
    })
    const second = f.makeUpload()
    const next = (await (await f.upload(second)).json() as { images: Submission['images'] }).images
    expect((await f.client.submit({ operationId: second.operationId, text: 'image steering', images: next })).state).toBe('accepted')
    await runInDurableObject(f.stub, async instance => {
      const result = await (await (instance as unknown as { getLane(): Promise<AgentLane> }).getLane()).drive({ operationId: activeId }, context)
      if (!result.ok) throw result.error
    })
    expect(JSON.stringify(requests.at(-1))).toContain(`data:image/jpeg;base64,${model}`)
    expect(JSON.stringify(requests.at(-1))).toContain('image steering')
    expect((await f.client.lookup(second.operationId)).state).toBe('consumed')
    expect((await f.stub.listConversationPhotos()).images).toHaveLength(2)
  } finally { f.close(); vi.restoreAllMocks() }
})

it.each(['prompt', 'steer'] as const)('does not admit or execute %s revoked during actual R2 model reads', async kind => {
  const f = await fixture(), operationId = crypto.randomUUID(), photoId = crypto.randomUUID()
  try {
    await f.stub.uploadPhoto({ operationId, id: photoId, order: 0, name: 'revoked.jpg', mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model })
    await runInDurableObject(f.stub, async instance => {
      const inner = instance as unknown as { getLane(): Promise<AgentLane>; env: Env; sessionStorage: PiSessionStorage }
      const lane = await inner.getLane()
      const accept = vi.spyOn(lane, 'accept'), steer = vi.spyOn(lane, 'steer'), drive = vi.spyOn(lane, 'drive')
      let active = true
      vi.spyOn(instance, 'verifyCurrentConnection').mockImplementation(async () => { if (!active) throw new Error('Session expired') })
      const get = inner.env.COMPUTER_R2!.get.bind(inner.env.COMPUTER_R2!)
      vi.spyOn(inner.env.COMPUTER_R2!, 'get').mockImplementation(async (...args: Parameters<typeof get>) => { const value = await get(...args); active = false; return value })
      const result = kind === 'steer' ? instance.submitSteer({ submissionId: operationId, prompt: 'revoked', photoIds: [photoId] }) : instance.prompt({ send: () => true, end: () => true }, { operationId, prompt: 'revoked', photoIds: [photoId] })
      await expect(result).rejects.toThrow('Session expired')
      expect(active).toBe(false)
      expect(inner.sessionStorage.getPromptSubmission(operationId)).toBeUndefined()
      expect(inner.sessionStorage.steerRecord(operationId)).toBeUndefined()
      expect(inner.sessionStorage.nativeInputs()).toEqual([])
      expect(accept).not.toHaveBeenCalled(); expect(steer).not.toHaveBeenCalled(); expect(drive).not.toHaveBeenCalled()
    })
  } finally { f.close(); vi.restoreAllMocks() }
})

it.each(['', 'native text plus images'])('retains exact ordered native recovery metadata after photo deletion (%s)', async text => {
  const f = await fixture(), operationId = crypto.randomUUID(), ids = [crypto.randomUUID(), crypto.randomUUID()]
  try {
    for (const [order, id] of ids.entries()) await f.stub.uploadPhoto({ operationId, id, order, name: `native-${order}.jpg`, mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model })
    await runInDurableObject(f.stub, async instance => {
      const inner = instance as unknown as { getLane(): Promise<AgentLane>; schedulePendingDrain(): Promise<void> }
      vi.spyOn(inner, 'schedulePendingDrain').mockResolvedValue()
      const lane = await inner.getLane(), hold = await lane.accept({ kind: 'prompt', operationId: crypto.randomUUID(), prompt: 'hold' }, context)
      if (!hold.ok) throw hold.error
      const input = await instance.submitSteer({ submissionId: operationId, prompt: text, photoIds: ids })
      if (!('entryId' in input)) throw new Error('Missing native admission')
      const cancel = await lane.cancelQueued(input.entryId, context)
      if (!cancel.ok) throw cancel.error
    })
    await f.stub.deleteConversationPhoto(ids[0]!)
    expect(await f.stub.chatRecovery()).toMatchObject([{ sourceId: operationId, text, state: 'unconsumed', replacementEligible: true, images: [{ attachmentId: ids[0], name: 'native-0.jpg', availability: 'missing' }, { attachmentId: ids[1], name: 'native-1.jpg', availability: 'available' }] }])
    expect((await f.request(`/api/chat/media/${ids[0]}/original`)).status).toBe(404)
    const response = await f.request('/api/chat/socket', { headers: { origin: 'http://images.fixture', upgrade: 'websocket' } }), socket = response.webSocket!; socket.accept()
    let view: ChatView | undefined
    const client = await openChat(socket, value => { view = value }, () => {})
    try { await vi.waitFor(() => expect(view?.recovery[0]?.images.map(image => image.attachmentId)).toEqual(ids)) } finally { client.close(); socket.close() }
    await expect(f.client.submit({ operationId: crypto.randomUUID(), text, images: (await f.stub.chatRecovery())[0]!.images, replacementSourceIds: [operationId] })).rejects.toThrow()
    expect((await f.stub.chatRecovery())[0]?.replacementEligible).toBe(true)
  } finally { f.close(); vi.restoreAllMocks() }
})

it('retains the immutable shared image refs after native photo deletion', async () => {
  const f = await fixture()
  try {
    await runInDurableObject(f.stub, async instance => {
      const inner = instance as unknown as { getLane(): Promise<AgentLane>; schedulePendingDrain(): Promise<void> }
      vi.spyOn(inner, 'schedulePendingDrain').mockResolvedValue()
      const hold = await (await inner.getLane()).accept({ kind: 'prompt', operationId: crypto.randomUUID(), prompt: 'hold' }, context)
      if (!hold.ok) throw hold.error
    })
    const input = f.makeUpload(), images = (await (await f.upload(input)).json() as { images: Submission['images'] }).images!
    const receipt = await f.client.submit({ operationId: input.operationId, text: '', images })
    await runInDurableObject(f.stub, async instance => {
      const cancel = await (await (instance as unknown as { getLane(): Promise<AgentLane> }).getLane()).cancelQueued(receipt.messageId!, context)
      if (!cancel.ok) throw cancel.error
    })
    await f.stub.deleteConversationPhoto(images[0]!.attachmentId)
    expect((await f.stub.chatRecovery())[0]).toMatchObject({ operationId: input.operationId, text: '', images: [{ ...images[0], availability: 'missing' }], replacementEligible: true })
    expect((await f.client.lookup(input.operationId)).state).toBe('unconsumed')
  } finally { f.close(); vi.restoreAllMocks() }
})

it.each([201, 255])('abbreviates native %i-character names in history/recovery while preserving media and fresh resend identity', async length => {
  const f = await fixture(), name = 'n'.repeat(length), expected = 'n'.repeat(199) + '…', historyId = crypto.randomUUID(), historyPhoto = crypto.randomUUID(), source = crypto.randomUUID(), sourcePhoto = crypto.randomUUID()
  try {
    for (const [operationId, id] of [[historyId, historyPhoto], [source, sourcePhoto]]) await f.stub.uploadPhoto({ operationId: operationId!, id: id!, order: 0, name, mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model })
    await runInDurableObject(f.stub, async instance => {
      const inner = instance as unknown as { getLane(): Promise<AgentLane>; schedulePendingDrain(): Promise<void>; sessionStorage: PiSessionStorage }
      vi.spyOn(inner, 'schedulePendingDrain').mockResolvedValue()
      const lane = await inner.getLane()
      vi.spyOn(lane, 'drive').mockResolvedValue({ ok: true, value: { kind: 'waiting', reason: 'deferred' } } as Awaited<ReturnType<AgentLane['drive']>>)
      await instance.prompt({ send: () => true, end: () => true }, { operationId: historyId, prompt: '', photoIds: [historyPhoto] })
      const input = await instance.submitSteer({ submissionId: source, prompt: '', photoIds: [sourcePhoto] })
      if (!('entryId' in input)) throw new Error('Missing native entry')
      const cancel = await lane.cancelQueued(input.entryId, context)
      if (!cancel.ok) throw cancel.error
      expect(inner.sessionStorage.photo(historyPhoto)?.name).toBe(name)
      expect(inner.sessionStorage.photo(sourcePhoto)?.name).toBe(name)
    })
    const recovery = (await f.stub.chatRecovery())[0]!
    expect(recovery.images).toMatchObject([{ attachmentId: sourcePhoto, name: expected, availability: 'available' }])
    const response = await f.request('/api/chat/socket', { headers: { origin: 'http://images.fixture', upgrade: 'websocket' } }), socket = response.webSocket!; socket.accept()
    let view: ChatView | undefined
    const client = await openChat(socket, value => { view = value }, () => {})
    try { await vi.waitFor(() => expect(view?.messages.find(message => message.images?.[0]?.attachmentId === historyPhoto)?.images).toMatchObject([{ attachmentId: historyPhoto, name: expected }]), { timeout: 5000 }) } finally { client.close(); socket.close() }
    for (const id of [historyPhoto, sourcePhoto]) expect(await (await f.request(`/api/chat/media/${id}/original`)).arrayBuffer()).toEqual(Uint8Array.from(atob(jpeg), c => c.charCodeAt(0)).buffer)
    const fresh = f.makeUpload(); fresh.images[0]!.name = recovery.images[0]!.name
    const images = (await (await f.upload(fresh)).json() as { images: Submission['images'] }).images
    const replacement = { operationId: fresh.operationId, text: 'edited', images, replacementSourceIds: [source] }
    expect((await f.client.submit(replacement)).state).toBe('accepted')
    expect((await f.client.submit(replacement)).state).toBe('accepted')
    expect(await f.stub.chatRecovery()).toEqual([])
    expect(images![0]!.attachmentId).not.toBe(sourcePhoto)
    await runInDurableObject(f.stub, instance => { expect((instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage.photo(sourcePhoto)?.name).toBe(name) })
  } finally { f.close(); vi.restoreAllMocks() }
})

import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView, ImageUpload, Submission } from '@lamplit/contracts'
import { nativeReply } from './fixtures/native-provider'
import type { NativeFixture } from './fixtures/native-session'
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
    expect(await f.client.submit({ operationId: crypto.randomUUID(), text: '', images: uploaded.images })).toMatchObject({ state: 'failed' })
    const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => nativeReply('openrouter', 'Native image reply'))
    const submitted = { operationId: input.operationId, text: '', images: uploaded.images }
    expect((await f.client.submit(submitted)).state).toBe('submitted')
    await expect(f.client.submit({ ...submitted, text: 'changed' })).rejects.toThrow()
    expect((await f.client.submit(submitted)).state).toBe('submitted')
    await runInDurableObject(f.stub, async instance => {
      await (instance as unknown as NativeFixture).native.wait(input.operationId)
      await instance.getBranch()
      const storage = (instance as unknown as { sessionStorage: PiSessionStorage }).sessionStorage
      expect(storage.entriesInOrder().filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1)
      expect(storage.entriesInOrder().find(entry => entry.type === 'message' && entry.message.role === 'user')).toMatchObject({ message: { content: [{ type: 'image', mimeType: 'image/jpeg', data: model }] } })
    })
    expect(fake).toHaveBeenCalledTimes(1)
    const read = await f.request(`/api/chat/media/${image.attachmentId}/model`)
    expect(read.status).toBe(200); expect(read.headers.get('cache-control')).toBe('no-store')
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(Uint8Array.from(atob(model), c => c.charCodeAt(0)))
    // Existing generated/native originals have a separate 32 MiB read ceiling.
    const large = new Uint8Array(8_000_001); large.set([255, 216]); large.set([255, 217], large.length - 2)
    await env.COMPUTER_R2!.put(`conversation-photos/${f.id}/${image.attachmentId}/original`, large)
    expect((await f.request(`/api/chat/media/${image.attachmentId}/original`)).status).toBe(200)
  } finally { f.close(); other.close(); vi.restoreAllMocks() }
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


async function hold(f: Awaited<ReturnType<typeof fixture>>) {
  let release!: () => void
  let first = true
  const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const reply = nativeReply('openrouter', 'Fixture resumed')
    if (!first) return reply
    first = false
    const bytes = await reply.arrayBuffer()
    return new Response(new ReadableStream({ start(controller) { release = () => { controller.enqueue(new Uint8Array(bytes)); controller.close() } } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const operationId = crypto.randomUUID()
  expect(await f.client.submit({ operationId, text: 'hold actual native generation' })).toMatchObject({ state: 'submitted' })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  let released = false
  return { release: () => runInDurableObject(f.stub, () => { if (!released) { released = true; release() } }), fake, operationId }
}
async function withdraw(f: Awaited<ReturnType<typeof fixture>>, input: Submission) {
  expect(await f.client.submit(input)).toMatchObject({ state: 'submitted', messageId: null })
  expect(await f.stub.chatRecovery()).toEqual([])
  await runInDurableObject(f.stub, async instance => {
    expect(await (instance as unknown as NativeFixture).native.abort({ operationId: input.operationId })).toBe(true)
  })
  expect(await f.client.lookup(input.operationId)).toMatchObject({ state: 'submitted' })
}

it.each(['', '  exact ordered text\n '])('recovers only a withdrawn native queued input, retains media identity and consumes replacement once (%s)', async text => {
  const f = await fixture(), held = await hold(f)
  try {
    const upload = f.makeUpload()
    upload.images.push({ ...upload.images[0]!, id: 'second', order: 1, name: 'second.jpg' })
    const images = (await (await f.upload(upload)).json() as { images: NonNullable<Submission['images']> }).images
    await withdraw(f, { operationId: upload.operationId, text, images })
    expect(await f.stub.chatRecovery()).toMatchObject([{ sourceId: upload.operationId, operationId: upload.operationId, text, images, replacementEligible: true }])
    expect((await f.request(`/api/chat/media/${images[0]!.attachmentId}/original`)).status).toBe(200)
    const fresh = f.makeUpload()
    const replacementImages = (await (await f.upload(fresh)).json() as { images: Submission['images'] }).images
    const replacement = { operationId: fresh.operationId, text: 'edited recovery', images: replacementImages, replacementSourceIds: [upload.operationId] }
    expect(await f.client.submit(replacement)).toMatchObject({ state: 'submitted' })
    expect(await f.client.submit(replacement)).toMatchObject({ state: 'submitted' })
    expect(await f.stub.chatRecovery()).toEqual([])
    expect(await f.client.submit({ operationId: crypto.randomUUID(), text: 'duplicate recovery', replacementSourceIds: [upload.operationId] })).toMatchObject({ state: 'failed' })
    await expect(f.client.submit({ ...replacement, replacementSourceIds: [] })).rejects.toThrow()
    await held.release()
    await runInDurableObject(f.stub, async instance => { await (instance as unknown as NativeFixture).native.wait(fresh.operationId) })
    expect(await f.client.lookup(fresh.operationId)).toMatchObject({ state: 'submitted' })
  } finally { await held.release(); await runInDurableObject(f.stub, async instance => { await (instance as unknown as NativeFixture).native.wait(held.operationId) }); f.close(); vi.restoreAllMocks() }
})

it('keeps an unproven domain association ambiguous and prevents replayable recovery', async () => {
  const f = await fixture()
  try {
    const operationId = crypto.randomUUID()
    await runInDurableObject(f.stub, (_instance, state) => new PiSessionStorage(state.storage).recordChat(operationId, { operationId, text: 'uncertain input', turnId: operationId }))
    expect(await f.client.lookup(operationId)).toBeNull()
    expect(await f.stub.chatRecovery()).toEqual([])
    expect(await f.client.submit({ operationId: crypto.randomUUID(), text: 'unsafe replay', replacementSourceIds: [operationId] })).toMatchObject({ state: 'failed' })
    expect((await worker.fetch(new Request('http://images.fixture/api/chat/images', { method: 'POST', headers: { authorization, origin: 'http://images.fixture', 'content-type': 'application/json' }, body: JSON.stringify(f.makeUpload()) }), Object.assign({}, env, { COMPANION_SESSION_ID: f.id, COMPUTER_R2: undefined }))).status).toBe(503)
  } finally { f.close(); vi.restoreAllMocks() }
})

it.each([201, 255])('preserves withdrawn image refs after deletion and abbreviates a %i-character name', async length => {
  const f = await fixture(), held = await hold(f)
  try {
    const operationId = crypto.randomUUID(), attachmentId = crypto.randomUUID(), name = 'n'.repeat(length)
    await f.stub.uploadPhoto({ operationId, id: attachmentId, order: 0, name, mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model })
    const images = [{ attachmentId, name: 'n'.repeat(199) + '…', mediaType: 'image/jpeg' as const, availability: 'available' as const }]
    await withdraw(f, { operationId, text: '', images })
    await f.stub.deleteConversationPhoto(attachmentId)
    expect(await f.stub.chatRecovery()).toMatchObject([{ operationId, text: '', images: [{ ...images[0], availability: 'missing' }], replacementEligible: true }])
    expect(await f.client.lookup(operationId)).toMatchObject({ state: 'submitted' })
    expect((await f.request(`/api/chat/media/${attachmentId}/original`)).status).toBe(404)
    await expect(f.client.submit({ operationId: crypto.randomUUID(), text: '', images: (await f.stub.chatRecovery())[0]!.images, replacementSourceIds: [operationId] })).rejects.toThrow('Invalid submitted images')
  } finally { await held.release(); await runInDurableObject(f.stub, async instance => { await (instance as unknown as NativeFixture).native.wait(held.operationId) }); f.close(); vi.restoreAllMocks() }
})

it('revalidates the captured authenticated socket after actual R2 preparation and admits no revoked input', async () => {
  const f = await fixture()
  const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => nativeReply('openrouter', 'Must not execute'))
  try {
    const upload = f.makeUpload(), images = (await (await f.upload(upload)).json() as { images: Submission['images'] }).images
    let revoked = false
    await runInDurableObject(f.stub, instance => {
      const inner = instance as unknown as { env: Env; verifyConnection(connection: unknown): Promise<void> }
      const get = inner.env.COMPUTER_R2!.get.bind(inner.env.COMPUTER_R2!)
      vi.spyOn(inner.env.COMPUTER_R2!, 'get').mockImplementation(async (...args: Parameters<typeof get>) => { const object = await get(...args); revoked = true; return object })
      vi.spyOn(inner, 'verifyConnection').mockImplementation(async () => { if (revoked) throw new Error('Revoked fixture connection') })
    })
    await expect(f.client.submit({ operationId: upload.operationId, text: 'revoked input', images })).rejects.toThrow()
    expect(revoked).toBe(true)
    expect(await f.stub.lookupChat(upload.operationId)).toBeNull()
    expect(await f.stub.chatRecovery()).toEqual([])
    expect(fake).not.toHaveBeenCalled()
  } finally { f.close(); vi.restoreAllMocks() }
})

it('keeps one public message identity when a published queued input becomes a placed native entry', async () => {
  const f = await fixture(), held = await hold(f)
  try {
    const upload = f.makeUpload(), images = (await (await f.upload(upload)).json() as { images: Submission['images'] }).images
    const input = { operationId: upload.operationId, text: 'queued image publication', images }
    expect(await f.client.submit(input)).toMatchObject({ state: 'submitted', messageId: null })
    await vi.waitFor(() => expect(f.view()?.messages.find(message => message.operationId === input.operationId)?.id).toBe(`submission:${input.operationId}`), { timeout: 10000 })
    await held.release()
    await runInDurableObject(f.stub, async instance => { await (instance as unknown as NativeFixture).native.wait(input.operationId) })
    expect(await f.client.lookup(input.operationId)).toMatchObject({ messageId: `submission:${input.operationId}` })
    await vi.waitFor(() => expect(f.view()?.messages.filter(message => message.operationId === input.operationId)).toMatchObject([{ id: `submission:${input.operationId}`, text: input.text }]), { timeout: 10000 })
  } finally { await held.release(); f.close(); vi.restoreAllMocks() }
})

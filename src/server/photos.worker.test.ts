import { env } from 'cloudflare:workers'
import { runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { imageRef } from './chat-images'
import { nativeReply } from './fixtures/native-provider'
import type { NativeFixture } from './fixtures/native-session'
import type { PiSession } from './pi-session'
import { PiSessionStorage } from './pi-session-storage'

const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xd9))
const otherJpeg = btoa(String.fromCharCode(0xff, 0xd8, 0x00, 0xff, 0xd9))

describe('conversation photos', () => {
  it('reserves identity before interleaved R2 writes and never overwrites a winner', async () => {
    const sessionId = crypto.randomUUID()
    const operationId = crypto.randomUUID()
    const id = crypto.randomUUID()
    const stub = env.PiSession.getByName(sessionId) as DurableObjectStub<PiSession>
    await stub.initialize({ id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
    await runInDurableObject(stub, async (instance) => {
      const base = { operationId, id, order: 0, name: 'race.jpg', mediaType: 'image/jpeg' }
      const first = { ...base, original: jpeg, preview: jpeg, model: jpeg }
      const second = { ...base, original: otherJpeg, preview: otherJpeg, model: otherJpeg }
      const results = await Promise.allSettled([instance.uploadPhoto(first), instance.uploadPhoto(second)])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const winner = results[0].status === 'fulfilled' ? jpeg : otherJpeg
      for (const variant of ['original', 'preview', 'model']) {
        const object = await env.COMPUTER_R2!.get(`conversation-photos/${sessionId}/${id}/${variant}`)
        expect(object).not.toBeNull()
        const bytes = new Uint8Array(await object!.arrayBuffer())
        expect(btoa(String.fromCharCode(...bytes))).toBe(winner)
      }
      const exact = winner === jpeg ? first : second
      expect(await instance.uploadPhoto(exact)).toMatchObject({ id, operationId })
      await expect(instance.uploadPhoto(winner === jpeg ? second : first)).rejects.toThrow('identity conflict')
    })
  })
  it('rejects a multi-image Pi row over budget before admission', async () => {
    const sessionId = crypto.randomUUID()
    const operationId = crypto.randomUUID()
    const stub = env.PiSession.getByName(sessionId) as DurableObjectStub<PiSession>
    await stub.initialize({ id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
    const large = new Uint8Array(300_000)
    large.set([0xff, 0xd8])
    large.set([0xff, 0xd9], large.length - 2)
    let binary = ''
    for (let index = 0; index < large.length; index += 0x8000) binary += String.fromCharCode(...large.subarray(index, index + 0x8000))
    const model = btoa(binary)
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID())
    for (const [order, id] of ids.entries()) await stub.uploadPhoto({ operationId, id, order, name: `${order}.jpg`, mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model })
    await runInDurableObject(stub, async (instance, state) => {
      const images = ids.map((attachmentId, i) => ({ attachmentId, name: `${i}.jpg`, mediaType: 'image/jpeg' as const, availability: 'available' as const }))
      expect(await instance.submitChat({ operationId, text: '', images })).toMatchObject({ state: 'failed' })
      expect(await instance.lookupChat(operationId)).toMatchObject({ state: 'failed' })
      expect((await instance.listConversationPhotos()).images).toEqual([])
      expect(new PiSessionStorage(state.storage).entriesInOrder()).toEqual([])
    })
  })
  for (const text of ['Two views', '']) it(`admits one native photo group with caption ${JSON.stringify(text)} and retains private model bytes`, async () => {
    const sessionId = crypto.randomUUID(), operationId = crypto.randomUUID()
    const stub = env.PiSession.getByName(sessionId) as DurableObjectStub<PiSession>
    await stub.initialize({ id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    const photos: Awaited<ReturnType<PiSession['uploadPhoto']>>[] = []
    for (const [order, id] of ids.entries()) photos.push(await stub.uploadPhoto({ operationId, id, order, name: `${order}.jpg`, mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model: jpeg }))
    const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => nativeReply('openrouter', 'Fixture image reply'))
    try {
      await runInDurableObject(stub, async instance => {
        vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
        const input = { operationId, text, images: photos.map(photo => imageRef(photo)) }
        expect(await instance.submitChat(input)).toMatchObject({ state: 'submitted' })
        expect(await instance.submitChat(input)).toMatchObject({ state: 'submitted' })
        await (instance as unknown as NativeFixture).native.wait(operationId)
        const receipt = await instance.lookupChat(operationId)
        expect(receipt).toMatchObject({ state: 'submitted', messageId: expect.any(String) })
        const branch = await instance.getBranch()
        expect(branch.entries.filter(entry => entry.message?.role === 'user')).toHaveLength(1)
        expect(branch.entries.find(entry => entry.message?.role === 'user')?.photos).toHaveLength(2)
        expect(JSON.stringify(branch)).not.toContain(jpeg)
        const lane = await (instance as unknown as NativeFixture).getLane()
        const view = await lane.context((instance as unknown as NativeFixture).nativeContext)
        expect(view.messages[0]).toMatchObject({ role: 'user', content: [...(text ? [{ type: 'text', text }] : []), { type: 'image', mimeType: 'image/jpeg', data: jpeg }, { type: 'image', mimeType: 'image/jpeg', data: jpeg }] })
        await expect(instance.uploadPhoto({ operationId, id: crypto.randomUUID(), order: 2, name: 'late.jpg', mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model: jpeg })).rejects.toThrow('already admitted')
        await expect(instance.submitChat({ ...input, images: [...input.images].reverse() })).rejects.toThrow('identity conflict')
        expect((await instance.listConversationPhotos()).images).toHaveLength(2)
      })
      expect(fake).toHaveBeenCalledTimes(1)
    } finally { fake.mockRestore() }
  })
  it('keeps uploads private until one Pi entry is admitted, then pages in stable order', async () => {
    const sessionId = crypto.randomUUID()
    const otherSessionId = crypto.randomUUID()
    const operationId = crypto.randomUUID()
    const photoId = crypto.randomUUID()
    const secondPhotoId = crypto.randomUUID()
    const stub = env.PiSession.getByName(sessionId) as DurableObjectStub<PiSession>
    const other = env.PiSession.getByName(otherSessionId) as DurableObjectStub<PiSession>
    const metadata = (id: string) => ({ id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' as const } })
    await stub.initialize(metadata(sessionId))
    await other.initialize(metadata(otherSessionId))
    const input = { operationId, id: photoId, order: 0, name: 'garden.jpg', mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model: jpeg }
    expect(await stub.uploadPhoto(input)).toMatchObject({ id: photoId, operationId, name: 'garden.jpg' })
    expect(await stub.uploadPhoto(input)).toMatchObject({ id: photoId })
    expect(await stub.uploadPhoto({ ...input, id: secondPhotoId, order: 1, name: 'sky.jpg' })).toMatchObject({ id: secondPhotoId, order: 1 })
    expect((await stub.listConversationPhotos()).images).toEqual([])
    expect((await other.listConversationPhotos()).images).toEqual([])
    await runInDurableObject(stub, (_instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      storage.freezePhotos(operationId, [photoId, secondPhotoId])
      storage.correlateInput(operationId, 'entry-from-another-branch')
      expect(storage.photosForEntry('entry-from-another-branch').map((photo) => photo.id)).toEqual([photoId, secondPhotoId])
    })
    const page = await stub.listConversationPhotos({ limit: 1 })
    expect(page.images).toHaveLength(1)
    expect(page.images[0]?.id).toBe(photoId)
    expect(page.nextCursor).toBe(page.images[0]?.id)
    const secondPage = await stub.listConversationPhotos({ limit: 1, cursor: page.nextCursor })
    expect(secondPage.images).toHaveLength(1)
    expect(secondPage.images[0]?.id).not.toBe(page.images[0]?.id)
    expect(secondPage.nextCursor).toBeUndefined()
    expect((await other.listConversationPhotos()).images).toEqual([])
    expect((await stub.readConversationPhoto(photoId, 'original')).status).toBe(200)
    expect((await other.readConversationPhoto(photoId, 'original')).status).toBe(404)
    const preview = await SELF.fetch(`http://example.test/api/conversation-images/${sessionId}/${photoId}/preview`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toBe('image/jpeg')
    expect((await SELF.fetch(`http://example.test/api/conversation-images/${otherSessionId}/${photoId}/original`)).status).toBe(404)
  })
})

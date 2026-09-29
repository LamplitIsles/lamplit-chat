import { env } from 'cloudflare:workers'
import { runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { AgentLane } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
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
      await expect(instance.prompt({ send: () => {}, end: () => {} } as unknown as Parameters<PiSession['prompt']>[0], { operationId, prompt: '', photoIds: ids })).rejects.toThrow('message size limit')
      expect(new PiSessionStorage(state.storage).getPromptSubmission(operationId)).toBeUndefined()
      expect((await instance.listConversationPhotos()).images).toEqual([])
    })
  })
  it('queues one captioned photo group with native image content on repeated steer', async () => {
    const sessionId = crypto.randomUUID()
    const operationId = crypto.randomUUID()
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    const stub = env.PiSession.getByName(sessionId) as DurableObjectStub<PiSession>
    await stub.initialize({ id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
    for (const [order, id] of ids.entries()) await stub.uploadPhoto({ operationId, id, order, name: `${order}.jpg`, mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model: jpeg })
    await runInDurableObject(stub, async (instance) => {
      const internals = instance as unknown as { getLane(): Promise<AgentLane>; schedulePendingDrain(): Promise<void> }
      const lane = await internals.getLane()
      const steer = vi.spyOn(lane, 'steer').mockResolvedValue({ ok: true, value: { entryId: 'steer-entry' } } as Awaited<ReturnType<AgentLane['steer']>>)
      const drain = vi.spyOn(internals, 'schedulePendingDrain').mockResolvedValue()
      try {
        const input = { submissionId: operationId, prompt: 'Two views', photoIds: ids }
        expect(await instance.submitSteer(input)).toMatchObject({ state: 'accepted', entryId: 'steer-entry' })
        expect(await instance.submitSteer(input)).toMatchObject({ state: 'accepted', entryId: 'steer-entry' })
        expect(steer).toHaveBeenCalledTimes(1)
        expect(steer.mock.calls[0]?.[0]).toMatchObject({ role: 'user', content: [
          { type: 'text', text: 'Two views' }, { type: 'image', mimeType: 'image/jpeg', data: jpeg }, { type: 'image', mimeType: 'image/jpeg', data: jpeg },
        ] })
        await expect(instance.uploadPhoto({ operationId, id: crypto.randomUUID(), order: 2, name: 'late.jpg', mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model: jpeg })).rejects.toThrow('already admitted')
        expect(await instance.getSteerAdmission(operationId)).toMatchObject({ state: 'accepted', entryId: 'steer-entry' })
        expect((await instance.listConversationPhotos()).images).toHaveLength(2)
      } finally { steer.mockRestore(); drain.mockRestore() }
    })
  })
  it('admits one image-only Pi message and correlates the photo before model execution', async () => {
    const sessionId = crypto.randomUUID()
    const operationId = crypto.randomUUID()
    const photoId = crypto.randomUUID()
    const stub = env.PiSession.getByName(sessionId) as DurableObjectStub<PiSession>
    await stub.initialize({ id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
    const upload = { operationId, id: photoId, order: 0, name: 'test.jpg', mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model: jpeg }
    await stub.uploadPhoto(upload)
    await runInDurableObject(stub, async (instance, state) => {
      const internals = instance as unknown as { getLane(): Promise<AgentLane>; scheduleMemoryExtraction(): void }
      const lane = await internals.getLane()
      const accept = vi.spyOn(lane, 'accept')
      const drive = vi.spyOn(lane, 'drive').mockImplementation(async ({ operationId: id }) => ({ ok: true, value: { kind: 'settled', outcome: { operationId: id, status: 'completed' } } }) as Awaited<ReturnType<AgentLane['drive']>>)
      const extraction = vi.spyOn(internals, 'scheduleMemoryExtraction').mockImplementation(() => {})
      const events: unknown[] = []
      try {
        await instance.prompt({ send: (event: unknown) => { events.push(event) }, end: () => {} } as unknown as Parameters<PiSession['prompt']>[0], { operationId, prompt: '', photoIds: [photoId] })
        expect(accept).toHaveBeenCalledTimes(1)
        expect(accept.mock.calls[0]?.[0]).toMatchObject({ operationId, prompt: '', images: [{ type: 'image', mimeType: 'image/jpeg', data: jpeg }] })
        expect(events).toContainEqual(expect.objectContaining({ type: 'accepted', operationId }))
        await instance.prompt({ send: (event: unknown) => { events.push(event) }, end: () => {} } as unknown as Parameters<PiSession['prompt']>[0], { operationId, prompt: '', photoIds: [photoId] })
        expect(accept).toHaveBeenCalledTimes(1)
        expect(events.filter((event) => typeof event === 'object' && event !== null && 'type' in event && event.type === 'accepted')).toHaveLength(2)
        await expect(instance.uploadPhoto({ ...upload, id: crypto.randomUUID(), order: 1 })).rejects.toThrow('already admitted')
        await expect(instance.uploadPhoto({ ...upload, preview: otherJpeg })).rejects.toThrow('identity conflict')
        expect(await instance.uploadPhoto(upload)).toMatchObject({ id: photoId, entryId: expect.any(String) })
        expect(await instance.getPromptAdmission(operationId)).toMatchObject({ state: 'accepted' })
        expect((await instance.listConversationPhotos()).images.map((photo) => photo.id)).toEqual([photoId])
        const branch = await instance.getBranch()
        expect(branch.entries.filter((entry) => entry.message?.role === 'user')).toHaveLength(1)
        expect(branch.entries.find((entry) => entry.message?.role === 'user')?.photos).toMatchObject([{ id: photoId, operationId }])
        expect(branch.entries.find((entry) => entry.message?.role === 'user')?.message?.content).toEqual([])
        expect(JSON.stringify(branch)).not.toContain(jpeg)
        expect(new PiSessionStorage(state.storage).entriesInOrder().find((entry) => entry.type === 'message' && entry.message.role === 'user'))
          .toMatchObject({ message: { content: [{ type: 'image', data: jpeg, mimeType: 'image/jpeg' }] } })
        expect(await lane.getResult(operationId, BACKGROUND_CONTEXT)).toBeUndefined()
      } finally { accept.mockRestore(); drive.mockRestore(); extraction.mockRestore() }
    })
    const browserBranch = await (stub as unknown as { getBranch(): ReturnType<PiSession['getBranch']> }).getBranch()
    expect(browserBranch.entries.find((entry) => entry.message?.role === 'user')?.photos).toMatchObject([{ id: photoId, operationId }])
    expect(JSON.stringify(browserBranch)).not.toContain(jpeg)
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
      storage.admitPromptSubmission(operationId, 'fingerprint', [photoId, secondPhotoId])
      storage.acceptPromptSubmission(operationId, 'entry-from-another-branch')
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

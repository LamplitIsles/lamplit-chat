import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import worker from '../server'

const password = 'test-owned-long-password-123456'
const minimalEnv = { AUTH_PASSWORD: password, COMPANION_SESSION_ID: '' } as unknown as Env

describe('Free entry Worker', () => {
  it('rejects anonymous HTTP and WebSocket requests before routing', async () => {
    for (const path of ['/', '/api/companion-config', '/api/display-names', '/api/conversation-images/test', '/api/agents/PiSession/test']) {
      const response = await worker.fetch(new Request(`https://example.test${path}`), minimalEnv)
      expect(response.status).toBe(401)
    }
    const response = await worker.fetch(new Request('https://example.test/api/agents/PiSession/test', { headers: { upgrade: 'websocket' } }), minimalEnv)
    expect(response.status).toBe(401)
  })

  it('sets an authenticated cookie and reports photos unavailable without R2', async () => {
    const response = await worker.fetch(new Request('https://example.test/api/companion-config', {
      headers: { authorization: `Basic ${btoa(`owner:${password}`)}` },
    }), minimalEnv)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionId: null, photosEnabled: false, accountSettingsHref: null })
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('protects interface images and persists uploaded bytes with R2 metadata', async () => {
    const workerEnv = new Proxy(env, { get: (target, key) => key === 'AUTH_PASSWORD' ? password : Reflect.get(target, key) }) as Env
    for (const slot of ['avatar', 'user-avatar', 'background']) {
      const url = `https://example.test/api/ui-assets/${slot}`
      const authorization = `Basic ${btoa(`owner:${password}`)}`
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
      expect((await worker.fetch(new Request(url), workerEnv)).status).toBe(401)
      const uploaded = await worker.fetch(new Request(url, { method: 'PUT', headers: { authorization, 'content-type': 'image/jpeg', origin: 'https://example.test' }, body: bytes }), workerEnv)
      expect(uploaded.status).toBe(200)
      const image = await worker.fetch(new Request(url, { headers: { authorization } }), workerEnv)
      expect(image.status).toBe(200)
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes)
      const listing = await worker.fetch(new Request('https://example.test/api/ui-assets', { headers: { authorization } }), workerEnv)
      expect(await listing.json()).toEqual({ assets: [{ slot, mediaType: 'image/jpeg' }] })
      const removed = await worker.fetch(new Request(url, { method: 'DELETE', headers: { authorization, origin: 'https://example.test' } }), workerEnv)
      expect(removed.status).toBe(204)
      expect((await worker.fetch(new Request(url, { headers: { authorization } }), workerEnv)).status).toBe(404)
    }
  })
  it('stores UI names separately per hosted owner and restores defaults when cleared', async () => {
    const workerEnv = new Proxy(env, { get: (target, key) => key === 'HOSTED_MODE' ? 'true' : key === 'CHAT_INTERNAL_SECRET' ? 'fixture-internal' : Reflect.get(target, key) }) as Env
    const owners = [crypto.randomUUID(), crypto.randomUUID()]
    const url = 'https://example.test/api/display-names'
    const headers = (owner: string) => ({ 'x-lamplit-instance': owner, 'x-lamplit-internal-secret': 'fixture-internal', 'content-type': 'application/json', origin: 'https://example.test' })
    const read = async (owner: string) => worker.fetch(new Request(url, { headers: headers(owner) }), workerEnv)
    const put = async (owner: string, names: unknown) => worker.fetch(new Request(url, { method: 'PUT', headers: headers(owner), body: JSON.stringify(names) }), workerEnv)
    try {
      expect((await worker.fetch(new Request(url), workerEnv)).status).toBe(403)
      expect(await (await read(owners[0])).json()).toEqual({ companionName: '', userName: '' })
      const names = { companionName: ' 雾蓝👩‍👩‍👧‍👦 ', userName: ' 小林 ' }
      const saved = await put(owners[0], names)
      expect(saved.status).toBe(200)
      expect(saved.headers.get('cache-control')).toBe('private, no-store')
      expect(await saved.json()).toEqual({ companionName: '雾蓝👩‍👩‍👧‍👦', userName: '小林' })
      expect(await (await read(owners[0])).json()).toEqual({ companionName: '雾蓝👩‍👩‍👧‍👦', userName: '小林' })
      expect(await (await read(owners[1])).json()).toEqual({ companionName: '', userName: '' })
      for (const bad of [null, {}, { companionName: 123, userName: '' }, { companionName: '蓝'.repeat(33), userName: '' }, { companionName: 'a\u0000b', userName: '' }]) {
        expect((await put(owners[0], bad)).status).toBe(400)
      }
      expect((await put(owners[0], { companionName: '🌙'.repeat(32), userName: '' })).status).toBe(200)
      expect((await worker.fetch(new Request(url, { method: 'PUT', headers: { ...headers(owners[0]), origin: 'https://evil.test' }, body: JSON.stringify(names) }), workerEnv)).status).toBe(403)
      expect((await worker.fetch(new Request(url, { method: 'PUT', headers: headers(owners[0]), body: 'x'.repeat(2049) }), workerEnv)).status).toBe(413)
      expect((await worker.fetch(new Request(url, { method: 'PUT', headers: headers(owners[0]), body: '{' }), workerEnv)).status).toBe(400)
      expect((await put(owners[0], { companionName: '', userName: '' })).status).toBe(200)
      expect(await (await read(owners[0])).json()).toEqual({ companionName: '', userName: '' })
    } finally {
      for (const owner of owners) await env.COMPUTER_R2!.delete(`instances/${owner}/display-names.json`)
    }
  })

})

import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import worker from '../server'

const password = 'test-owned-long-password-123456'
const minimalEnv = { AUTH_PASSWORD: password, COMPANION_SESSION_ID: '' } as unknown as Env

describe('Free entry Worker', () => {
  it('rejects anonymous HTTP and WebSocket requests before routing', async () => {
    for (const path of ['/', '/api/companion-config', '/api/conversation-images/test', '/api/agents/PiSession/test']) {
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
    const url = 'https://example.test/api/ui-assets/avatar'
    const authorization = `Basic ${btoa(`owner:${password}`)}`
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    expect((await worker.fetch(new Request(url), workerEnv)).status).toBe(401)
    const uploaded = await worker.fetch(new Request(url, { method: 'PUT', headers: { authorization, 'content-type': 'image/jpeg', origin: 'https://example.test' }, body: bytes }), workerEnv)
    expect(uploaded.status).toBe(200)
    const image = await worker.fetch(new Request(url, { headers: { authorization } }), workerEnv)
    expect(image.status).toBe(200)
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes)
    expect((await worker.fetch(new Request('https://example.test/api/ui-assets', { headers: { authorization } }), workerEnv)).status).toBe(200)
    const removed = await worker.fetch(new Request(url, { method: 'DELETE', headers: { authorization, origin: 'https://example.test' } }), workerEnv)
    expect(removed.status).toBe(204)
    expect((await worker.fetch(new Request(url, { headers: { authorization } }), workerEnv)).status).toBe(404)
  })
})

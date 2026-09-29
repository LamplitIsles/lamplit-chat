import { describe, expect, it } from 'vitest'
import { authorize } from './auth'

const password = 'a-long-test-owned-password-12345'

describe('single-user authentication', () => {
  it('requires a configured password and rejects anonymous requests', async () => {
    const request = new Request('https://example.test/api/companion-config')
    expect((await authorize(request, undefined)).authorized).toBe(false)
    expect((await authorize(request, password)).authorized).toBe(false)
  })

  it('issues an HttpOnly cookie after Basic auth and accepts it on a WebSocket handshake', async () => {
    const basic = new Request('https://example.test/', { headers: { authorization: `Basic ${btoa(`owner:${password}`)}` } })
    const result = await authorize(basic, password)
    expect(result).toMatchObject({ authorized: true })
    expect(result.setCookie).toContain('HttpOnly; Secure; SameSite=Strict')
    const websocket = new Request('https://example.test/api/agents/PiSession/test', { headers: {
      cookie: result.setCookie!.split(';')[0], upgrade: 'websocket',
    } })
    expect((await authorize(websocket, password)).authorized).toBe(true)
    expect((await authorize(websocket, `${password}-rotated`)).authorized).toBe(false)
  })
})

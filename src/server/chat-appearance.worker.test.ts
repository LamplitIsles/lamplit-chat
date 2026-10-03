import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { APPEARANCE_PATH, validateChatAppearance } from '@lamplit/contracts'
import worker from '../server'

it('serves configured names and existing assets under the authenticated instance scope', async () => {
  const instance = crypto.randomUUID()
  const prefix = `instances/${instance}/`
  const bucket = env.COMPUTER_R2!
  const png = new Uint8Array([137,80,78,71,13,10,26,10])
  await bucket.put(`${prefix}display-names.json`, JSON.stringify({ companionName: 'Mica Display', userName: 'Neil Display' }))
  for (const slot of ['avatar', 'user-avatar', 'background']) await bucket.put(`${prefix}ui-assets/${slot}`, png, { httpMetadata: { contentType: 'image/png' } })
  const workerEnv = { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-secret' }
  const headers = { 'x-lamplit-instance': instance, 'x-lamplit-internal-secret': 'fixture-secret' }
  const read = (path: string, requestHeaders = headers, method = 'GET') => worker.fetch(new Request(`https://chat.fixture${path}`, { headers: requestHeaders, method }), workerEnv)
  expect((await read(APPEARANCE_PATH, {} as typeof headers)).status).toBe(403)
  const response = await read(APPEARANCE_PATH)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const profile = validateChatAppearance(await response.json())
  expect(profile).toEqual({ companionName: 'Mica Display', userName: 'Neil Display', companionAvatar: '/api/ui-assets/avatar', userAvatar: '/api/ui-assets/user-avatar', backgrounds: { landscape: '/api/ui-assets/background', portrait: '/api/ui-assets/background' } })
  for (const url of [profile.companionAvatar!, profile.userAvatar!, profile.backgrounds!.portrait]) {
    const image = await read(url)
    expect(image.status).toBe(200)
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png)
  }
  expect(validateChatAppearance(await (await read(APPEARANCE_PATH, { ...headers, 'x-lamplit-instance': crypto.randomUUID() })).json())).toEqual({ companionName: '', userName: '' })
  expect((await read(APPEARANCE_PATH, headers, 'POST')).status).toBe(405)
})

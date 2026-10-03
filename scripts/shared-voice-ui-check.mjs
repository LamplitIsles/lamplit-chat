// Requires the adjacent app's existing Playwright dependency, not a browser rebuild.
import { chromium, expect } from '../../lamplit-app/node_modules/@playwright/test/index.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
const origin = `http://127.0.0.1:${process.env.VOICE_FIXTURE_PORT || 8898}`
const evidence = '.scratch/streaming-voice-input'
await mkdir(`${evidence}/screenshots`, { recursive: true })
const authorization = `Basic ${Buffer.from('owner:fixture-password-long-enough').toString('base64')}`
const state = async (patch) => {
  const response = await fetch(`${origin}/__fixture/state`, { ...(patch ? { method: 'POST', body: JSON.stringify(patch) } : {}) })
  return response.json()
}
expect((await fetch(`${origin}/api/voice/capability`)).status).toBe(401)
expect(await (await fetch(`${origin}/api/voice/capability`, { headers: { authorization } })).json()).toEqual({ available: true })
expect((await state()).calls).toBe(0)
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const results = []
try {
  for (const width of [390, 1280]) {
    await state({ enabled: true, status: 200, text: 'recognized final' })
    const context = await browser.newContext({ viewport: { width, height: 844 }, permissions: ['microphone'], httpCredentials: { username: 'owner', password: 'fixture-password-long-enough' } })
    await context.addInitScript(() => {
      window.voiceProbe = { tracks: [], rates: [] }
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await get(...args); window.voiceProbe.tracks.push(...stream.getTracks()); return stream }
      const Audio = window.AudioContext
      window.AudioContext = class extends Audio { constructor(options) { super(options); window.voiceProbe.rates.push(this.sampleRate) } }
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`${origin}/`)
    const input = page.locator('#companion-textarea'), mic = page.locator('.companion-microphone'), send = page.locator('.companion-send')
    await expect(input).toBeVisible()
    const release = () => expect.poll(() => page.evaluate(() => window.voiceProbe.tracks.every(t => t.readyState === 'ended'))).toBe(true)
    const start = async () => {
      const before = await state()
      await expect(mic).toBeEnabled(); await mic.click()
      await expect(mic).toHaveAttribute('data-state', 'recording')
      await expect.poll(async () => (await state()).frames).toBeGreaterThan(before.frames)
      return before
    }
    await input.fill('before REPLACE after')
    await input.evaluate(el => { el.focus(); el.setSelectionRange(7, 14) })
    const before = await start()
    await expect(input).toHaveValue('before REPLACE after')
    await expect(send).toBeDisabled()
    expect((await state()).modelCalls ?? 0).toBe(before.modelCalls ?? 0)
    expect(await page.evaluate(() => window.voiceProbe.rates)).toEqual([16000])
    await page.screenshot({ path: `${evidence}/screenshots/recording-${width}.png`, fullPage: true })
    await mic.click()
    await expect(input).toHaveValue('before recognized final after')
    await release()
    expect((await state()).modelCalls ?? 0).toBe(before.modelCalls ?? 0)
    await page.screenshot({ path: `${evidence}/screenshots/draft-${width}.png`, fullPage: true })
    await input.fill(`edited final ${width}`); await send.click()
    await expect(page.getByText(`edited final ${width}`, { exact: true })).toBeVisible()
    await expect.poll(async () => (await state()).modelCalls ?? 0).toBeGreaterThan(before.modelCalls ?? 0)
    await expect(page.getByText('Complete Pi reply', { exact: true }).last()).toBeVisible({ timeout: 15000 })
    await input.fill('cancel draft')
    const cancelling = await start()
    await page.locator('.companion-attach').click()
    await expect(mic).toHaveAttribute('data-state', 'idle'); await release()
    await expect(input).toHaveValue('cancel draft')
    await expect.poll(async () => (await state()).closes).toBeGreaterThan(cancelling.closes)
    await state({ status: 500 })
    const calls = (await state()).calls
    await mic.click()
    await expect(page.locator('[data-testid="companion-voice-error-status"]')).toBeVisible()
    await expect.poll(async () => (await state()).calls).toBe(calls + 1)
    await release(); await expect(input).toHaveValue('cancel draft')
    await state({ enabled: false, status: 200 })
    const disabled = await state()
    await page.reload(); await expect(mic).toBeDisabled()
    await input.fill(`disabled text ${width}`); await send.click()
    await expect(page.getByText(`disabled text ${width}`, { exact: true })).toBeVisible()
    await expect.poll(async () => (await state()).modelCalls ?? 0).toBeGreaterThan(disabled.modelCalls ?? 0)
    expect((await state()).calls).toBe(disabled.calls)
    await page.screenshot({ path: `${evidence}/screenshots/disabled-${width}.png`, fullPage: true })
    expect(errors).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    results.push({ width, actualRate: 16000, draft: 'before recognized final after', autosend: false, explicitSend: true, cancel: true, error: true, disabledText: true })
    await context.close()
  }
  await writeFile(`${evidence}/browser-evidence.json`, JSON.stringify({ origin, results, provider: await state() }, null, 2))
  console.log('Shared frozen browser passed on actual authenticated Pi/workerd at 390/1280: streaming PCM, selected final draft, no autosend, explicit send, cancel/error cleanup and disabled text chat.')
} finally { await browser.close() }

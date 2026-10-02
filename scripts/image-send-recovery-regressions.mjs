// Additional retained text/voice/four-panel checks on the same reviewed browser and native host.
import { chromium, expect } from '../.scratch/image-send-recovery/acceptance/node_modules/@playwright/test/index.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
const origin = process.env.APP_ACCEPTANCE_URL ?? 'http://127.0.0.1:8973/slice/'
const evidence = new URL('../.scratch/image-send-recovery/regressions/', import.meta.url).pathname
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const results = []
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN', permissions: ['microphone'], httpCredentials: { username: 'owner', password: 'fixture-password-long-enough' } })
    const control = async action => { const response = await context.request.post(new URL('/__test/image-send-recovery', origin).href, { data: { action } }); expect(response.ok()).toBe(true); return response.json() }
    await control('reset'); await control('regressions')
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(origin)
    const input = page.locator('#companion-textarea'), send = page.getByRole('button', { name: '发送消息', exact: true }), mic = page.locator('.companion-microphone')
    await expect(input).toBeVisible()
    await input.fill(`Retained text ${width}`); await send.click()
    await expect(page.getByText(`Retained text ${width}`, { exact: true })).toBeVisible()
    await expect(page.getByText('Complete Pi reply', { exact: true }).last()).toBeVisible()
    const before = (await control('state')).executions
    await input.fill('before REPLACE after')
    await input.evaluate(el => { el.focus(); el.setSelectionRange(7, 14) })
    await mic.click(); await expect(mic).toHaveAttribute('data-state', 'recording'); await expect(send).toBeDisabled()
    expect((await control('state')).executions).toBe(before)
    await expect.poll(async () => (await (await context.request.get(new URL('/__fixture/state', origin).href)).json()).frames).toBeGreaterThan(0)
    await mic.click(); await expect(input).toHaveValue('before recognized final after')
    expect((await control('state')).executions).toBe(before)
    await input.fill(`Edited voice ${width}`); await send.click()
    await expect(page.getByText(`Edited voice ${width}`, { exact: true })).toBeVisible()
    await expect.poll(async () => (await control('state')).executions).toBe(before + 1)
    await page.reload(); await expect(page.getByText(`Edited voice ${width}`, { exact: true })).toBeVisible()
    expect((await control('state')).executions).toBe(before + 1)
    await page.getByRole('button', { name: '查看 Companion 关系资料', exact: true }).click()
    const drawer = page.getByTestId('companion-relationship-drawer')
    await expect(drawer).toBeVisible(); await expect(drawer.locator('dd').filter({ hasText: '原生关系回归内容' })).toHaveText('原生关系回归内容')
    await drawer.getByRole('tab', { name: '日记', exact: true }).click()
    await drawer.getByRole('button', { name: '2026-10-02', exact: false }).click()
    await expect(drawer.getByText('原生日记回归内容。', { exact: true })).toBeVisible()
    await drawer.getByRole('tab', { name: '相册', exact: true }).click()
    await expect(drawer.getByText('还没有聊天图片。', { exact: true })).toBeVisible()
    await drawer.getByRole('tab', { name: '自动唤醒', exact: true }).click()
    await expect(drawer.locator('.companion-alarm-message').filter({ hasText: '原生提醒回归内容' })).toBeVisible()
    await page.screenshot({ path: `${evidence}/four-panels-${width}.png`, fullPage: true })
    await page.keyboard.press('Escape'); await expect(drawer).not.toBeVisible()
    await page.screenshot({ path: `${evidence}/text-voice-${width}.png`, fullPage: true })
    expect(errors).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    results.push({ width, text: true, reconnectNoReplay: true, streamingVoiceDraft: true, voiceExplicitSend: true, panels: ['relationship', 'diary', 'album', 'reminders'], errors })
    await context.close()
  }
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2) + '\n')
  console.log('Retained text/streaming voice/four-panel browser regressions passed on frozen browser and native workerd.')
} finally { await browser.close() }

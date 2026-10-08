import { expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import { nativeOptions } from './fixtures/native-harness-options'
import { nativeReply } from './fixtures/native-provider'
import { runNative, type NativeFixture } from './fixtures/native-session'
import { createInjectedMcpTools, remoteToolName } from './injected-remote-mcp'

it('offers MCP tools through native Worker fetch on a hosted persisted root', async () => {
  const id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
  const nativeFetch = globalThis.fetch
  const bodies: { tools: { function: { name: string } }[] }[] = []
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('https://native-mcp.fixture.invalid/')) return nativeFetch(input, init)
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    bodies.push(JSON.parse(init!.body as string)); return nativeReply('openrouter', 'Test-owned native host reply')
  })
  try {
    const registry = env.PiRegistry.getByName(id) as DurableObjectStub<PiRegistry>
    const created = await registry.ensureDefaultSession()
    const stub = env.PiSession.getByName(`${id}:${created.id}`) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, async instance => {
      Reflect.set(instance, 'name', `${id}:${created.id}`)
      const environment = { ...env, HOSTED_MODE: 'true', MCP_CONFIG: undefined as string | undefined }
      Reflect.set(instance, 'env', environment)
      Reflect.set(instance, 'modelEnvironment', async () => nativeOptions().env)
      vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
      vi.spyOn(instance as unknown as { schedulePendingDrain(): Promise<void> }, 'schedulePendingDrain').mockResolvedValue()
      const native = instance as unknown as NativeFixture
      await runNative(instance, 'Seed test-owned persisted root without MCP')
      await native.native.dispose()
      environment.MCP_CONFIG = JSON.stringify({ [id]: [{ name: 'fixture', url: 'https://native-mcp.fixture.invalid/mcp', bearerToken: 'fictional-native-token' }] })
      await runNative(instance, 'Fresh idle hosted native submission')
      const name = await remoteToolName('fixture', 'echo')
      expect(bodies.at(-1)!.tools.some(tool => tool.function.name === name)).toBe(true)
      await native.native.dispose()
    })
  } finally { provider.mockRestore(); error.mockRestore(); vi.restoreAllMocks() }
})

it.each(['initialize', 'notifications/initialized', 'tools/list', 'DELETE'])('never follows a credential-bearing redirect during %s', async stage => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const config = JSON.stringify({ singleton: [{ name: 'fixture', url: `https://native-mcp.fixture.invalid/mcp?case=${encodeURIComponent(stage)}`, bearerToken: 'fictional-native-token' }] })
    const discovery = await createInjectedMcpTools(config, null, [])
    expect(discovery.tools).toHaveLength(stage === 'DELETE' ? 1 : 0)
    const response = await fetch(`https://native-mcp.fixture.invalid/inspect?case=${encodeURIComponent(stage)}`)
    const { calls, forbiddenFollows } = await response.json() as { calls: { method: string; authenticated: boolean }[]; forbiddenFollows: number }
    expect(forbiddenFollows).toBe(0)
    expect(calls.some(call => call.method === stage)).toBe(true)
    expect(calls.every(call => call.authenticated)).toBe(true)
    // A followed redirect would hit the forbidden hostname, never this peer.
    // Session cleanup is best effort; its redirect cannot invalidate prior metadata.
  } finally { error.mockRestore() }
})

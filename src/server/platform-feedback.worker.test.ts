import { selfHostModelEnvironment } from './model-catalog'
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { PiSession } from './pi-session'
import { runNative, type NativeFixture } from './fixtures/native-session'

it('actual PiSession rebuild updates tools and projects narrowly authorized feedback through a fake provider', async () => {
  const instanceId = '11111111-1111-4111-8111-111111111111'
  const sessionId = crypto.randomUUID()
  const stub = env.PiSession.getByName(`${instanceId}:${sessionId}`) as DurableObjectStub<PiSession>
  const bodies: Array<{ tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> }> = []
  const submitted: Array<Record<string, unknown>> = []
  let invoked = false
  const fakeProvider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url instanceof Request ? url.url : url.toString()).toBe('https://openrouter.ai/api/v1/chat/completions')
    const body = JSON.parse(init!.body as string); bodies.push(body)
    const call = body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'submit_platform_feedback') && !invoked
    if (call) invoked = true
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'trusted-provider-call', type: 'function', function: { name: 'submit_platform_feedback', arguments: JSON.stringify({ problem: 'Fictional navigation problem' }) } }] } : { role: 'assistant', content: 'Fixture reply' }
    return new Response([
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  try {
    await runInDurableObject(stub, async instance => {
      // Emulate the DO's assigned name, not a model-selected identity. All state belongs to this fixture.
      Reflect.set(instance, 'name', `${instanceId}:${sessionId}`)
      vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
      const localEnv = { ...env, HOSTED_MODE: 'false', CHAT_INTERNAL_SECRET: 'fixture-feedback-secret', PLATFORM: { fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(url, init)
        expect(request.headers.get('x-lamplit-internal-secret')).toBe('fixture-feedback-secret')
        if (request.url.includes('/internal/chat-search/')) return Response.json({ enabled: false })
        expect(request.url).toBe(`https://app.lamplit.run/internal/chat-feedback/${instanceId}`)
        submitted.push(await request.json())
        return Response.json({ feedback: { id: crypto.randomUUID(), source: 'machine', status: 'received', created_at: new Date().toISOString(), account: 'PRIVATE@example.invalid', problem: 'PRIVATE' } }, { status: 201 })
      } } }
      Reflect.set(instance, 'env', localEnv)
      // No live model-settings binding or key resolution; still use the actual harness/provider path.
      Reflect.set(instance, 'modelEnvironment', async () => selfHostModelEnvironment(env))
      await instance.initialize({ lineage: { type: 'new' }, id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      const native = instance as unknown as NativeFixture
      const getHarness = () => native.getHarness()
      await getHarness()
      await runNative(instance, 'Fixture greeting')
      expect(bodies[0].tools.map(tool => tool.function.name)).not.toContain('submit_platform_feedback')
      expect(bodies[0].messages[0].content).not.toContain('standing authorization')
      expect(submitted).toHaveLength(0)
      localEnv.HOSTED_MODE = 'true'
      await native.native.dispose()
      await getHarness()
      const lane = await native.getLane()
      expect((await lane.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).toContain('submit_platform_feedback')
      await runNative(instance, 'Consider fictional Lamplit feedback')
      expect(bodies[1].tools.map(tool => tool.function.name)).toContain('submit_platform_feedback')
      expect(bodies[1].messages[0].content).toContain('Only this tool has that standing authorization')
      expect(bodies[1].messages[0].content).toContain('get explicit authorization before sending messages')
      expect(submitted).toHaveLength(1)
      expect(submitted[0]).toMatchObject({ problem: 'Fictional navigation problem', submission_key: expect.any(String) })
      const toolMessages = JSON.stringify(bodies[2].messages.filter(message => message.role === 'tool'))
      expect(JSON.parse(bodies[2].messages.find(message => message.role === 'tool')!.content)).toMatchObject({ ok: true, source: 'machine', status: 'received' })
      expect(toolMessages).not.toContain('PRIVATE')
      Reflect.set(instance, 'modelEnvironment', async () => ({ ...selfHostModelEnvironment(env), PI_SYSTEM_PROMPT: 'Custom fixture companion base' }))
      await native.native.dispose()
      await getHarness()
      await runNative(instance, 'Fixture custom prompt')
      expect(bodies.at(-1)!.messages[0].content).toContain('Custom fixture companion base')
      expect(bodies.at(-1)!.messages[0].content).toContain('Only this tool has that standing authorization')
      localEnv.HOSTED_MODE = 'false'
      await native.native.dispose()
      await getHarness()
      const selfhostLane = await native.getLane()
      expect((await selfhostLane.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).not.toContain('submit_platform_feedback')
      await runNative(instance, 'Fixture selfhost greeting')
      expect(bodies.at(-1)!.messages[0].content).not.toContain('standing authorization')
      expect(submitted).toHaveLength(1)
    })
  } finally { fakeProvider.mockRestore() }
})

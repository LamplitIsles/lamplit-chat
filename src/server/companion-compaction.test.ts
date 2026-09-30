import { expect, it, vi } from 'vitest'
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session'
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from '@earendil-works/pi-agent-core/harness/context'
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction, type AgentLane } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createPiHarness } from './create-pi-harness'
import { DEFAULT_COMPANION_COMPACTION_PROMPT as defaultPrompt } from './companion-compaction-prompt'

const env = { MODEL_API_KEY: 'fictional-key', MODEL_BASE_URL: 'https://fictional.invalid/v1', AI_MODEL: 'fictional-model', MODEL_MAX_TOKENS: '2000', MODEL_CONTEXT_WINDOW: '4000' } as unknown as Env
const usage = { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
function assistant(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'configured-provider', model: 'fictional-model', stopReason: 'stop', timestamp: Date.now(), usage }
}
function offlineProvider() {
  const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = []
  let failure = false, cancel: AbortController | undefined, overflow = false
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url instanceof Request ? url.url : url.toString()).toBe('https://fictional.invalid/v1/chat/completions')
    const request = JSON.parse(init!.body as string)
    requests.push(request)
    if (cancel) { cancel.abort(); throw new DOMException('cancelled', 'AbortError') }
    if (failure) return Response.json({ error: { message: 'fictional failure' } }, { status: 400 })
    if (overflow && !request.messages[0].content.includes('checkpoint')) {
      overflow = false
      return Response.json({ error: { message: 'maximum context length exceeded' } }, { status: 400 })
    }
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Fictional checkpoint ' + requests.length }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ]
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  return { requests, fetch, fail: () => { failure = true }, cancel: (controller: AbortController) => { cancel = controller }, overflow: () => { overflow = true } }
}
async function attach(session: Parameters<typeof createPiHarness>[0]['session'], loadPrompt: () => Promise<string>, settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 1000, keepRecentTokens: 100 }, modelEnv = env) {
  const harness = await createPiHarness({ env: modelEnv, session, tools: [], memory: { getMemoryContext: async () => '', getRelationshipContext: async () => '' }, compaction: settings,
    loadInstructions: async () => 'Read other root Markdown when needed.', loadCompactionPrompt: loadPrompt, getUserTimeZone: async () => 'Asia/Shanghai' })
  const lane = await harness.lane('main', ctx)
  return { harness, lane }
}
async function history(lane: AgentLane, prefix = 'fictional', turns = 5) {
  for (let i = 0; i < turns; i++) {
    await lane.appendMessage({ role: 'user', content: `${prefix} user ${i} ` + 'a'.repeat(500), timestamp: Date.now() }, ctx)
    await lane.appendMessage(assistant(`${prefix} answer ${i}`), ctx)
  }
}

it('uses default → custom → reset on actual manual requests, includes previous summary, usage, and reconstructs native persisted context', async () => {
  const provider = offlineProvider()
  try {
    const repo = new MemorySessionRepo()
    const session = await repo.create({}, ctx)
    let effective = defaultPrompt
    const { lane } = await attach(session, async () => effective)
    await history(lane)
    const prepared = prepareCompaction(await lane.findEntries({ order: 'oldestFirst' }, ctx), { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 1000, keepRecentTokens: 100 })
    expect(prepared.ok).toBe(true)
    const first = await lane.compact(undefined, ctx)
    expect(first.ok).toBe(true)
    expect(provider.requests[0].messages[0].content).toBe(defaultPrompt)
    const entry = await lane.findEntry({ order: 'newestFirst' }, ctx)
    expect(entry).toMatchObject({ type: 'compaction', summary: 'Fictional checkpoint 1', usage: { totalTokens: 25 } })
    if (prepared.ok && prepared.value && entry?.type === 'compaction') expect(entry.retainedTail).toEqual(prepared.value.retainedTail)
    effective = 'Custom continuity checkpoint. Only summarize fictional evidence.'
    await history(lane, 'new-evidence', 3)
    expect((await lane.compact({ customInstructions: 'Runtime focus fixture' }, ctx)).ok).toBe(true)
    const customRequest = provider.requests.at(-1)!
    expect(customRequest.messages[0].content).toBe(effective)
    expect(JSON.stringify(customRequest.messages[1].content)).toContain('Fictional checkpoint 1')
    expect(JSON.stringify(customRequest.messages[1].content)).toContain('new-evidence')
    effective = defaultPrompt
    await history(lane, 'reset-evidence', 3)
    expect((await lane.compact(undefined, ctx)).ok).toBe(true)
    expect(provider.requests.at(-1)!.messages[0].content).toBe(defaultPrompt)
    const savedEntries = await lane.findEntries({ order: 'oldestFirst' }, ctx)
    await session.close(ctx)
    const rebuilt = await repo.open((await repo.list(undefined, ctx))[0], ctx)
    const restored = await attach(rebuilt, async () => effective)
    expect(await restored.lane.findEntries({ order: 'oldestFirst' }, ctx)).toEqual(savedEntries)
    expect(await rebuilt.getStats(ctx)).toMatchObject({ usage: { totalTokens: 75 } })
    expect((await restored.lane.prompt('Continue fictional conversation', undefined, ctx)).ok).toBe(true)
    expect(JSON.stringify(provider.requests.at(-1))).toContain('Fictional checkpoint 3')
  } finally { provider.fetch.mockRestore() }
})

it('preserves Pi split-turn and paired tool tail plus fileOps, using the public serialization truncation', async () => {
  const provider = offlineProvider()
  try {
    const session = await new MemorySessionRepo().create({}, ctx)
    const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 1000, keepRecentTokens: 250 }
    const { lane } = await attach(session, async () => defaultPrompt, settings)
    await history(lane, 'old-evidence', 2)
    await lane.appendMessage({ role: 'user', content: 'Long ongoing fictional turn', timestamp: Date.now() }, ctx)
    for (let i = 0; i < 6; i++) {
      const call = { ...assistant(''), content: [{ type: 'toolCall' as const, id: `fictional-tool-${i}`, name: i ? 'read' : 'write', arguments: { path: `/workspace/fictional-${i}.md`, content: 'fixture' } }] }
      await lane.appendMessage(call, ctx)
      await lane.appendMessage({ role: 'toolResult', toolCallId: `fictional-tool-${i}`, toolName: i ? 'read' : 'write', content: [{ type: 'text', text: 'tool evidence ' + 'x'.repeat(12_000) }], isError: false, timestamp: Date.now() }, ctx)
    }
    await lane.appendMessage(assistant('Recent tail acknowledgement'), ctx)
    const prep = prepareCompaction(await lane.findEntries({ order: 'oldestFirst' }, ctx), settings)
    expect(prep.ok && prep.value?.isSplitTurn).toBe(true)
    expect((await lane.compact(undefined, ctx)).ok).toBe(true)
    const entry = await lane.findEntry({ order: 'newestFirst' }, ctx)
    if (!prep.ok || !prep.value || entry?.type !== 'compaction') throw new Error('Expected native compaction')
    expect(entry.retainedTail).toEqual(prep.value.retainedTail)
    expect(JSON.stringify(provider.requests[0].messages[1].content)).toContain('<split-turn-prefix>')
    expect(JSON.stringify(provider.requests[0].messages[1].content)).toContain('Long ongoing fictional turn')
    expect(entry.details).toMatchObject({ modifiedFiles: ['/workspace/fictional-0.md'] })
    expect(entry.summary).toContain('<modified-files>')
    expect(JSON.stringify(provider.requests[0].messages[1].content).length).toBeLessThan(75_000)
  } finally { provider.fetch.mockRestore() }
})

it.each(['failure', 'cancel', 'unconfigured'] as const)('%s leaves original conversation/context intact and creates no summary', async mode => {
  const provider = offlineProvider()
  try {
    const session = await new MemorySessionRepo().create({}, ctx)
    const { lane } = await attach(session, async () => defaultPrompt, undefined, mode === 'unconfigured' ? { ...env, MODEL_API_KEY: '' } : env)
    await history(lane)
    const before = await lane.findEntries({ order: 'oldestFirst' }, ctx)
    const controller = new AbortController()
    if (mode === 'failure') provider.fail()
    if (mode === 'cancel') provider.cancel(controller)
    try {
      const result = await lane.compact(undefined, withAbortSignal(controller.signal, ctx))
      expect(result.ok && result.value.compaction.status).toBe('declined')
    } catch (error) { if (mode !== 'cancel') throw error }
    expect(provider.requests.length).toBe(mode === 'unconfigured' ? 0 : 1)
    expect(await lane.findEntries({ order: 'oldestFirst' }, ctx)).toEqual(before)
  } finally { provider.fetch.mockRestore() }
})

it('automatic threshold requests use the effective prompt and native compaction entry', async () => {
  const provider = offlineProvider()
  try {
    const session = await new MemorySessionRepo().create({}, ctx)
    const { lane } = await attach(session, async () => 'Automatic continuity checkpoint fixture')
    await history(lane, 'threshold-evidence', 20)
    await lane.appendMessage({ ...assistant('Threshold usage fixture'), usage: { ...usage, input: 3500, totalTokens: 3505 } }, ctx)
    expect((await lane.prompt('Next fictional turn', undefined, ctx)).ok).toBe(true)
    expect(provider.requests.some(r => r.messages[0].content === 'Automatic continuity checkpoint fixture')).toBe(true)
    expect((await lane.findEntries({ order: 'oldestFirst' }, ctx)).some(e => e.type === 'compaction')).toBe(true)
  } finally { provider.fetch.mockRestore() }
})

it('overflow recovery makes the real next summary request with the effective prompt, then retries the conversation', async () => {
  const provider = offlineProvider()
  try {
    const session = await new MemorySessionRepo().create({}, ctx)
    const { lane } = await attach(session, async () => 'Overflow continuity checkpoint fixture', { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 })
    await history(lane, 'overflow-evidence', 5)
    provider.overflow()
    const result = await lane.prompt('Overflow next fictional turn', undefined, ctx)
    expect(result.ok && result.value.status).toBe('completed')
    expect(provider.requests.some(r => r.messages[0].content === 'Overflow continuity checkpoint fixture')).toBe(true)
    expect(provider.requests.length).toBe(3)
    expect((await lane.findEntries({ order: 'oldestFirst' }, ctx)).some(e => e.type === 'compaction')).toBe(true)
  } finally { provider.fetch.mockRestore() }
})

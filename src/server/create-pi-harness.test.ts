import { describe, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import { DEFAULT_COMPACTION_SETTINGS, type AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import { MemorySessionRepo } from '@earendil-works/pi-agent-core/harness/session'
import { createPiHarness } from './create-pi-harness'

function tool(name: string): AgentHarnessTool<undefined> {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  }
}

describe('Pi harness tools', () => {
  it('offers newly deployed tools to an existing session', async () => {
    const repo = new MemorySessionRepo()
    const session = await repo.create({}, BACKGROUND_CONTEXT)
    const base = {
      env: { MODEL_API_KEY: 'fixture-key', MODEL_BASE_URL: 'https://example.invalid/v1', AI_MODEL: 'fixture-model' } as unknown as Env,
      session,
      memory: { getMemoryContext: async () => '', getRelationshipContext: async () => '' },
      compaction: DEFAULT_COMPACTION_SETTINGS,
      loadInstructions: async () => null,
      getUserTimeZone: async () => 'Asia/Shanghai',
    }
    const oldHarness = await createPiHarness({ ...base, tools: [tool('read')] })
    expect(await (await oldHarness.lane('main', BACKGROUND_CONTEXT)).getActiveTools(BACKGROUND_CONTEXT)).toEqual(['read'])

    const newHarness = await createPiHarness({ ...base, tools: [tool('read'), tool('read_relationship_history')] })
    expect(await (await newHarness.lane('main', BACKGROUND_CONTEXT)).getActiveTools(BACKGROUND_CONTEXT)).toEqual(['read', 'read_relationship_history'])
  })
})

it('projects the existing prompt, timezone, tools and image through a fake provider and persists its reply', async () => {
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT)
  const requestBodies: Array<Record<string, unknown>> = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(input instanceof Request ? input.url : input.toString()).toBe('https://example.invalid/v1/chat/completions')
    requestBodies.push(JSON.parse(init!.body as string))
    const chunks = [
      { id: 'fixture-response', choices: [{ index: 0, delta: { role: 'assistant', content: 'Offline fixture reply' }, finish_reason: null }] },
      { id: 'fixture-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ]
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })
  try {
    const harness = await createPiHarness({
      env: { MODEL_API_KEY: 'fixture-key', MODEL_BASE_URL: 'https://example.invalid/v1', AI_MODEL: 'fixture-model', PI_SYSTEM_PROMPT: 'Test companion prompt' } as unknown as Env,
      session, tools: [tool('read')], compaction: DEFAULT_COMPACTION_SETTINGS,
      memory: { getMemoryContext: async () => 'Test learned memory', getRelationshipContext: async () => 'Test relationship' },
      loadInstructions: async () => 'Test workspace instructions',
      getUserTimeZone: async () => 'America/New_York',
    })
    const lane = await harness.lane('main', BACKGROUND_CONTEXT)
    await lane.prompt({ role: 'user', timestamp: Date.parse('2026-09-01T00:00:00Z'), content: [
      { type: 'text', text: 'Describe this test image' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ] }, BACKGROUND_CONTEXT)
    expect(requestBodies).toHaveLength(1)
    const body = requestBodies[0]
    expect(body.model).toBe('fixture-model')
    expect(body.tools).toMatchObject([{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }])
    const messages = body.messages as Array<{ role: string; content: unknown }>
    expect(messages[0]).toMatchObject({ role: 'system' })
    for (const text of ['Test companion prompt', 'Test learned memory', 'Test relationship', 'Test workspace instructions']) {
      expect(messages[0].content).toContain(text)
    }
    expect(messages.find(message => message.role === 'user')?.content).toEqual([
      { type: 'text', text: '[Host turn time: 2026-08-31 20:00:00 -04:00 (America/New_York)]' },
      { type: 'text', text: 'Describe this test image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ])
    const entries = await (await session.branch('main', BACKGROUND_CONTEXT))!.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ type: 'message', message: { role: 'user', content: [
      { type: 'text', text: 'Describe this test image' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ] } })
    expect(entries[1]).toMatchObject({ parentId: entries[0].id, type: 'message', message: {
      role: 'assistant', content: [{ type: 'text', text: 'Offline fixture reply' }], stopReason: 'stop',
    } })
  } finally {
    fetch.mockRestore()
  }
})

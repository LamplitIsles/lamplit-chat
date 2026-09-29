import { describe, expect, it } from 'vitest'
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

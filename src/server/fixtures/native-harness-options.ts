import { MemoryStorage } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from 'typebox'
export const nativeOptions = () => ({ storage: new MemoryStorage(), context: BACKGROUND_CONTEXT,
  env: { provider: 'openrouter', model: 'openai/gpt-4o', apiKey: 'fixture-key', thinkingLevel: null, maxOutputTokens: 64 },
  tools: [{ name: 'read', description: 'Read fixture', parameters: Type.Object({}), replay: 'safe' as const, execute: async () => ({ content: [{ type: 'text' as const, text: 'fixture' }] }) }],
  memory: { getMemoryContext: async () => 'Learned fixture memory', getRelationshipContext: async () => 'Fixture relationship' },
  compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 128 }, loadInstructions: async () => 'Workspace fixture instructions',
  getUserTimeZone: async () => 'America/New_York', projectKeet: async (messages: readonly import('@earendil-works/pi-ai').Message[]) => messages, awaitWakeSchedules: async () => {},
})

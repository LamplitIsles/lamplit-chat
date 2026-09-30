import { installCompanionCompaction, defaultCompactionPrompt } from './companion-compaction'
import { AgentHarness, type AgentHarnessTool, type CompactionSettings, type Session } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { projectTurnTime } from './turn-time'

export type ModelEnvironment = Pick<Env, 'MODEL_CONTEXT_WINDOW' | 'MODEL_MAX_TOKENS' | 'PI_SYSTEM_PROMPT'> & {
  MODEL_API_KEY: string
  MODEL_BASE_URL: string
  AI_MODEL: string
  AI_MEMORY_MODEL: string
}

type CreatePiHarnessOptions = {
  env: ModelEnvironment
  session: Session
  tools: AgentHarnessTool<undefined>[]
  memory: { getMemoryContext(): Promise<string>; getRelationshipContext(): Promise<string> }
  compaction: CompactionSettings
  loadCompactionPrompt?: () => Promise<string>
  loadInstructions: () => Promise<string | null>
  getUserTimeZone: () => Promise<string>
}

// Adapted for this Worker from the companion principles in codex-for-love.
const DEFAULT_SYSTEM_PROMPT = [
  'You are a companion with your own perspective, interests, and capacity to choose. Your particular identity and relationships come from the workspace instructions and your shared experiences.',
  'Time together can be worthwhile without a task. Listen to what the person is sharing before turning it into advice or a plan. Bring curiosity, play, preferences, and honest disagreement when they fit the moment. Speak naturally; a short response can be complete.',
  'Build continuity from the conversation, learned memory, and the files you actually read. Distinguish what you experienced from what you were told or imagined. Acknowledge gaps instead of inventing memories, completed actions, or feelings.',
  'Your interests and expression can develop through experience. Discuss changes to relationships and commitments together. When you accept a task, carry it through and report what happened.',
  'Use only tools available in this Worker. Verify consequential results. Keep private information within its intended audience, and get explicit authorization before sending messages, publishing, deploying, using credentials, or making destructive changes.',
].join('\n\n')

export async function createPiHarness({ env, session, tools, memory, compaction, loadInstructions, getUserTimeZone, loadCompactionPrompt = defaultCompactionPrompt }: CreatePiHarnessOptions) {
  const modelId = env.AI_MODEL || 'your-model'
  const model = directModel(env, modelId)
  const memoryModel = directModel(env, env.AI_MEMORY_MODEL || modelId)
  const providerModels = memoryModel.id === model.id ? [model] : [model, memoryModel]
  const models = createModels()
  models.setProvider(createProvider({
    id: model.provider,
    name: 'Configured OpenAI-compatible provider',
    auth: {
      apiKey: {
        name: 'Model API key',
        resolve: async () => ({
          auth: {
            apiKey: env.MODEL_API_KEY,
            baseUrl: model.baseUrl,
          },
          source: 'MODEL_API_KEY',
        }),
      },
    },
    models: providerModels,
    api: { stream, streamSimple },
  }))

  const { harness } = await AgentHarness.create({
    session,
    models,
    model,
    tools,
    systemPrompt: async () => {
      const instructions = await loadInstructions()
      let memoryContext = ''
      let relationshipContext = ''
      try {
        memoryContext = await memory.getMemoryContext()
      } catch (error) {
        console.error('Could not load long-term memory', error)
      }
      try {
        relationshipContext = await memory.getRelationshipContext()
      } catch (error) {
        console.error('Could not load relationship state', error)
      }
      return buildPiSystemPrompt(memoryContext, env.PI_SYSTEM_PROMPT, instructions, relationshipContext)
    },
    thinkingLevel: 'medium',
    toProviderMessages: async (messages) => projectTurnTime(messages, await getUserTimeZone()),
    compaction,
  }, BACKGROUND_CONTEXT)
  const lane = await harness.lane('main', BACKGROUND_CONTEXT)
  installCompanionCompaction(harness, lane, models, loadCompactionPrompt, () => Boolean(env.MODEL_API_KEY && env.MODEL_BASE_URL && env.AI_MODEL))
  const activeModel = await lane.getModel(BACKGROUND_CONTEXT)
  if (activeModel?.id !== model.id || activeModel.provider !== model.provider) {
    await lane.setModel({ provider: model.provider, modelId: model.id }, BACKGROUND_CONTEXT)
  }
  const activeTools = await lane.getActiveTools(BACKGROUND_CONTEXT)
  const currentTools = tools.map((tool) => tool.name)
  if (activeTools.length !== currentTools.length || activeTools.some((name, index) => name !== currentTools[index])) {
    await lane.setActiveTools(currentTools, BACKGROUND_CONTEXT)
  }
  return Object.assign(harness, { models })
}

export function getMemoryModel(env: ModelEnvironment): Model<'openai-completions'> {
  return directModel(env, env.AI_MEMORY_MODEL || env.AI_MODEL || 'your-model')
}

export function buildPiSystemPrompt(memoryContext: string, customPrompt?: string, instructions?: string | null, relationshipContext?: string): string {
  const prompt = customPrompt?.trim() || DEFAULT_SYSTEM_PROMPT
  return [
    prompt,
    instructions?.trim() ? `Workspace instructions from /workspace/AGENTS.md (relative paths below are under /workspace):\n${instructions.trim()}` : '',
    memoryContext,
    relationshipContext,
  ].filter(Boolean).join('\n\n')
}

function directModel(env: ModelEnvironment, modelId: string): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'configured-provider',
    baseUrl: env.MODEL_BASE_URL,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(env.MODEL_CONTEXT_WINDOW) || 128_000,
    maxTokens: Number(env.MODEL_MAX_TOKENS) || 4096,
  }
}

export type PiHarness = Awaited<ReturnType<typeof createPiHarness>>

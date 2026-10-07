import { createModels, getSupportedThinkingLevels, InMemoryCredentialStore, type ModelThinkingLevel, type Provider } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { googleProvider } from '@earendil-works/pi-ai/providers/google'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock'
import { antLingProvider } from '@earendil-works/pi-ai/providers/ant-ling'
import { basetenProvider } from '@earendil-works/pi-ai/providers/baseten'
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras'
import { fireworksProvider } from '@earendil-works/pi-ai/providers/fireworks'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { googleVertexProvider } from '@earendil-works/pi-ai/providers/google-vertex'
import { groqProvider } from '@earendil-works/pi-ai/providers/groq'
import { huggingfaceProvider } from '@earendil-works/pi-ai/providers/huggingface'
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding'
import { metaProvider } from '@earendil-works/pi-ai/providers/meta'
import { minimaxProvider } from '@earendil-works/pi-ai/providers/minimax'
import { minimaxCnProvider } from '@earendil-works/pi-ai/providers/minimax-cn'
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral'
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai'
import { moonshotaiCnProvider } from '@earendil-works/pi-ai/providers/moonshotai-cn'
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia'
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { qwenTokenPlanProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan'
import { qwenTokenPlanCnProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan-cn'
import { qwenTokenPlanIndividualProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan-individual'
import { radiusProvider } from '@earendil-works/pi-ai/providers/radius'
import { togetherProvider } from '@earendil-works/pi-ai/providers/together'
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { xiaomiProvider } from '@earendil-works/pi-ai/providers/xiaomi'
import { xiaomiTokenPlanAmsProvider } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-ams'
import { xiaomiTokenPlanCnProvider } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-cn'
import { xiaomiTokenPlanSgpProvider } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp'
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai'
import { zaiCodingCnProvider } from '@earendil-works/pi-ai/providers/zai-coding-cn'
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider'
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy'

// Public static registration avoids the Node-only variable import in workerd.
setBedrockProviderModule(bedrockProviderModule)

// Explicitly audited API-key scope. Factories own all model/protocol metadata.
export function nativeProviders(): Provider[] {
  return [deepseekProvider(), openaiProvider(), anthropicProvider(), googleProvider(), openrouterProvider(),
    amazonBedrockProvider(),
    antLingProvider(),
    basetenProvider(),
    cerebrasProvider(),
    fireworksProvider(),
    githubCopilotProvider(),
    googleVertexProvider(),
    groqProvider(),
    huggingfaceProvider(),
    kimiCodingProvider(),
    metaProvider(),
    minimaxProvider(),
    minimaxCnProvider(),
    mistralProvider(),
    moonshotaiProvider(),
    moonshotaiCnProvider(),
    nvidiaProvider(),
    opencodeProvider(),
    opencodeGoProvider(),
    qwenTokenPlanProvider(),
    qwenTokenPlanCnProvider(),
    qwenTokenPlanIndividualProvider(),
    radiusProvider(),
    togetherProvider(),
    vercelAIGatewayProvider(),
    xaiProvider(),
    xiaomiProvider(),
    xiaomiTokenPlanAmsProvider(),
    xiaomiTokenPlanCnProvider(),
    xiaomiTokenPlanSgpProvider(),
    zaiProvider(),
    zaiCodingCnProvider(),
  ]
}

export function modelCatalog() {
  return { providers: nativeProviders().map(provider => ({
    id: provider.id, name: provider.name,
    models: provider.getModels().map(model => ({
      id: model.id, name: model.name, baseUrl: model.baseUrl,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      input: model.input, thinkingLevels: getSupportedThinkingLevels(model),
    })),
  })) }
}

export type ModelSelection = {
  provider: string
  model: string
  apiKey: string
  thinkingLevel: ModelThinkingLevel | null
  maxOutputTokens: number | null
}

export function resolveModelSelection(value: unknown): ModelSelection {
  if (!value || typeof value !== 'object') throw new Error('Model is not configured.')
  const config = value as Record<string, unknown>
  const provider = nativeProviders().find(provider => provider.id === config.provider)
  const model = provider?.getModels().find(model => model.id === config.model)
  if (!model) throw new Error('Unsupported provider or model.')
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) throw new Error('Model API key is missing.')
  const levels = getSupportedThinkingLevels(model)
  if (config.thinkingLevel !== null && !levels.some(level => level === config.thinkingLevel)) throw new Error('Unsupported thinking level.')
  if (config.maxOutputTokens !== null && (typeof config.maxOutputTokens !== 'number' || !Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0 || config.maxOutputTokens > model.maxTokens)) throw new Error('Invalid output token limit.')
  return { provider: model.provider, model: model.id, apiKey: config.apiKey, thinkingLevel: config.thinkingLevel as ModelThinkingLevel | null, maxOutputTokens: config.maxOutputTokens as number | null }
}

export function selectedModel(selection: ModelSelection) {
  return nativeProviders().find(provider => provider.id === selection.provider)!.getModels().find(model => model.id === selection.model)!
}

export async function accountModels(selection: ModelSelection) {
  const credentials = new InMemoryCredentialStore()
  await credentials.modify(selection.provider, async () => ({ type: 'api_key', key: selection.apiKey }))
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } })
  const provider = nativeProviders().find(provider => provider.id === selection.provider)!
  // Durable Harness settings do not forward maxTokens. Use the public Provider seam,
  // retaining the factory's protocol, auth and complete native model metadata.
  models.setProvider({ ...provider, streamSimple: (model, context, options) => provider.streamSimple(model, context, {
    ...options, ...(selection.maxOutputTokens === null ? {} : { maxTokens: selection.maxOutputTokens }),
  }) })
  return models
}

export type ModelEnvironment = { PI_SYSTEM_PROMPT?: string } & ModelSelection
export function selfHostModelEnvironment(env: Env): ModelEnvironment {
  return { PI_SYSTEM_PROMPT: env.PI_SYSTEM_PROMPT, ...resolveModelSelection({
    provider: env.MODEL_PROVIDER, model: env.AI_MODEL, apiKey: env.MODEL_API_KEY,
    thinkingLevel: env.MODEL_THINKING_LEVEL || null,
    maxOutputTokens: env.MODEL_MAX_OUTPUT_TOKENS ? Number(env.MODEL_MAX_OUTPUT_TOKENS) : null,
  }) }
}

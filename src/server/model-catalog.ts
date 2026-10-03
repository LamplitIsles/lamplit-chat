import { createModels, getSupportedThinkingLevels, InMemoryCredentialStore, type ModelThinkingLevel, type Provider } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { googleProvider } from '@earendil-works/pi-ai/providers/google'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'

// Explicitly audited API-key scope. Factories own all model/protocol metadata.
export function nativeProviders(): Provider[] {
  return [deepseekProvider(), openaiProvider(), anthropicProvider(), googleProvider(), openrouterProvider()]
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
  // Harness 0.99.1 does not forward maxTokens. Use the public Provider seam,
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

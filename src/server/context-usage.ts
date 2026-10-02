import { buildSessionContext, calculateContextTokens, estimateContextTokens, estimateTokens, type Entry } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import type { ContextUsage } from '@lamplit/contracts'

const count = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER

// The repository's export-only SDK patch exposes the native projection unchanged.
export async function activeContextUsage(entries: Entry[], contextWindow: number | undefined, invalidatedAfter = 0): Promise<ContextUsage> {
  const capacity = contextWindow !== undefined && count(contextWindow) && contextWindow > 0 ? contextWindow : null
  const messages = await buildSessionContext(entries, undefined, BACKGROUND_CONTEXT)
  let boundary = -1
  for (let index = 0; index < entries.length; index++) if (entries[index]!.type === 'compaction' || entries[index]!.seq <= invalidatedAfter) boundary = index
  const fresh = new Set(entries.slice(boundary + 1).flatMap(entry => entry.type === 'message' ? [entry.message] : []))
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'assistant' || !fresh.has(message)) continue
    if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.stopReason === 'deferred') continue
    const usage = message.usage
    if (![usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.totalTokens].every(value => typeof value === 'number' && count(value))) return { tokens: null, capacity }
    const observed = calculateContextTokens(usage)
    // Pi's estimator treats zero as absent; zero is nevertheless a valid wire observation.
    const tokens = observed === 0
      ? messages.slice(index + 1).reduce((total, trailing) => total + estimateTokens(trailing), 0)
      : estimateContextTokens(messages.slice(index)).tokens
    return { tokens: count(tokens) ? tokens : null, capacity }
  }
  return { tokens: null, capacity }
}

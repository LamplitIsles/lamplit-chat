import type { ContextView } from '@earendil-works/pi-durable'
import type { ContextUsage } from '@lamplit/contracts'
const valid = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
// Count only a provider observation inside the native active context. Cumulative billing is unrelated.
// After compaction, before the first fresh observation, the UI weakens to zero.
export function activeContextUsage(view: ContextView, contextWindow?: number): ContextUsage {
  const capacity = contextWindow && valid(contextWindow) ? contextWindow : null
  const head = view.head?.id ?? 0
  const fresh = new Set(view.entries.filter(entry => entry.id > head).flatMap(entry => (entry.model ?? []).map(message => JSON.stringify(message))))
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index]
    if (!message || message.role !== 'assistant' || !fresh.has(JSON.stringify(message)) || ['error','aborted','deferred'].includes(message.stopReason)) continue
    const usage = message.usage
    if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(valid)) return { tokens: 0, capacity }
    // A conservative text estimate covers messages appended after this observation.
    const trailing = view.messages.slice(index + 1).reduce((total, item) => total + Math.ceil(JSON.stringify(item.content).length / 4), 0)
    const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + trailing
    return { tokens: valid(tokens) ? tokens : 0, capacity }
  }
  return { tokens: 0, capacity }
}

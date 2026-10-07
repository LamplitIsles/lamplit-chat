import type { ArchiveEntry as Entry } from './conversation-archive'
import type { SearchCard, SearchReadResult } from '@lamplit/contracts'

export type SearchNode = {
  id: string; parentId: string | null; index: number; createdAt: string
  record: { kind: SearchCard['kind']; role?: 'user' | 'assistant'; content: string } | null
}
export function nativeSearchNode(entry: Entry): SearchNode {
  let record: SearchNode['record'] = null
  if (entry.type === 'compaction') record = { kind: 'compaction', content: entry.summary }
  if (entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant')) {
    const content = entry.message.content
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : ''
    if (text) record = { kind: 'message', role: entry.message.role, content: text }
  }
  return { id: entry.id, parentId: entry.parentId, index: entry.seq, createdAt: new Date(entry.timestamp).toISOString(), record }
}
export function searchId(sessionId: string, entryId: string): string {
  return JSON.stringify([sessionId, entryId])
}
export function parseSearchId(id: string): [string, string] {
  const parts: unknown = JSON.parse(id)
  if (!Array.isArray(parts) || parts.length !== 2 || parts.some(p => typeof p !== 'string' || !p)) throw new Error('Invalid record identity')
  return parts as [string, string]
}

/** Follow source parents, including unsupported nodes, but expose only supported text. */
export function readSearchNodes(sessionId: string, sessionName: string | undefined, nodes: SearchNode[], entryId: string): SearchReadResult {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const target = byId.get(entryId)
  if (!target?.record) throw new Error('Record not found')
  const children = new Map<string, SearchNode[]>()
  for (const node of nodes) if (node.parentId) children.set(node.parentId, [...children.get(node.parentId) ?? [], node])
  const before: SearchNode[] = [], after: SearchNode[] = []
  let truncated = false
  for (let node = target.parentId ? byId.get(target.parentId) : undefined; node; node = node.parentId ? byId.get(node.parentId) : undefined) {
    if (!node.record) continue
    if (before.length === 8) { truncated = true; break }
    before.push(node)
  }
  for (let node = target;;) {
    const next = children.get(node.id) ?? []
    if (next.length !== 1) break
    node = next[0]
    if (!node.record) continue
    if (after.length === 8) { truncated = true; break }
    after.push(node)
  }
  const selected = [...before.reverse(), target, ...after]
  // Share the excerpt budget across nearby records so a long summary cannot hide
  // the target or the closest before/after text. Full selected text is independent.
  const texts = selected.map(node => Array.from(node.record!.content))
  const allowances = texts.map(chars => chars.length)
  let budget = 12000, remaining = selected.length
  for (const index of texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length)) {
    allowances[index] = Math.min(texts[index].length, Math.floor(budget / remaining--))
    budget -= allowances[index]
  }
  const items = selected.map((node, index) => {
    const clipped = texts[index].length > allowances[index]
    const content = clipped ? texts[index].slice(0, allowances[index]).join('') : node.record!.content
    truncated ||= clipped
    return { sourceRecordIndex: node.index, ...node.record!, content, ...(clipped ? { truncated: true } : {}) }
  })
  return {
    record: { id: searchId(sessionId, entryId), sessionId, ...(sessionName ? { sessionName } : {}), createdAt: target.createdAt, ...target.record },
    context: { targetSourceRecordIndex: target.index, truncated, items },
  }
}

export function searchSnippet(text: string, query: string): string {
  const terms = [...query.matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] ?? m[2])
  const lower = text.toLowerCase()
  const positions = terms.map(t => lower.indexOf(t.toLowerCase())).filter(p => p >= 0)
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 80)
  let snippet = text.slice(start, start + 400)
  const pattern = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  if (pattern) snippet = snippet.replace(new RegExp(pattern, 'giu'), match => `<mark>${match}</mark>`)
  return `${start ? '…' : ''}${snippet}${start + 400 < text.length ? '…' : ''}`
}

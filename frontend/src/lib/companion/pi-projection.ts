import type { StoredSessionEntry, PiStreamEvent } from '../../../../src/shared/pi-contract';
import type { CompanionProjection, TimelineImage, TimelineItem, TimelineMessageUnit, TimelineText } from './projection';
import type { CompanionActivity } from './client/companion-bridge';

export type OptimisticPrompt = { operationId: string; entryId?: string; steering?: boolean; state: 'admitting' | 'accepted' | 'uncertain'; item: TimelineText; images?: TimelineImage[] };

export function canStartSubmission(prompt: OptimisticPrompt | undefined, preparing: boolean): boolean {
  return !prompt && !preparing;
}

export function isCompactCommand(text: string, imageCount: number): boolean {
  return text === '/compact' && imageCount === 0;
}

export function beginOptimisticPrompt(operationId: string, text: string): OptimisticPrompt {
  return {
    operationId,
    state: 'admitting',
    item: { id: operationId, messageKey: operationId, kind: 'text', side: 'outgoing', text, time: Date.now() },
  };
}

export function acceptOptimisticPrompt(prompt: OptimisticPrompt | undefined, event: Extract<PiStreamEvent, { type: 'accepted' }>): OptimisticPrompt | undefined {
  if (!prompt || prompt.operationId !== event.operationId) return prompt;
  return { ...prompt, state: 'accepted', entryId: event.entryId, item: { ...prompt.item, id: event.entryId, messageKey: event.entryId }, images: prompt.images?.map((image) => ({ ...image, messageKey: event.entryId })) };
}

export function projectPromptBranch(entries: readonly StoredSessionEntry[], prompt: OptimisticPrompt | undefined, beforeSeq: number, sessionId = ''): TimelineItem[] {
  return branchItems(prompt && !prompt.entryId && !prompt.steering
    ? entries.filter((entry) => !(entry.seq > beforeSeq && entry.message?.role === 'user'))
    : entries, sessionId);
}

export function hasDurablePrompt(entries: readonly StoredSessionEntry[], prompt: OptimisticPrompt | undefined): boolean {
  return Boolean(prompt?.entryId && entries.some((entry) => entry.id === prompt.entryId && entry.message?.role === 'user'));
}

export function activityForPiEvent(current: CompanionActivity, event: PiStreamEvent): CompanionActivity {
  if (event.type === 'tool_execution_start') {
    const name = event.name.toLowerCase();
    if (name === 'memory' || name === 'update_relationship') return 'remembering';
    if (/^(read|list|find|grep)(_|$)|^memory_(read|lookup)/.test(name)) return 'reading';
    if (name === 'session_search' || /search|browse|web/.test(name)) return 'searching';
    if (/image|media|draw|generate/.test(name)) return 'creating';
    return 'working';
  }
  if (event.type === 'tool_execution_end' || event.type === 'thinking_start' || event.type === 'text_start' || event.type === 'done') return 'thinking';
  return current;
}

export function visibleBranchEntries(entries: readonly StoredSessionEntry[], running: boolean, prompt?: OptimisticPrompt): readonly StoredSessionEntry[] {
  if (!running) return entries;
  if (prompt && !prompt.steering) {
    const currentUser = entries.findIndex((entry) => entry.id === prompt.entryId && entry.message?.role === 'user');
    return currentUser < 0 ? entries : entries.slice(0, currentUser + 1);
  }
  let latestUser = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.message?.role === 'user' || entries[index]?.wakeSource) { latestUser = index; break; }
  }
  return latestUser < 0 ? entries : entries.slice(0, latestUser + 1);
}

function textContent(message: { content?: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.flatMap((part: unknown) => {
    if (!part || typeof part !== 'object' || !('type' in part) || !('text' in part)) return [];
    return part.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
  }).join('');
}

export function branchItems(entries: readonly StoredSessionEntry[], sessionId = ''): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const entry of entries) {
    if (entry.type === 'compaction') {
      items.push({ id: entry.id, messageKey: entry.id, kind: 'continuity', side: 'incoming', tone: 'success', compactionId: entry.id, text: '', anchorSeq: entry.seq, time: Date.parse(entry.timestamp) });
      continue;
    }
    if (entry.wakeSource) {
      items.push({ id: entry.id, messageKey: entry.id, kind: 'wake', side: 'incoming', source: entry.wakeSource, time: Date.parse(entry.timestamp) });
      continue;
    }
    const message = entry.message;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (message.role === 'assistant' && Array.isArray(message.content) && message.content.some((part) => part && typeof part === 'object' && part.type === 'toolCall')) continue;
    const text = textContent(message);
    for (const photo of entry.photos ?? []) {
      items.push({ id: photo.id, messageKey: entry.id, kind: 'image', side: 'outgoing', state: 'ready', alt: photo.name, previewUrl: `/api/conversation-images/${encodeURIComponent(sessionId)}/${photo.id}/preview`, attachment: { attachmentId: photo.id, mediaType: photo.mediaType as 'image/jpeg', name: photo.name }, time: Date.parse(entry.timestamp) });
    }
    if (text) items.push({ id: entry.id, messageKey: entry.id, kind: 'text', side: message.role === 'user' ? 'outgoing' : 'incoming', text, time: Date.parse(entry.timestamp) });
  }
  return items;
}

export function companionProjection(items: readonly TimelineItem[], running: boolean, ready: boolean, error = '', hasUnresolvedSubmission = false): CompanionProjection {
  const messageUnits: TimelineMessageUnit[] = [];
  for (const item of items) {
    const previous = messageUnits.at(-1);
    if (previous?.id === item.messageKey && previous.side === item.side) messageUnits[messageUnits.length - 1] = { ...previous, items: [...previous.items, item] };
    else messageUnits.push({ id: item.messageKey, side: item.side, items: [item], time: item.time });
  }
  return { items, messageUnits, pendingCount: 0, running, canSubmit: ready && !hasUnresolvedSubmission, status: !ready ? 'offline' : running ? 'working' : 'ready', openState: ready ? 'open' : error ? 'error' : 'loading', hasMore: false, loadingOlder: false, lastAgentError: error || undefined };
}

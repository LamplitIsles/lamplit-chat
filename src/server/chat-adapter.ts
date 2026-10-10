import { capabilities, PAGE_SIZE, type ChatMessage, type ChatView, type Submission, type Receipt, type ImageRef, type InputRecovery, type ImageLimits, type ContextUsage, type Compaction, type CompactInput, type CompactResult } from '@lamplit/contracts'
import { occurrenceKey } from '../shared/timed-wake'
import type { PanelBackend } from '@lamplit/contracts'
import type { ChatBackend } from '@lamplit/contracts/server'
import type { SessionBranch } from '../shared/pi-contract'

export type ChatAdmission = Submission & { turnId: string | null; createdAt?: number; rejected?: boolean; entryId?: string }
export interface PiChatSource {
  observation(): Promise<{ sessionId: string; name: string; activeTurnId: string | null; contextUsage: ContextUsage; compaction: Compaction }>
  compact(input: CompactInput): Promise<CompactResult>
  search: import('@lamplit/contracts').SearchBackend
  panels: PanelBackend
  page(before?: string, limit?: number): Promise<SessionBranch & { before: string | null }>
  identity(): Promise<{ id: string; name: string; turnId: string | null }>
  records(entryIds: string[]): Promise<Map<string, ChatAdmission>>
  submit(input: Submission): Promise<Receipt>
  lookup(id: string): Promise<Receipt | null>
  images(entryId: string): Promise<ImageRef[]>
  recovery(): Promise<InputRecovery[]>
  imageLimits(): ImageLimits | false
  pendingMessages(): Promise<ChatMessage[]>
  outcomes(entryIds: string[]): Promise<ChatMessage[]>
  stop(turnId: string): Promise<{ stopped: boolean }>
}
export function createPiChatBackend(source: PiChatSource): ChatBackend {
  async function messages(before?: string) {
    const pending = before ? [] : await source.pendingMessages();
    const branch = await source.page(before, Math.floor((PAGE_SIZE - pending.length) / 2));
    const records = await source.records(branch.entries.map(entry => entry.id));
    const entryOperations = new Map([...records].flatMap(([id, r]) => r.entryId ? [[r.entryId, { id, turnId: r.turnId, messageId: `submission:${id}` }]] as const : []));
    const history = await Promise.all(branch.entries.map(async (entry): Promise<ChatMessage | null> => {
      if (entry.type !== 'message' || !(['user', 'assistant'].includes(entry.message?.role ?? '') || entry.wakeSource)) return null;
      const content = entry.message?.content;
      const text = entry.matrix?.text ?? entry.keet?.text ?? (typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : '');
      const thinking = entry.message?.role === 'assistant' && Array.isArray(content) ? content.flatMap(part => part && typeof part === 'object' && part.type === 'thinking' && typeof part.thinking === 'string' ? [part.thinking] : []).join('\n') : '';
      const stopReason = entry.message && 'stopReason' in entry.message ? entry.message.stopReason : null;
      const operation = entryOperations.get(entry.id);
      const images = await source.images(entry.id);
      const hasToolCall = Array.isArray(content) && content.some(part => part && typeof part === 'object' && part.type === 'toolCall');
      const missingReply = entry.message?.role === 'assistant' && stopReason === 'stop' && !text.trim() && !images.length && !hasToolCall;
      const failed = stopReason === 'aborted' || stopReason === 'error' || missingReply;
      if (entry.message?.role === 'assistant' && !text && !failed && !images.length) return null;
      return { ...(entry.matrix ? { source: { kind: 'matrix' as const, senderId: entry.matrix.senderId, senderDisplayName: entry.matrix.senderDisplayName, roomId: entry.matrix.roomId } } : {}), ...(entry.keet ? { source: { kind: 'keet' as const, channel: entry.keet.kind, senderLabel: entry.keet.sender, destination: entry.keet.destination } } : {}), ...(entry.wakeSource ? { source: { kind: 'reminder' as const, reminderId: entry.wakeSource.wakeId, occurrenceId: occurrenceKey(entry.wakeSource) } } : {}), ...(thinking && !failed ? { thinking } : {}), id: operation?.messageId ?? entry.id, role: failed ? 'notice' : !entry.wakeSource && entry.message!.role === 'user' ? 'user' : 'agent', images, text: failed ? stopReason === 'aborted' ? '已停止回复' : '回复失败' : text, createdAt: entry.authoredAt ?? Date.parse(entry.timestamp), operationId: operation?.id ?? null, turnId: operation?.turnId ?? null } satisfies ChatMessage;
    }));
    const projected = history.filter((m): m is ChatMessage => m !== null);
    const placed = new Set(projected.map(message => message.id));
    const outcomes = await source.outcomes(branch.entries.map(entry => entry.id));
    // A bounded reply notice replaces its failed input's empty response slot.
    const all = [...projected, ...pending.filter(message => !placed.has(message.id)), ...outcomes].sort((a, b) => a.createdAt - b.createdAt);
    if (all.length > PAGE_SIZE) throw new Error('History page exceeds message limit');
    return { messages: all, before: branch.before };
  }
  return {
    ...source.panels,
    ...source.search,
    async read(): Promise<ChatView> {
      for (;;) {
        const identity = await source.identity();
        const [all, recovery] = await Promise.all([messages(), source.recovery()]);
        const observation = await source.observation();
        if (observation.sessionId !== identity.id) continue;
        return { version: 2, ...all, recovery, capabilities: { ...capabilities, images: source.imageLimits() }, ...observation };
      }
    },
    compact: input => source.compact(input),
    async history(before) { return messages(before); },
    submit: input => source.submit(input), lookup: id => source.lookup(id), stop: id => source.stop(id),
    subscribe(changed) { const timer = setInterval(changed, 1000); return () => clearInterval(timer); },
  };
}

export function submissionIdentity(input: Submission): string {
  return JSON.stringify([input.text, input.images?.map(image => [image.attachmentId, image.name, image.mediaType, image.availability]) ?? [], input.replacementSourceIds ?? []]);
}

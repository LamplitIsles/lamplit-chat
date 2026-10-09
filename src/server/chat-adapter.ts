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
  branch(): Promise<SessionBranch>
  identity(): Promise<{ id: string; name: string; turnId: string | null }>
  records(): Promise<Map<string, ChatAdmission>>
  submit(input: Submission): Promise<Receipt>
  lookup(id: string): Promise<Receipt | null>
  images(entryId: string): Promise<ImageRef[]>
  recovery(): Promise<InputRecovery[]>
  imageLimits(): ImageLimits | false
  pendingMessages(): Promise<ChatMessage[]>
  outcomes(): Promise<ChatMessage[]>
  stop(turnId: string): Promise<{ stopped: boolean }>
}
export function createPiChatBackend(source: PiChatSource): ChatBackend {
  async function messages(): Promise<ChatMessage[]> {
    const [branch, records] = await Promise.all([source.branch(), source.records()]);
    const admissions = await Promise.all([...records].map(async ([id, r]) => [id, r, await source.lookup(id)] as const));
    const entryOperations = new Map(admissions.flatMap(([id, r, a]) => a?.messageId ? [[r.entryId ?? a.messageId, { id, turnId: r.turnId, messageId: a.messageId }]] as const : []));
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
    return [...history.filter((m): m is ChatMessage => m !== null), ...await source.pendingMessages(), ...await source.outcomes()].sort((a, b) => a.createdAt - b.createdAt);
  }
  function page(all: ChatMessage[], before?: string) {
    const end = before ? all.findIndex(m => m.id === before) : all.length;
    if (end < 0) throw new Error('History cursor no longer exists');
    const start = Math.max(0, end - PAGE_SIZE);
    return { messages: all.slice(start, end), before: start > 0 ? all[start]!.id : null };
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
        return { version: 2, ...page(all), recovery, capabilities: { ...capabilities, images: source.imageLimits() }, ...observation };
      }
    },
    compact: input => source.compact(input),
    async history(before) { return page(await messages(), before); },
    submit: input => source.submit(input), lookup: id => source.lookup(id), stop: id => source.stop(id),
    subscribe(changed) { const timer = setInterval(changed, 1000); return () => clearInterval(timer); },
  };
}

export function submissionIdentity(input: Submission): string {
  return JSON.stringify([input.text, input.images?.map(image => [image.attachmentId, image.name, image.mediaType, image.availability]) ?? [], input.replacementSourceIds ?? []]);
}

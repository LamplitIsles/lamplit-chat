import type { AgentLane } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import { capabilities, PAGE_SIZE, type ChatMessage, type ChatView, type Submission, type Receipt, type ImageRef, type InputRecovery, type ImageLimits, type ContextUsage, type Compaction, type CompactInput, type CompactResult } from '@lamplit/contracts'
import { occurrenceKey } from '../shared/timed-wake'
import type { PanelBackend } from '@lamplit/contracts'
import type { ChatBackend } from '@lamplit/contracts/server'
import type { SessionBranch, PromptAdmissionStatus, SteerAdmissionStatus } from '../shared/pi-contract'

export type ChatAdmission = Submission & { kind: 'prompt' | 'steer'; turnId: string | null; rejected?: boolean }
export interface PiChatSource {
  observation(): Promise<{ sessionId: string; name: string; activeTurnId: string | null; contextUsage: ContextUsage; compaction: Compaction }>
  compact(input: CompactInput): Promise<CompactResult>
  search: import('@lamplit/contracts').SearchBackend
  panels: PanelBackend
  branch(): Promise<SessionBranch>
  identity(): Promise<{ id: string; name: string; turnId: string | null }>
  records(): Promise<Map<string, ChatAdmission>>
  record(id: string, value: ChatAdmission): Promise<boolean>
  prompt(input: Submission): Promise<void>
  steer(input: Submission): Promise<void>
  promptReceipt(id: string): Promise<PromptAdmissionStatus>
  steerReceipt(id: string): Promise<SteerAdmissionStatus>
  consumed(entryId: string): boolean
  unconsumed(entryId: string): boolean
  images(entryId: string): Promise<ImageRef[]>
  recovery(): Promise<InputRecovery[]>
  imageLimits(): ImageLimits | false
  validate(input: Submission): Promise<void>
  rejected(id: string): Promise<void>
  outcomes(): Promise<ChatMessage[]>
  stop(turnId: string): Promise<{ stopped: boolean }>
}
export function createPiChatBackend(source: PiChatSource): ChatBackend {
  let admission = Promise.resolve();
  async function messages(): Promise<ChatMessage[]> {
    const [branch, records] = await Promise.all([source.branch(), source.records()]);
    const admissions = await Promise.all([...records].map(async ([id, r]) => [id, r, r.kind === 'prompt' ? await source.promptReceipt(id) : await source.steerReceipt(id)] as const));
    const entryOperations = new Map(admissions.flatMap(([id, r, a]) => 'entryId' in a ? [[a.entryId, { id, turnId: r.turnId }]] as const : []));
    const history = await Promise.all(branch.entries.map(async (entry): Promise<ChatMessage | null> => {
      if (entry.type !== 'message' || !(['user', 'assistant'].includes(entry.message?.role ?? '') || entry.wakeSource)) return null;
      const content = entry.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : '';
      const stopReason = entry.message && 'stopReason' in entry.message ? entry.message.stopReason : null;
      const failed = stopReason === 'aborted' || stopReason === 'error';
      const operation = entryOperations.get(entry.id);
      const images = await source.images(entry.id);
      if (entry.message?.role === 'assistant' && !text && !failed && !images.length) return null;
      return { ...(entry.wakeSource ? { source: { kind: 'reminder' as const, reminderId: entry.wakeSource.wakeId, occurrenceId: occurrenceKey(entry.wakeSource) } } : {}), id: entry.id, role: failed ? 'notice' : !entry.wakeSource && entry.message!.role === 'user' ? 'user' : 'agent', images, text: failed ? stopReason === 'aborted' ? '已停止回复' : '回复失败' : text, createdAt: Date.parse(entry.timestamp), operationId: operation?.id ?? null, turnId: operation?.turnId ?? null } satisfies ChatMessage;
    }));
    return [...history.filter((m): m is ChatMessage => m !== null), ...await source.outcomes()].sort((a, b) => a.createdAt - b.createdAt);
  }
  function page(all: ChatMessage[], before?: string) {
    const end = before ? all.findIndex(m => m.id === before) : all.length;
    if (end < 0) throw new Error('History cursor no longer exists');
    const start = Math.max(0, end - PAGE_SIZE);
    return { messages: all.slice(start, end), before: start > 0 ? all[start]!.id : null };
  }
  async function lookup(id: string): Promise<Receipt> {
    const record = (await source.records()).get(id);
    if (!record) return { operationId: id, state: 'missing', messageId: null, turnId: null, error: null };
    if (record.rejected) return { operationId: id, state: 'rejected', messageId: null, turnId: record.turnId, error: 'Input was not admitted' };
    const native = record.kind === 'prompt' ? await source.promptReceipt(id) : await source.steerReceipt(id);
    const messageId = 'entryId' in native ? native.entryId : null;
    const committed = messageId && source.consumed(messageId);
    return { operationId: id, state: committed ? 'consumed' : messageId && source.unconsumed(messageId) ? 'unconsumed' : native.state === 'accepted' ? 'accepted' : 'uncertain', messageId, turnId: record.turnId, error: null };
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
        return { version: 1, ...page(all), recovery, capabilities: { ...capabilities, images: source.imageLimits() }, ...observation };
      }
    },
    compact: input => source.compact(input),
    async history(before) { return page(await messages(), before); },
    submit(input) {
      const task = admission.then(async () => {
        if (input.text === '/compact') throw new Error('Use the compact operation');
        const records = await source.records();
        const previous = records.get(input.operationId);
        if (previous) { if (submissionIdentity(previous) !== submissionIdentity(input)) throw new Error('Submission identity conflict'); return lookup(input.operationId); }
        await source.validate(input);
        const identity = await source.identity();
        const kind = identity.turnId ? 'steer' : 'prompt';
        if (!await source.record(input.operationId, { ...input, kind, turnId: identity.turnId ?? input.operationId })) return lookup(input.operationId);
        try { if (kind === 'steer') await source.steer(input); else await source.prompt(input); }
        catch { await source.rejected(input.operationId); }
        return lookup(input.operationId);
      });
      admission = task.then(() => {}, () => {}); return task;
    },
    lookup, stop: id => source.stop(id),
    subscribe(changed) { const timer = setInterval(changed, 1000); return () => clearInterval(timer); },
  };
}

export async function stopPiChatTurn(lane: AgentLane, turnId: string): Promise<{ stopped: boolean }> {
  const requested = await lane.requestAbort(turnId, BACKGROUND_CONTEXT)
  if (!requested.ok) {
    if (requested.error._tag === 'OperationMismatch') return { stopped: false }
    throw requested.error
  }
  const result = await lane.drive({ operationId: turnId }, BACKGROUND_CONTEXT)
  if (!result.ok) throw result.error
  return { stopped: true }
}

export function submissionIdentity(input: Submission): string {
  return JSON.stringify([input.text, input.images?.map(image => [image.attachmentId, image.name, image.mediaType, image.availability]) ?? [], input.replacementSourceIds ?? []]);
}

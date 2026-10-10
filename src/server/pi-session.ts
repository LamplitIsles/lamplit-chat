import { NativeHistory } from './native-history'
import { type ChannelEvent } from './channel-events'
import { ChannelError, type Channel } from './channel-config'
import { accountModels, nativeProviders, selectedModel, resolveModelSelection, selfHostModelEnvironment } from './model-catalog'
import { nativeSearchNode, readSearchNodes } from './conversation-search'
import { createPiPanelBackend, PanelCursors } from './companion-panels'
import { PI_IMAGE_LIMITS, imageRef, checkUpload, nativePhotoId } from './chat-images'
import { validateSubmission, validateRecovery, type Submission, type InputRecovery, type ImageUpload, type ImageRef } from '@lamplit/contracts'
import { PANEL_LIMITS, type AlbumPage } from '@lamplit/contracts'
import { createChatHost } from '@lamplit/contracts/server'
import { createPiChatBackend, submissionIdentity } from './chat-adapter'
import { createWakeTools } from './timed-wake-tools'
import { makeWake } from './timed-wake'
import { WAKE_CUSTOM_TYPE, occurrenceKey, type WakeSource, type TimedWake, type WakeInput } from '../shared/timed-wake'
import { createPlatformFeedbackTools } from './platform-feedback-tool'
import { createWebTools, searchSettings } from './web-tools'
import { CompanionFiles, MaterialFailure, materialReply } from './companion-materials'
import type { MaterialRequest, MaterialReply } from '../shared/companion-materials'
import type { PiRegistry } from './pi-registry'
import {
  type DurableObjectStorageLike,
  Workspace,
} from '@cloudflare/computer'
import { ensureNativeRoot } from './native-data-migration'
import { PiHarness } from 'agents/harness/pi'
import { Harness, CompactionTask, ROOT_CONVERSATION_ID, type CompactionResult, type SubmissionRecord, type EntryId, type Cursor } from '@earendil-works/pi-durable'
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import type { ArchiveEntry as Entry } from './conversation-archive'
import { hostedCallable, HostedAgent } from './hosted-agent'
import { getCurrentAgent } from 'agents'
import { activeContextUsage } from './context-usage'
import type { Compaction, CompactInput, CompactResult } from '@lamplit/contracts'
import type {
  ApplyMemoryExtractionInput,
  CompactionSettings,
  ConversationPhoto,
  ConversationPhotoPage,
  DiaryEntry,
  Memory,
  MemoryKind,
  RelationshipSnapshot,
  RelationshipState,
  RelationshipUpdate,
  PhotoUpload,
  SessionBranch,
  SessionIndexEvent,
  SessionOverview,
  SessionSummary,
  StoredSessionEntry,
  WorkspaceFile,
  WorkspaceFileContent,
} from '../shared/pi-contract'
import { createPiHarness, type ModelEnvironment } from './create-pi-harness'
import { createInjectedMcpTools, type InjectedMcpDiscovery } from './injected-remote-mcp'
import { extractMemoryOperations, type MemorySourceEntry } from './memory-extractor'
import { createMemoryTool } from './memory-tools'
import { createRelationshipTools } from './relationship-tools'
import { PiSessionStorage } from './pi-session-storage'
import { PI_REGISTRY_INSTANCE } from '../shared/pi-contract'
import { createSessionSearchTool, createWorkspaceTools } from './workspace-tools'
import type { ComputerWorkspace } from './computer-workspace'
import { WORKSPACE_ROOT, workspacePath } from './workspace-root'

export type ChatImageOwner = { sessionId: string; instanceId: string | null; tokenHash: string | null }

type InitializeMetadata = Pick<SessionSummary, 'id' | 'createdAt' | 'updatedAt' | 'lineage'> & { name?: string }
const WORKSPACE_PAGE_SIZE = 250
const DIARY_ENTRY_MAX_BYTES = 128 * 1024
const DIARY_NAME = /^\d{4}-\d{2}-\d{2}\.md$/
const MEMORY_EXTRACTION_CURSOR = 'memoryExtractionRevision'
const MEMORY_EXTRACTION_BATCH_CHARS = 30_000
const MEMORY_SOURCE_ENTRY_CHARS = 12_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PHOTO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const PHOTO_ROW_BUDGET = 1_500_000

type MemoryRegistry = {
  getUserTimeZone(): Promise<string>
  getReportedTimeZone(): Promise<string | undefined>
  search(input: import('@lamplit/contracts').SearchInput): Promise<import('@lamplit/contracts').SearchResult>
  searchRead(input: import('@lamplit/contracts').SearchReadInput): Promise<import('@lamplit/contracts').SearchReadResult>
  searchSessions(input: { query: string; limit?: number }): Promise<import('../shared/pi-contract').SessionSearchResult[]>
  getMemoryContext(): Promise<string>
  getRelationshipContext(): Promise<string>
  getRelationshipSnapshot(input?: { limit?: number; before?: number }): Promise<RelationshipSnapshot>
  updateRelationship(input: RelationshipUpdate): Promise<RelationshipState>
  listMemories(): Promise<Memory[]>
  setMemory(input: { id?: string; kind: MemoryKind; content: string; sourceSessionId?: string }): Promise<Memory>
  deleteMemory(id: string): Promise<void>
  applyMemoryExtraction(input: ApplyMemoryExtractionInput): Promise<void>
  applyIndexEvents(sessionId: string, events: SessionIndexEvent[]): Promise<void>
}

export class PiSession extends HostedAgent {
  private chatHost?: Promise<Awaited<ReturnType<typeof createChatHost>>>
  private chatConnections = new Map<string, { receive(raw: string): Promise<void>; close(): void }>()
  shouldSendProtocolMessages(connection: Parameters<HostedAgent['onConnect']>[0], context: Parameters<HostedAgent['onConnect']>[1]): boolean {
    return new URL(context.request.url).pathname !== '/api/chat/socket' && super.shouldSendProtocolMessages(connection, context)
  }
  async onConnect(connection: Parameters<HostedAgent['onConnect']>[0], context: Parameters<HostedAgent['onConnect']>[1]): Promise<void> {
    await super.onConnect(connection, context)
    if (new URL(context.request.url).pathname !== '/api/chat/socket') return
    connection.setState({ ...(connection.state as { tokenHash?: string } | null), chat: true })
    const host = await this.getChatHost()
    const channel = host.connect(connection, async () => {
      try { await this.verifyConnection(connection); return true } catch { return false }
    })
    this.chatConnections.set(connection.id, channel)
  }
  async onMessage(connection: Parameters<HostedAgent['onMessage']>[0], message: Parameters<HostedAgent['onMessage']>[1]): Promise<void> {
    if ((connection.state as { chat?: boolean } | null)?.chat) {
      const channel = this.chatConnections.get(connection.id)
      if (!channel || typeof message !== 'string') { connection.close(1012, 'Reconnect'); return }
      await channel.receive(message)
    } else await super.onMessage(connection, message)
  }
  async onClose(connection: Parameters<HostedAgent['onClose']>[0], code: number, reason: string, wasClean: boolean): Promise<void> {
    this.chatConnections.get(connection.id)?.close(); this.chatConnections.delete(connection.id)
    if (!this.chatConnections.size && this.chatHost) { const pending = this.chatHost; const host = await pending; if (!this.chatConnections.size && this.chatHost === pending) { host.close(); this.chatHost = undefined } }
    await super.onClose(connection, code, reason, wasClean)
  }
  private getChatHost() {
    return this.chatHost ??= createChatHost(createPiChatBackend({
      search: { search: input => this.registry().search(input), searchRead: input => this.registry().searchRead(input) },
      panels: createPiPanelBackend({
        sessionId: () => this.sessionStorage.getMetadataSync().id,
        scope: `pi-registry:${this.instanceId() ?? PI_REGISTRY_INSTANCE}`,
        cursorSecret: () => this.panelCursorSecret(),
        relationship: input => this.registry().getRelationshipSnapshot(input),
        diaryList: () => this.listDiary(), diaryRead: name => this.readDiary(name),
        album: input => this.readPanelAlbum(input.cursor), reminders: () => this.listTimedWakes(),
      }),
      observation: () => this.chatObservation(),
      compact: input => this.compactChat(input),
      page: (before, limit) => this.historyPage(before, limit),
      identity: async () => ({ id: this.sessionStorage.getMetadataSync().id, name: this.sessionStorage.getSetting<string>('name') ?? 'Lamplit', turnId: await this.activeTurn() }),
      records: async ids => this.sessionStorage.chatForEntries(ids),
      images: id => this.sharedImages(this.sessionStorage.photosForEntry(id)),
      recovery: () => this.chatRecovery(),
      imageLimits: () => this.env.COMPUTER_R2 && this.modelSupportsImages ? PI_IMAGE_LIMITS : false,
      submit: input => this.submitChat(input), lookup: id => this.lookupChat(id),
      pendingMessages: () => this.pendingChatMessages(),
      outcomes: ids => this.replyOutcomes(ids),
      stop: async turnId => ({ stopped: await this.native.abort({ operationId: turnId }) }),
    }))
  }
  revokePersonalSession(tokenHash: string): void {
    this.closeSessionConnections(tokenHash)
  }
  async materialsRequest(request: MaterialRequest): Promise<MaterialReply> {
    return materialReply(async () => {
      if (await this.compactBusy()) throw new MaterialFailure('busy', 409)
      return this.withExclusiveOperation(async () => {
        if (request.action.startsWith('memory-')) {
          const registry = this.env.PiRegistry.getByName(this.instanceId() ?? PI_REGISTRY_INSTANCE) as DurableObjectStub<PiRegistry>
          return registry.materialsMemoryRequest(request)
        }
        return new CompanionFiles(this.workspace).request(request)
      })
    })
  }
  private wakeMutation: Promise<unknown> = Promise.resolve()
  private serializeWake<T>(work: () => Promise<T>): Promise<T> {
    const next = this.wakeMutation.then(work)
    this.wakeMutation = next.catch(() => {})
    return next
  }
  private active = false
  private nativeStorage?: SqliteStorage
  private nativeContext?: Parameters<Harness['close']>[0]
  private runtimeTools: import('@earendil-works/pi-durable').ToolRegistration[] = []
  private runtimeConfig?: string
  private mcpDiscovery?: InjectedMcpDiscovery
  private pendingMcpRetry?: InjectedMcpDiscovery['retry']
  private modelSupportsImages = false
  private memoryExtraction?: Promise<void>
  private readonly sessionStorage = new PiSessionStorage(this.ctx.storage)
  private submissionMutation: Promise<unknown> = Promise.resolve()
  private readonly native = new PiHarness({ harness: async ({ storage, context }) => {
    this.nativeStorage = storage; this.nativeContext = context
    const registry = this.registry()
    const modelEnv = await this.modelEnvironment().catch(() => undefined)
    this.runtimeConfig = JSON.stringify(modelEnv)
    const tools = [
      ...createWorkspaceTools(this.workspace), createSessionSearchTool(registry),
      createMemoryTool(registry, this.sessionStorage.isInitialized() ? this.sessionStorage.getMetadataSync().id : this.name.split(':').at(-1)!), ...createRelationshipTools(registry),
      ...createWakeTools(this, () => registry.getReportedTimeZone()), ...createWebTools(this.env, this.instanceId()),
      ...createPlatformFeedbackTools(this.env, this.instanceId(), this.sessionStorage.isInitialized() ? this.sessionStorage.getMetadataSync().id : this.name.split(':').at(-1)!),
    ]
    const retry = this.pendingMcpRetry
    this.pendingMcpRetry = undefined
    this.mcpDiscovery = retry ? await retry() : await createInjectedMcpTools(this.env.MCP_CONFIG, this.instanceId())
    this.runtimeTools = [...tools, ...this.mcpDiscovery.tools]
    const harness = await createPiHarness({
      storage, context, env: modelEnv, tools: this.runtimeTools, memory: registry, compaction: this.compactionSettings(),
      loadCompactionPrompt: async () => (await new CompanionFiles(this.workspace).effective()).content,
      loadInstructions: () => this.workspace.readFile(`${WORKSPACE_ROOT}/AGENTS.md`), getUserTimeZone: () => registry.getUserTimeZone(),
      awaitWakeSchedules: () => this.awaitWakeSchedules(),
    })
    await ensureNativeRoot(harness, this.sessionStorage, context)
    const root = await harness.root(context)
    if (modelEnv && !(await harness.inspect(context)).tasks.length) await root.configure({ model: { provider: modelEnv.provider, modelId: modelEnv.model }, thinkingLevel: modelEnv.thinkingLevel ?? 'off' }, context)
    return harness
  } })
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.lifecycle.use(this.native) }
  private readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    sessionId: this.ctx.id.toString(),
    useThink: true,
  }) as ComputerWorkspace

  async onStart(): Promise<void> {
    for (const connection of this.getConnections()) if ((connection.state as { chat?: boolean } | null)?.chat) connection.close(1012, 'Reconnect')
    if (!this.sessionStorage.isInitialized()) return
    this.ctx.waitUntil(this.serializeWake(() => this.ensureWakeSchedules()))
    this.ctx.waitUntil((async () => {
      for (const pending of await this.native.pending()) this.watchSettlement(pending.operationId)
      await this.syncNativeEntries()
      await this.resumeWakes()
      await this.schedulePendingDrain()
    })())
  }

  async initialize(metadata: InitializeMetadata): Promise<SessionOverview> {
    await this.workspace.mkdir(WORKSPACE_ROOT, { recursive: true })
    const created = this.sessionStorage.initialize({
      id: metadata.id,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      lineage: metadata.lineage,
    })
    if (created && metadata.name) this.sessionStorage.setSetting('name', metadata.name)
    return this.getOverview()
  }

  @hostedCallable()
  async getOverview(): Promise<SessionOverview> {
    await this.waitUntilInitialized()
    const metadata = this.sessionStorage.getMetadataSync()
    await this.observeNative()
    const stats = this.sessionStorage.historyStats()
    return { ...metadata, name: this.sessionStorage.getSetting<string>('name'), status: 'ready', messageCount: stats.messageCount,
      activeLeafId: stats.leafId, revision: stats.revision, running: !!await this.activeTurn(), compaction: this.compactionSettings() }
  }

  private async history() { return new NativeHistory(this.sessionStorage, await this.getLane(), this.nativeContext!) }
  async getBranch(): Promise<SessionBranch> { return this.historyPage() }
  private async historyPage(before?: string, limit?: number): Promise<SessionBranch & { before: string | null }> {
    const page = await (await this.history()).page(before, limit)
    await this.reconcileExternalInputs()
    for (const [id] of this.sessionStorage.unsettledChats('reconcile')) await this.lookupChat(id)
    return { ...page, entries: page.entries.map(entry => this.presentEntry(entry)) }
  }
  private presentEntry(entry: Entry): StoredSessionEntry {
    if (this.sessionStorage.externalEntry(entry.id) && !this.sessionStorage.keetSource(entry.id)) throw new Error('External source association is unavailable')
    const source = this.sessionStorage.keetSource(entry.id)
    const matrix: { sender_id: string; sender_display_name: string; room_id: string; body: string } | undefined = source?.kind === 'matrix' ? JSON.parse(source.original) : undefined
    const wake = this.sessionStorage.getSetting<WakeSource>(`wakeEntry:${entry.id}`)
    const publicEntry = source && entry.type === 'message' && entry.message.role === 'user' ? { ...entry, message: { ...entry.message, content: matrix?.body ?? source.text } } : entry
    return { ...storedEntry(entry.seq, publicEntry), ...(wake ? { wakeSource: wake } : {}), ...(matrix ? { matrix: { senderId: matrix.sender_id, senderDisplayName: matrix.sender_display_name, roomId: matrix.room_id, text: matrix.body } } : {}), ...(source ? { authoredAt: source.timestamp } : {}), photos: this.sessionStorage.photosForEntry(entry.id), ...(source && source.kind !== 'matrix' ? { keet: { kind: source.kind, sender: source.sender, destination: source.destination, text: source.text } } : {}) }
  }
  @hostedCallable()
  async setSessionName(name: string): Promise<SessionOverview> {
    this.sessionStorage.setSetting('name', name); await this.flushOutboxToRegistry(); return this.getOverview()
  }

  private async activeTurn(): Promise<string | null> { return (await this.native.pending()).find(item => item.status === 'running')?.operationId ?? null }
  private async chatObservation() {
    const lane = await this.getLane()
    const reference = (await lane.agent(this.nativeContext!)).model
    const model = nativeProviders().find(provider => provider.id === reference?.provider)?.getModels().find(model => model.id === reference?.modelId)
    this.modelSupportsImages = model?.input.includes('image') ?? false
    const view = await lane.context(this.nativeContext!)
    const latest = this.sessionStorage.latestCompaction()
    // Terminal native compaction tasks remain authoritative even when a fast
    // operation starts and finishes between socket observations.
    const progress = this.sessionStorage.getSetting<{ cursor?: Cursor; task?: Awaited<ReturnType<SqliteStorage['scanTasks']>>['items'][number] }>('compactionObservation') ?? {}
    const page = await this.nativeStorage!.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: CompactionTask.definition.name }, 30, progress.cursor, this.nativeContext!)
    const task = page.items.at(-1) ?? progress.task
    if (page.items.length) this.sessionStorage.setSetting('compactionObservation', { cursor: page.next ?? progress.cursor, task })
    const outcome = task?.state.status === 'terminal' ? task.state.outcome : undefined
    const result = outcome?.status === 'completed' ? outcome.result as unknown as CompactionResult : undefined
    const compaction: Compaction = task ? {id:String(task.id),status:task.state.status !== 'terminal' ? 'running' : result && (result.entryId || result.submissionId) ? 'complete' : 'failed'} : latest ? {id:latest.id,status:'complete'} : null
    return { sessionId: this.sessionStorage.getMetadataSync().id, name: this.sessionStorage.getSetting<string>('name') ?? 'Lamplit', activeTurnId: await this.activeTurn(),
      contextUsage: activeContextUsage(view, model?.contextWindow), compaction }
  }
  private async nativeBusy(harness: Harness): Promise<boolean> {
    return (await this.native.pending()).length > 0 || (await harness.inspect(this.nativeContext!)).tasks.some(task => !task.record.background)
  }
  private async compactBusy(): Promise<boolean> { return this.active || await this.nativeBusy(await this.getHarness()) }
  private async compactChat(input: CompactInput): Promise<CompactResult> {
    const connection = getCurrentAgent().connection
    if (this.env.HOSTED_MODE === 'true' && !connection) return { ...input, accepted: false }
    if (connection) await this.verifyConnection(connection)
    if (connection && !this.chatConnections.has(connection.id)) return { ...input, accepted: false }
    if (input.sessionId !== this.sessionStorage.getMetadataSync().id || await this.compactBusy()) return { ...input, accepted: false }
    const lane = await this.getLane()
    if (connection) await this.verifyConnection(connection)
    if (connection && !this.chatConnections.has(connection.id)) return { ...input, accepted: false }
    if (input.sessionId !== this.sessionStorage.getMetadataSync().id || await this.compactBusy()) return { ...input, accepted: false }
    this.active = true
    try {
      await this.schedule(1, 'maintainNativeWork', undefined, { idempotent: true })
      const task = await lane.compact(undefined, this.nativeContext!)
      this.ctx.waitUntil((async () => {
        await (await this.getHarness()).waitForTask(task, this.nativeContext!)
        await this.syncNativeEntries(); await this.flushOutboxToRegistry()
      })().finally(() => { this.active = false }))
      return { ...input, accepted: true }
    } catch { this.active = false; return { ...input, accepted: false } }
  }
  async maintainNativeWork(): Promise<void> {
    await (await this.getHarness()).waitForIdle(this.nativeContext!)
    await this.syncNativeEntries(); await this.flushOutboxToRegistry()
    if (this.active) await this.schedule(1, 'maintainNativeWork', undefined, { idempotent: true })
  }
  @hostedCallable()
  async updateCompactionSettings(settings: CompactionSettings): Promise<CompactionSettings> {
    if (!Number.isSafeInteger(settings.reserveTokens) || settings.reserveTokens < 0 || !Number.isSafeInteger(settings.keepRecentTokens) || settings.keepRecentTokens < 0) throw new Error('Compaction token settings must be non-negative integers.')
    const task = this.laneMutation.then(async () => {
      if (await this.compactBusy()) throw new Error('Pi is currently running.')
      this.sessionStorage.setSetting('compaction', settings)
      await this.native.dispose()
      return settings
    })
    this.laneMutation = task.catch(() => undefined)
    return task
  }

  @hostedCallable()
  async listTimedWakes(): Promise<TimedWake[]> {
    await this.waitUntilInitialized()
    return this.sessionStorage.timedWakes().sort((a, b) => a.nextAt.localeCompare(b.nextAt))
  }

  // Machine tools only: deliberately not browser-callable.
  async saveTimedWake(input: WakeInput, id?: string): Promise<TimedWake> {
    return this.serializeWake(() => this.saveWake(input, id))
  }
  private async saveWake(input: WakeInput, id?: string): Promise<TimedWake> {
    await this.waitUntilInitialized()
    const wakes = this.sessionStorage.timedWakes()
    const previous = id ? wakes.find(wake => wake.id === id) : undefined
    if (id && !previous) throw new Error('Active wake not found.')
    if (!id && wakes.length >= 32) throw new Error('At most 32 active wakes per session.')
    const wake = makeWake(input, Date.now(), id)
    this.sessionStorage.setSetting('timedWakes', [...wakes.filter(item => item.id !== id), wake])
    await this.ensureWakeSchedules()
    return wake
  }

  async cancelTimedWake(id: string): Promise<boolean> {
    return this.serializeWake(() => this.cancelWake(id))
  }
  private async cancelWake(id: string): Promise<boolean> {
    const wakes = this.sessionStorage.timedWakes()
    const found = wakes.some(wake => wake.id === id)
    this.sessionStorage.setSetting('timedWakes', wakes.filter(wake => wake.id !== id))
    await this.ensureWakeSchedules()
    return found
  }

  private async ensureWakeSchedules(): Promise<void> {
    const wakes = this.sessionStorage.timedWakes()
    for (const schedule of await this.listSchedules()) {
      if (schedule.callback !== 'acceptTimedWake') continue
      const source = schedule.payload as WakeSource
      if (!wakes.some(wake => wake.id === source.wakeId && wake.revision === source.revision && wake.nextAt === source.scheduledAt)) await this.cancelSchedule(schedule.id)
    }
    for (const wake of wakes) {
      const source: WakeSource = { wakeId: wake.id, revision: wake.revision, scheduledAt: wake.nextAt, title: wake.title, reminder: wake.reminder }
      await this.schedule(new Date(Math.ceil(Date.parse(wake.nextAt) / 1000) * 1000), 'acceptTimedWake', source, { idempotent: true })
    }
  }

  async acceptTimedWake(source: WakeSource): Promise<void> {
    return this.serializeWake(() => this.acceptWake(source))
  }
  private async acceptWake(source: WakeSource): Promise<void> {
    if (this.sessionStorage.wakeReceipt(source)) { await this.ensureWakeSchedules(); return }
    const wake = this.sessionStorage.timedWakes().find(item => item.id === source.wakeId && item.revision === source.revision && item.nextAt === source.scheduledAt)
    if (!wake || Date.now() < Date.parse(wake.nextAt)) return
    const operationId = `wake:${occurrenceKey(source)}`
    if (Date.now() - Date.parse(wake.nextAt) <= 60_000) {
      this.sessionStorage.setSetting('pendingWakes', [...this.sessionStorage.getSetting<WakeSource[]>('pendingWakes') ?? [], source])
      this.sessionStorage.setSetting(`wakeSource:${operationId}`, source)
    }
    this.sessionStorage.advanceWake(wake, Date.now())
    await this.ensureWakeSchedules()
    await this.resumeWakes()
  }

  private async resumeWakes(): Promise<void> {
    for (const source of this.sessionStorage.getSetting<WakeSource[]>('pendingWakes') ?? []) {
      const operationId = `wake:${occurrenceKey(source)}`
      await this.ensureWakeSchedules()
      await this.getLane()
      await this.native.submit(`[Your self-set reminder, scheduled ${source.scheduledAt}] ${source.title}\n${source.reminder}`, { operationId })
      this.sessionStorage.recordWake(source, operationId)
      this.sessionStorage.setSetting('pendingWakes', (this.sessionStorage.getSetting<WakeSource[]>('pendingWakes') ?? []).filter(item => occurrenceKey(item) !== occurrenceKey(source)))
      this.watchSettlement(operationId)
    }
  }

  private async awaitWakeSchedules(): Promise<void> {
    await this.serializeWake(() => this.ensureWakeSchedules())
  }

  async ingestInbound(channel: Channel, event: ChannelEvent, original: string): Promise<{ sequence: number; queued: boolean } | { error: string; status: number }> {
    try {
      await this.waitUntilInitialized()
      const result = this.sessionStorage.admitInbound(channel, event, original)
      await this.schedulePendingDrain()
      return result
    } catch (error) { return { error: 'Inbound admission failed', status: error instanceof ChannelError ? error.status : 503 } }
  }

  async drainPendingWork(): Promise<void> {
    if (!this.sessionStorage.isInitialized()) return
    const next = this.sessionStorage.nextKeet()
    if (!next) return
    await this.getLane()
    this.sessionStorage.setSetting(`keetInput:${next.operationId}`, next)
    const existing = await this.nativeSubmission(next.operationId)
    if (existing) { if (existing.status === 'unanswered' && !existing.entry) { this.sessionStorage.withdrawExternalInput(next.operationId); return } if (existing.entry) this.sessionStorage.bindExternalInput(next.operationId, this.sessionStorage.sourceId(existing.entry)); this.watchSettlement(next.operationId); return }
    if (!this.sessionStorage.reserveExternalInput(next.operationId)) return
    await this.native.submit(next.prompt, { operationId: next.operationId, whenBusy: 'followUp' })
    await this.reconcileExternalInputs()
    this.watchSettlement(next.operationId)
  }
  private async schedulePendingDrain(): Promise<void> { if (this.sessionStorage.nextKeet()) await this.schedule(1, 'drainPendingWork', undefined, { idempotent: true }) }

  @hostedCallable()
  async listFiles(): Promise<WorkspaceFile[]> {
    const files = await this.listAllWorkspaceFiles()
    return files.map(({ path, size, updatedAt }) => ({ path, size, mtime: new Date(updatedAt).toISOString() }))
  }

  @hostedCallable()
  async readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
    path = workspacePath(path)
    const [content, stat] = await Promise.all([this.workspace.readFile(path), this.workspace.stat(path)])
    if (content === null || !stat || stat.type !== 'file') throw new Error(`File not found: ${path}`)
    return { path, content, size: stat.size, mtime: new Date(stat.updatedAt).toISOString() }
  }

  @hostedCallable()
  async listDiary(): Promise<string[]> {
    await this.waitUntilInitialized()
    const directory = `${WORKSPACE_ROOT}/memory`
    if (!(await this.workspace.stub().fs.lstatOrNull(directory))?.isDirectory) return []
    const names: string[] = []
    for (let offset = 0; ; offset += WORKSPACE_PAGE_SIZE) {
      const entries = await this.workspace.readDir(directory, { limit: WORKSPACE_PAGE_SIZE, offset })
      const candidates = entries.filter(entry => entry.type === 'file' && DIARY_NAME.test(entry.path.slice(directory.length + 1)))
      const regular = await Promise.all(candidates.map(async entry => (await this.workspace.stub().fs.lstatOrNull(entry.path))?.isFile ? entry.path.slice(directory.length + 1) : null))
      names.push(...regular.filter((name): name is string => name !== null))
      if (entries.length < WORKSPACE_PAGE_SIZE) break
    }
    return names.sort().reverse()
  }

  @hostedCallable()
  async readDiary(name: string): Promise<DiaryEntry | null> {
    await this.waitUntilInitialized()
    if (!DIARY_NAME.test(name)) return null
    const path = `${WORKSPACE_ROOT}/memory/${name}`
    if (!(await this.workspace.stub().fs.lstatOrNull(`${WORKSPACE_ROOT}/memory`))?.isDirectory) return null
    const stat = await this.workspace.stub().fs.lstatOrNull(path)
    if (!stat?.isFile) return null
    if (stat.size > DIARY_ENTRY_MAX_BYTES) return { tooLarge: true }
    const text = await this.workspace.readFile(path)
    return text === null ? null : new TextEncoder().encode(text).byteLength > DIARY_ENTRY_MAX_BYTES ? { tooLarge: true } : { name, text }
  }

  private async nativeSubmission(id: string): Promise<SubmissionRecord | undefined> {
    await this.getHarness()
    return this.nativeStorage!.submissionByRequest(ROOT_CONVERSATION_ID, id, this.nativeContext!)
  }
  async lookupChat(id: string): Promise<import('@lamplit/contracts').Receipt | null> {
    const native = await this.nativeSubmission(id)
    const record = this.sessionStorage.chatRecord(id)
    if (native) {
      const messageId = native.entry ? this.sessionStorage.sourceId(native.entry) : null
      if (messageId) {
        this.sessionStorage.correlateInput(id, messageId)
        this.sessionStorage.updateChat(id, { entryId: messageId })
        if (record && native.entry) {
          const fingerprint = (record as typeof record & { fingerprint?: string }).fingerprint ?? await promptFingerprint(submissionIdentity(record))
          this.sessionStorage.updateChat(id, { text: '', fingerprint }); this.sessionStorage.retireInput(id)
        }
      }
      if (record?.replacementSourceIds?.length) for (const source of record.replacementSourceIds) this.sessionStorage.markReplaced(source)
      if (native.status === 'unanswered' && !native.entry && native.reason === 'aborted') this.sessionStorage.withdrawInput(id)
      return { operationId: id, state: 'submitted', messageId: messageId && record ? `submission:${id}` : messageId, turnId: record?.turnId ?? id, error: null }
    }
    const historic = this.sessionStorage.inputEntry(id)
    if (historic && this.sessionStorage.getEntrySync(historic)) return { operationId: id, state: 'submitted', messageId: historic, turnId: record?.turnId ?? id, error: null }
    return record?.rejected ? { operationId: id, state: 'failed', messageId: null, turnId: null, error: 'Input was not admitted' } : null
  }
  async submitChat(input: Submission): Promise<import('@lamplit/contracts').Receipt> {
    const connection = getCurrentAgent().connection
    const task = this.submissionMutation.then(async () => {
      const previous = this.sessionStorage.chatRecord(input.operationId)
      if (previous && ((previous as typeof previous & { fingerprint?: string }).fingerprint ? (previous as typeof previous & { fingerprint: string }).fingerprint !== await promptFingerprint(submissionIdentity(input)) : submissionIdentity(previous) !== submissionIdentity(input))) throw new Error('Submission identity conflict')
      const discovery = this.mcpDiscovery
      const existing = await this.lookupChat(input.operationId)
      if (existing) return existing
      await this.getLane(discovery)
      const turnId = await this.activeTurn() ?? input.operationId
      this.sessionStorage.recordChat(input.operationId, { ...input, turnId, createdAt: Date.now() })
      // Validation refusal is definite nonreception. Native errors remain ambiguous until lookup proves admission.
      try { await this.validateChatInput(input) } catch (error) {
        this.sessionStorage.setChatRejected(input.operationId, true)
        return { operationId: input.operationId, state: 'failed' as const, messageId: null, turnId: null, error: error instanceof Error ? error.message : String(error) }
      }
      const photos = await this.modelPhotos(input.operationId, input.images?.map(image => image.attachmentId))
      if (connection) { await this.verifyConnection(connection); if (!this.chatConnections.has(connection.id)) throw new Error('Chat connection ended before admission') }
      this.sessionStorage.freezePhotos(input.operationId, input.images?.map(image => image.attachmentId) ?? [])
      this.sessionStorage.saveInput(input.operationId, input.text, input.images?.map(image => image.attachmentId) ?? [], 'prompt')
      await this.native.submit(photos.length ? [...(input.text ? [{ type: 'text' as const, text: input.text }] : []), ...photos] : input.text, { operationId: input.operationId, whenBusy: 'steer' })
      this.watchSettlement(input.operationId)
      const receipt = await this.lookupChat(input.operationId)
      if (!receipt) throw new Error('Native submission result is temporarily unavailable')
      return receipt
    })
    this.submissionMutation = task.catch(() => undefined)
    return task
  }
  private watchSettlement(id: string): void {
    this.ctx.waitUntil(this.native.wait(id).then(async () => {
      await this.lookupChat(id)
      const wake = this.sessionStorage.getSetting<WakeSource>(`wakeSource:${id}`)
      const submission = wake && await this.nativeSubmission(id)
      if (wake && submission?.entry) this.sessionStorage.setSetting(`wakeEntry:${this.sessionStorage.sourceId(submission.entry)}`, wake)
      await this.syncNativeEntries()
      const keet = this.sessionStorage.nextKeet()
      if (keet?.operationId === id) {
        const native = await this.nativeSubmission(id)
        if (native?.entry) { this.sessionStorage.acceptKeet(keet.sequence, this.sessionStorage.sourceId(native.entry)); this.sessionStorage.settleKeet(keet.sequence) }
      }
      this.scheduleMemoryExtraction(); await this.schedulePendingDrain()
    }))
  }
  async chatRecovery(): Promise<InputRecovery[]> {
    const result: InputRecovery[] = []
    for (const [id, record] of this.sessionStorage.unsettledChats('recovery')) {
      await this.lookupChat(id)
      if (!this.sessionStorage.eligible(id)) continue
      const available = await this.sharedImages(this.sessionStorage.photosForOperation(id))
      const images: ImageRef[] = (record.images ?? []).map(image => ({ ...image, availability: available.some(photo => photo.attachmentId === image.attachmentId && photo.availability === 'available') ? 'available' : 'missing' }))
      result.push(validateRecovery({ sourceId: id, operationId: id, text: record.text, images, replacementEligible: true }))
    }
    return result.slice(-20)
  }
  private async pendingChatMessages(): Promise<import('@lamplit/contracts').ChatMessage[]> {
    const messages: import('@lamplit/contracts').ChatMessage[] = []
    for (const [id, record] of this.sessionStorage.unsettledChats()) {
      const native = await this.nativeSubmission(id)
      if (native?.status !== 'queued' && !(native?.status === 'unanswered' && !native.entry && native.reason === 'aborted')) continue
      messages.push({ id: `submission:${id}`, operationId: id, turnId: record.turnId, role: 'user', text: record.text,
        createdAt: record.createdAt ?? 0, images: await this.sharedImages(this.sessionStorage.photosForOperation(id)) })
    }
    return messages
  }
  private async replyOutcomes(ids: string[]): Promise<import('@lamplit/contracts').ChatMessage[]> {
    const result: import('@lamplit/contracts').ChatMessage[] = []
    for (const [id, record] of this.sessionStorage.chatForEntries(ids)) {
      const native = await this.nativeSubmission(id)
      if (native?.status !== 'unanswered' || !native.entry) continue
      const lane = await this.getLane()
      const following = await lane.entries({ minEntryId: (native.entry + 1) as EntryId, maxEntryId: (native.entry + 30) as EntryId }, 30, undefined, this.nativeContext!)
      const ordered = following.items.slice().reverse()
      const nextInput = ordered.findIndex(entry => entry.kind === 'pi.user')
      const response = nextInput < 0 ? ordered : ordered.slice(0, nextInput)
      if (response.some(entry => entry.model?.some(message => message.role === 'assistant' && ['aborted','error'].includes(message.stopReason)))) continue
      const entry = await (await this.history()).entry(record.entryId!)
      result.push({ id: `turn:${id}:status`, role: 'notice', text: native.reason === 'aborted' ? '已停止回复' : '回复失败', createdAt: entry?.timestamp ?? 0, operationId: null, turnId: record.turnId, images: [] })
    }
    return result
  }
  private async sharedImages(photos: ConversationPhoto[]): Promise<ImageRef[]> {
    return Promise.all(photos.map(async photo => imageRef(photo, !!this.env.COMPUTER_R2 && !!await this.env.COMPUTER_R2.head(this.photoKey(photo.id, 'original')) && !!await this.env.COMPUTER_R2.head(this.photoKey(photo.id, 'preview')))))
  }
  private async validateChatInput(input: Submission): Promise<void> {
    validateSubmission(input)
    await this.modelEnvironment()
    if (this.sessionStorage.nativeInput(input.operationId) && !this.sessionStorage.chatRecord(input.operationId)) throw new Error('Operation belongs to native input')
    if (input.images?.length) {
      if (!await this.acceptsModelImages()) throw new Error('Selected model does not support images.')
      const photos = this.sessionStorage.photosForOperation(input.operationId)
      if (photos.length !== input.images.length || photos.some((photo, i) => photo.id !== input.images![i]!.attachmentId || imageRef(photo).name !== input.images![i]!.name || photo.mediaType !== input.images![i]!.mediaType || input.images![i]!.availability !== 'available')) throw new Error('Image operation identity conflict')
      await this.modelPhotos(input.operationId, input.images.map(image => image.attachmentId))
      for (const photo of photos) for (const variant of ['original', 'preview'] as const) {
        if (!await this.env.COMPUTER_R2!.head(this.photoKey(photo.id, variant))) throw new Error('Image variant is missing')
      }
    } else if (this.sessionStorage.photosForOperation(input.operationId).length) throw new Error('Image operation identity conflict')
    for (const source of input.replacementSourceIds ?? []) if (source === input.operationId || !this.sessionStorage.eligible(source)) throw new Error('Recovery source is no longer eligible')
  }
  // HTTP adapters pass the authenticated identity again at the durable boundary.
  async authorizeChatImages(owner: ChatImageOwner): Promise<void> {
    await this.waitUntilInitialized()
    if (owner.sessionId !== this.sessionStorage.getMetadataSync().id || owner.instanceId !== this.instanceId()) throw new Error('Image owner mismatch')
    if (this.env.HOSTED_MODE === 'true') {
      if (!owner.tokenHash || !/^[a-f0-9]{64}$/.test(owner.tokenHash) || !this.env.PLATFORM) throw new Error('Session required')
      const response = await this.env.PLATFORM.fetch(`${this.env.PLATFORM_ORIGIN ?? 'https://app.lamplit.run'}/internal/chat-session/${owner.tokenHash}/${owner.instanceId}`, { headers: { 'x-lamplit-internal-secret': this.env.CHAT_INTERNAL_SECRET! } })
      if (!response.ok || !(await response.json() as { active: boolean }).active) throw new Error('Session expired')
    }
  }
  async uploadChatImages(input: ImageUpload, owner: ChatImageOwner) {
    await this.authorizeChatImages(owner)
    checkUpload(input, owner.sessionId)
    if (!await this.acceptsModelImages()) throw new Error('Selected model does not support images.')
    const prepared: PhotoUpload[] = []
    for (const image of input.images) {
      const photo = { ...image, id: await nativePhotoId(input.operationId, image.id), operationId: input.operationId }
      photoBytes(photo) // Validate every native variant before allocating any photo rows.
      prepared.push(photo)
    }
    const images: ImageRef[] = []
    for (const image of prepared) {
      await this.authorizeChatImages(owner)
      const id = image.id
      const photo = await this.uploadPhoto(image)
      for (const variant of ['original', 'preview', 'model'] as const) if (!await this.env.COMPUTER_R2!.head(this.photoKey(id, variant))) throw new Error('Image variant is missing')
      images.push(imageRef(photo))
    }
    await this.authorizeChatImages(owner)
    return { sessionId: owner.sessionId, operationId: input.operationId, images }
  }
  async readChatImage(id: string, variant: 'original' | 'preview' | 'model', owner: ChatImageOwner) {
    await this.authorizeChatImages(owner)
    const photo = this.sessionStorage.photo(id)
    if (!photo || !this.env.COMPUTER_R2) return null
    const membership = photo.entryId && await (await this.history()).entry(photo.entryId)
    await this.reconcileExternalInputs()
    if (membership) this.presentEntry(membership)
    const operation = !!this.sessionStorage.chatRecord(photo.operationId) || this.sessionStorage.nativeInput(photo.operationId)
    if (!membership && (!operation || this.sessionStorage.replaced(photo.operationId))) return null
    const object = await this.env.COMPUTER_R2.get(this.photoKey(id, variant))
    const limit = variant === 'original' ? 32 * 1024 * 1024 : variant === 'preview' ? 160_000 : 320_000
    if (!object || object.size > limit) return null
    const bytes = new Uint8Array(await object.arrayBuffer())
    await this.authorizeChatImages(owner)
    return { bytes, mediaType: variant === 'original' ? photo.mediaType : 'image/jpeg' }
  }

  private photoKey(id: string, variant: 'original' | 'preview' | 'model'): string {
    const instanceId = this.instanceId()
    return `${instanceId ? `instances/${instanceId}/` : ''}conversation-photos/${this.sessionStorage.getMetadataSync().id}/${id}/${variant}`
  }

  @hostedCallable()
  async uploadPhoto(input: PhotoUpload): Promise<ConversationPhoto> {
    await this.waitUntilInitialized()
    if (!this.env.COMPUTER_R2) throw new Error('Photo storage is not configured.')
    const { original, preview, model } = photoBytes(input)
    const fingerprint = await promptFingerprint(JSON.stringify([input.operationId, input.id, input.order, input.name, input.mediaType, input.original, input.preview, input.model]))
    const previousPhotos = this.sessionStorage.photosForOperation(input.operationId)
    const photo: ConversationPhoto = { id: input.id, operationId: input.operationId, name: input.name, mediaType: input.mediaType, created: previousPhotos[0]?.created ?? Date.now(), order: input.order }
    if (this.sessionStorage.reservePhoto(photo, fingerprint, original.byteLength)) return this.sessionStorage.photo(input.id)!
    await Promise.all([
      this.env.COMPUTER_R2.put(this.photoKey(input.id, 'original'), original, { httpMetadata: { contentType: input.mediaType }, customMetadata: { fingerprint } }),
      this.env.COMPUTER_R2.put(this.photoKey(input.id, 'preview'), preview, { httpMetadata: { contentType: 'image/jpeg' } }),
      this.env.COMPUTER_R2.put(this.photoKey(input.id, 'model'), model, { httpMetadata: { contentType: 'image/jpeg' } }),
    ])
    this.sessionStorage.completePhoto(input.id, fingerprint)
    return this.sessionStorage.photo(input.id)!
  }

  @hostedCallable()
  async listConversationPhotos(input?: { cursor?: string; limit?: number }): Promise<ConversationPhotoPage> {
    return this.sessionStorage.listPhotos(input?.cursor, input?.limit)
  }

  private panelCursorSecret(): string {
    let secret = this.sessionStorage.getSetting<string>('panelCursorSecret')
    if (!secret) { secret = crypto.randomUUID(); this.sessionStorage.setSetting('panelCursorSecret', secret) }
    return secret
  }

  private async readPanelAlbum(cursor: string | null): Promise<AlbumPage> {
    await this.waitUntilInitialized()
    const sessionId = this.sessionStorage.getMetadataSync().id
    const cursors = new PanelCursors(() => sessionId, () => this.panelCursorSecret())
    const before = await cursors.decode('album', cursor)
    const page = this.sessionStorage.listPanelPhotos(before, PANEL_LIMITS.album)
    const images = await Promise.all(page.images.map(async photo => {
      const [preview, original] = this.env.COMPUTER_R2 ? await Promise.all([
        this.env.COMPUTER_R2.head(this.photoKey(photo.id, 'preview')),
        this.env.COMPUTER_R2.head(this.photoKey(photo.id, 'original')),
      ]) : [null, null]
      const base = `/api/conversation-images/${sessionId}/${photo.id}`
      const entry = await (await this.history()).entry(photo.entryId ?? '')
      await this.reconcileExternalInputs()
      if (entry) this.presentEntry(entry)
      const origin: AlbumPage['images'][number]['origin'] = entry?.type === 'message' && entry.message.role === 'assistant' ? 'agent' : 'human'
      return { id: photo.id, filename: photo.name, createdAt: photo.created, origin,
        available: Boolean(preview && original), previewUrl: preview ? `${base}/preview` : null, originalUrl: original ? `${base}/original` : null }
    }))
    return { images, nextCursor: page.nextCursor ? await cursors.encode('album', page.nextCursor) : null }
  }

  async readConversationPhoto(id: string, variant: 'original' | 'preview', operationId?: string): Promise<Response> {
    if (!UUID.test(id)) return new Response('Not found', { status: 404 })
    const photo = this.sessionStorage.photo(id)
    if (!photo || (!photo.entryId && photo.operationId !== operationId)) return new Response('Not found', { status: 404 })
    if (!this.env.COMPUTER_R2) return new Response('Photo storage is not configured', { status: 404 })
    const object = await this.env.COMPUTER_R2.get(this.photoKey(id, variant))
    if (!object) return new Response('Not found', { status: 404 })
    return new Response(object.body, { headers: { 'content-type': variant === 'preview' ? 'image/jpeg' : photo.mediaType, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' } })
  }

  async deleteConversationPhoto(id: string): Promise<void> {
    if (!UUID.test(id) || !this.sessionStorage.photo(id)) throw new Error('Photo not found.')
    if (!this.env.COMPUTER_R2) throw new Error('Photo storage is not configured.')
    await Promise.all((['original', 'preview', 'model'] as const).map((variant) => this.env.COMPUTER_R2!.delete(this.photoKey(id, variant))))
    this.sessionStorage.deletePhoto(id)
  }

  private async acceptsModelImages(): Promise<boolean> {
    const reference = (await (await this.getLane()).agent(this.nativeContext!)).model
    return nativeProviders().find(provider => provider.id === reference?.provider)?.getModels().find(model => model.id === reference?.modelId)?.input.includes('image') ?? false
  }

  private async modelPhotos(operationId: string, ids: string[] | undefined): Promise<Array<{ type: 'image'; data: string; mimeType: string }>> {
    if (!ids?.length) return []
    const bucket = this.env.COMPUTER_R2
    if (!bucket) throw new Error('Photo storage is not configured.')
    if (ids.length > 6 || new Set(ids).size !== ids.length) throw new Error('Too many or duplicate photos.')
    const photos = this.sessionStorage.photosForOperation(operationId)
    if (photos.length !== ids.length || photos.some((photo, index) => photo.id !== ids[index] || photo.order !== index)) throw new Error('Photo group is incomplete.')
    const content = await Promise.all(photos.map(async (photo) => {
      const object = await bucket.get(this.photoKey(photo.id, 'model'))
      if (!object || object.size > 320_000) throw new Error('Photo model variant is unavailable.')
      const bytes = new Uint8Array(await object.arrayBuffer())
      if (!isPhotoBytes(bytes, 'image/jpeg')) throw new Error('Invalid model image')
      return { type: 'image' as const, data: encodeBase64(bytes), mimeType: 'image/jpeg' }
    }))
    if (JSON.stringify(content).length > PHOTO_ROW_BUDGET) throw new Error('Photo group exceeds the Pi message size limit.')
    return content
  }

  async deleteContents(): Promise<void> {
    await this.native.abort()
    this.active = true
    if (this.env.COMPUTER_R2) {
      for (const id of this.sessionStorage.allPhotoIds()) {
        await Promise.all((['original', 'preview', 'model'] as const).map((variant) => this.env.COMPUTER_R2!.delete(this.photoKey(id, variant))))
      }
    }
    for (const entry of await this.workspace.readDir('/')) {
      await this.workspace.rm(entry.path, { recursive: true, force: true })
    }
    await this.destroy()
  }

  // Internal registry reads; browser calls enter through the authenticated chat host.
  async compactionSearchEntries(after = 0): Promise<{ events: SessionIndexEvent[]; next: number | null }> {
    const sessionId = this.sessionStorage.getMetadataSync().id
    const history = await this.history()
    const rows = this.sessionStorage.archiveCompactions(after)
    const events: SessionIndexEvent[] = []
    for (const source of rows.slice(0, 30)) {
      const entry = await history.entry(source.id) ?? source
      const node = nativeSearchNode(entry)
      if (node.record) events.push({ eventId: `${sessionId}:summary:${source.seq}`, type: 'message', entryId: entry.id, entrySeq: source.seq,
        role: 'compaction', timestamp: node.createdAt, text: node.record.content })
    }
    return { events, next: rows.length > 30 ? rows[29].seq : null }
  }

  async readSearchRecord(entryId: string): Promise<import('@lamplit/contracts').SearchReadResult> {
    const metadata = this.sessionStorage.getMetadataSync()
    const history = await this.history()
    const target = await history.entry(entryId)
    await this.reconcileExternalInputs()
    if (!target) throw new Error('Record not found')
    const selected: Entry[] = [target]
    const nativeId = this.sessionStorage.nativeId(entryId) ?? Number(/^native:(\d+)/.exec(entryId)?.[1])
    if (Number.isSafeInteger(nativeId) && !this.sessionStorage.nativeId(entryId)) {
      const lane = await this.getLane()
      const previous = (await lane.entries({ maxEntryId: (nativeId - 1) as EntryId }, 30, undefined, this.nativeContext!)).items.slice().reverse()
      const following = (await lane.entries({ minEntryId: (nativeId + 1) as EntryId, maxEntryId: (nativeId + 30) as EntryId }, 30, undefined, this.nativeContext!)).items.slice().reverse()
      const all = [...previous.flatMap(record => history.project(record)), target, ...following.flatMap(record => history.project(record))]
      selected.splice(0, 1, ...all.map((entry, index) => ({ ...entry, parentId: all[index - 1]?.id ?? null })))
    } else {
      let parent = target.parentId
      for (let work = 0; parent && work < 30; work++) { const entry = await history.entry(parent); if (!entry) break; selected.unshift(entry); parent = entry.parentId }
      let id = target.id
      for (let work = 0; work < 30; work++) { const children = this.sessionStorage.archiveChildren(id); if (children.length !== 1) break; selected.push(children[0]); id = children[0].id }
    }
    await this.reconcileExternalInputs()
    return readSearchNodes(metadata.id, this.sessionStorage.getSetting<string>('name'), selected.map(entry => {
      const visible = this.presentEntry(entry)
      const source = this.sessionStorage.keetSource(entry.id)
      if (source && entry.type === 'message' && entry.message.role === 'user') return nativeSearchNode({ ...entry, timestamp: visible.authoredAt ?? entry.timestamp, message: { ...entry.message, content: source.kind === 'matrix' ? JSON.parse(source.original).body : source.text } })
      return nativeSearchNode(entry)
    }), entryId)
  }

  async flushOutbox(): Promise<SessionIndexEvent[]> {
    await this.reconcileExternalInputs()
    await this.observeNative()
    const refs = this.sessionStorage.references('indexed')
    const history = await this.history()
    const sessionId = this.sessionStorage.getMetadataSync().id
    const events: SessionIndexEvent[] = []
    for (const event of this.sessionStorage.getOutbox()) {
      if (event.type !== 'message') { events.push(event); continue }
      const entry = await history.entry(event.entryId)
      if (!entry) continue
      const visible = this.presentEntry(entry)
      const node = nativeSearchNode(entry.type === 'message' && entry.message.role === 'user' && (visible.matrix || visible.keet) ? { ...entry, timestamp: visible.authoredAt ?? entry.timestamp, message: { ...entry.message, content: visible.matrix?.text ?? visible.keet!.text } } : entry)
      if (node.record) events.push({ ...event, text: node.record.content, timestamp: node.createdAt })
    }
    for (const ref of refs) {
      const entry = await history.entry(ref.id)
      await this.reconcileExternalInputs()
      const visible = entry && this.presentEntry(entry)
      const node = entry && nativeSearchNode(entry.type === 'message' && entry.message.role === 'user' && (visible?.matrix || visible?.keet) ? { ...entry, timestamp: visible.authoredAt ?? entry.timestamp, message: { ...entry.message, content: visible.matrix?.text ?? visible.keet!.text } } : entry)
      if (node?.record?.content) events.push({ eventId: `${sessionId}:native:${ref.id}`, type: 'message', entryId: ref.id, entrySeq: ref.seq, role: node.record.kind === 'compaction' ? 'compaction' : node.record.role!, timestamp: node.createdAt, text: node.record.content })
      else this.sessionStorage.acknowledgeReferences('indexed', [ref.id])
    }
    if (refs.length) {
      const stats = this.sessionStorage.historyStats()
      const latest = this.sessionStorage.latestReference()
      if (latest) events.push({ eventId: `${sessionId}:native-touch:${latest.native_id}:${stats.messageCount}:${stats.leafId}`, type: 'touch', updatedAt: new Date(latest.timestamp).toISOString(), messageCount: stats.messageCount, activeLeafId: stats.leafId })
    }
    return events
  }

  async acknowledgeOutbox(eventIds: string[]): Promise<void> {
    this.sessionStorage.acknowledgeOutbox(eventIds.filter(id => !id.includes(':native:') && !id.includes(':native-touch:')))
    const prefix = `${this.sessionStorage.getMetadataSync().id}:native:`
    this.sessionStorage.acknowledgeReferences('indexed', eventIds.filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length)))
  }

  private getHarness(): Promise<Harness> { return this.native.pi() }
  private laneMutation: Promise<unknown> = Promise.resolve()
  private getLane(retryMcp?: InjectedMcpDiscovery) {
    const task = this.laneMutation.then(() => this.resolveLane(retryMcp))
    this.laneMutation = task.catch(() => undefined)
    return task
  }
  private async resolveLane(retryMcp?: InjectedMcpDiscovery) {
    let harness = await this.getHarness()
    if (!await this.nativeBusy(harness)) {
      const config = JSON.stringify(await this.modelEnvironment().catch(() => undefined))
      if (config !== this.runtimeConfig) { await this.native.dispose(); harness = await this.getHarness() }
      else if (retryMcp === this.mcpDiscovery && retryMcp?.retry) {
        // Retry a prior preparation's failures once per idle submission, never immediately or while busy.
        this.pendingMcpRetry = retryMcp.retry
        await this.native.dispose(); harness = await this.getHarness()
      }
    }
    const root = await harness.root(this.nativeContext!)
    if (!await this.nativeBusy(harness)) {
      let enabled = false
      try { enabled = (await searchSettings(this.env, this.instanceId())).enabled } catch { /* Search fails closed. */ }
      const tools = this.runtimeTools.filter(tool => tool.name !== 'web_search' || enabled)
      const active = await root.agent(this.nativeContext!)
      if (JSON.stringify(active.tools.map(tool => tool.name)) !== JSON.stringify(tools.map(tool => tool.name))) await root.configure({ tools }, this.nativeContext!)
    }
    return root
  }
  private compactionSettings(): CompactionSettings { return this.sessionStorage.getSetting<CompactionSettings>('compaction') ?? { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } }
  private observeMutation: Promise<unknown> = Promise.resolve()
  private observeNative(): Promise<boolean> {
    const next = this.observeMutation.then(() => this.observeNativeBatch())
    this.observeMutation = next.catch(() => undefined)
    return next
  }
  private async observeNativeBatch(): Promise<boolean> {
    const lane = await this.getLane()
    const progress = this.sessionStorage.getSetting<{ through: number; max: number; cursor?: Cursor; entry?: number; part?: number }>('nativeObservation') ?? { through: 0, max: 0 }
    if (!progress.max) progress.max = (await lane.entries({}, 1, undefined, this.nativeContext!)).items[0]?.id ?? 0
    if (progress.max <= progress.through) return true
    const history = new NativeHistory(this.sessionStorage, lane, this.nativeContext!)
    let work = 0, references = 0, done = false
    while (work++ < 30 && references < 30) {
      const page = progress.entry ? undefined : await lane.entries({ minEntryId: (progress.through + 1) as EntryId, maxEntryId: progress.max as EntryId }, 1, progress.cursor, this.nativeContext!)
      const record = progress.entry ? await history.readNative(progress.entry) : page?.items[0]
      if (!record) { done = true; break }
      if (page) progress.cursor = page.next
      const part = progress.part ?? 0
      const count = history.parts(record)
      const selected = history.project(record, part, 30 - references)
      for (const [offset, entry] of selected.entries()) this.sessionStorage.observeEntry(entry, record.id, part + offset)
      references += selected.length
      progress.part = Math.min(count, part + (30 - references + selected.length))
      progress.entry = progress.part < count ? record.id : undefined
      if (!progress.entry) progress.part = undefined
      if (!progress.entry && !progress.cursor) { done = true; break }
    }
    this.sessionStorage.setSetting('nativeObservation', done ? { through: progress.max, max: 0 } : progress)
    if (!done) await this.schedule(1, 'maintainNativeHistory', undefined, { idempotent: true })
    return done
  }

  async maintainNativeHistory(): Promise<void> {
    await this.flushOutboxToRegistry()
    if (this.sessionStorage.references('indexed', 1).length || this.sessionStorage.getOutbox().length) await this.schedule(1, 'maintainNativeHistory', undefined, { idempotent: true })
  }

  private async reconcileExternalInputs(): Promise<void> {
    for (const id of this.sessionStorage.unresolvedExternalInputs()) {
      const submission = await this.nativeSubmission(id)
      if (!submission) throw new Error('External admission is unresolved; inspection is required')
      if (submission.status === 'unanswered' && !submission.entry) this.sessionStorage.withdrawExternalInput(id)
      if (submission.entry) this.sessionStorage.bindExternalInput(id, this.sessionStorage.sourceId(submission.entry))
    }
  }
  private async syncNativeEntries(): Promise<void> {
    await this.observeNative()
    for (const [id] of this.sessionStorage.unsettledChats('reconcile')) await this.lookupChat(id)
    for (const source of this.sessionStorage.getSetting<WakeSource[]>('pendingWakes') ?? []) {
      const native = await this.nativeSubmission(`wake:${occurrenceKey(source)}`)
      if (native?.entry) this.sessionStorage.setSetting(`wakeEntry:${this.sessionStorage.sourceId(native.entry)}`, source)
    }
    const next = this.sessionStorage.nextKeet()
    if (next) { const native = await this.nativeSubmission(next.operationId); if (native?.entry) this.sessionStorage.acceptKeet(next.sequence, this.sessionStorage.sourceId(native.entry)) }
  }

  private async waitUntilInitialized(): Promise<void> {
    for (let attempt = 0; attempt < 40 && !this.sessionStorage.isInitialized(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (!this.sessionStorage.isInitialized()) throw new Error('Session has not been initialized.')
  }

  private async listAllWorkspaceFiles() {
    const files: Awaited<ReturnType<typeof this.workspace.readDir>> = []
    if (!await this.workspace.stat(WORKSPACE_ROOT)) return files
    const directories = [WORKSPACE_ROOT]
    while (directories.length > 0) {
      const directory = directories.pop()!
      for (let offset = 0; ; offset += WORKSPACE_PAGE_SIZE) {
        const entries = await this.workspace.readDir(directory, { limit: WORKSPACE_PAGE_SIZE, offset })
        for (const entry of entries) {
          if (entry.type === 'directory') directories.push(entry.path)
          else if (entry.type === 'file') files.push(entry)
        }
        if (entries.length < WORKSPACE_PAGE_SIZE) break
      }
    }
    return Promise.all(files.map(async (file) => await this.workspace.stat(file.path) ?? file))
  }

  private async withExclusiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (await this.compactBusy()) throw new Error('Pi is currently running.')
    this.active = true
    try {
      return await operation()
    } finally {
      this.active = false
    }
  }

  private async flushOutboxToRegistry(): Promise<void> {
    const events = await this.flushOutbox()
    if (events.length === 0) return
    await this.registry().applyIndexEvents(this.sessionStorage.getMetadataSync().id, events)
    await this.acknowledgeOutbox(events.map((event) => event.eventId))
  }

  private registry(): MemoryRegistry {
    return this.env.PiRegistry.getByName(this.instanceId() ?? PI_REGISTRY_INSTANCE) as unknown as MemoryRegistry
  }

  private instanceId(): string | null {
    if (this.env.HOSTED_MODE !== 'true') return null
    const match = /^([0-9a-f-]{36}):[0-9a-f-]{36}$/i.exec(this.name)
    if (!match) throw new Error('Hosted session has no instance identity')
    return match[1]
  }

  private scheduleMemoryExtraction(): void {
    const previous = this.memoryExtraction
    const extraction = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(async () => {
        await this.flushOutboxToRegistry()
        await this.extractNextMemoryBatch()
        const progress = this.sessionStorage.getSetting<{ max: number }>('nativeObservation')
        const cursor = this.sessionStorage.getSetting<number>(MEMORY_EXTRACTION_CURSOR) ?? 0
        if (progress?.max || this.sessionStorage.references('indexed', 1).length || this.sessionStorage.references('memorized', 1).length || this.sessionStorage.archiveAfter(cursor, 1).length) await this.schedule(1, 'maintainSessionMemory', undefined, { idempotent: true })
      })
    this.memoryExtraction = extraction
    this.ctx.waitUntil(extraction
      .catch((error) => console.error('Could not extract session memory', error))
      .finally(() => {
        if (this.memoryExtraction === extraction) this.memoryExtraction = undefined
      }))
  }

  async maintainSessionMemory(): Promise<void> { this.scheduleMemoryExtraction() }

  private async extractNextMemoryBatch(): Promise<void> {
    const modelEnv = await this.modelEnvironment()
    const cursor = this.sessionStorage.getSetting<number>(MEMORY_EXTRACTION_CURSOR) ?? 0
    if (!await this.observeNative()) return
    const refs = this.sessionStorage.references('memorized')
    const history = await this.history()
    const nativeEntries = await Promise.all(refs.map(async ref => { const entry = await history.entry(ref.id); return entry && { seq: ref.seq, entry } }))
    const indexedThrough = this.sessionStorage.getSetting<number>('registryIndexCursor') ?? 0
    const pending = [...this.sessionStorage.archiveAfter(cursor, 30).filter(entry => entry.seq <= indexedThrough).map(entry => ({ seq: entry.seq, entry })), ...nativeEntries.filter((entry): entry is { seq: number; entry: Entry } => !!entry)]
      .filter((row, index, rows) => rows.findIndex(other => other.entry.id === row.entry.id) === index)
    await this.reconcileExternalInputs()
    if (pending.length === 0) return

    const entries: MemorySourceEntry[] = []
    let characters = 0
    let throughRevision = cursor
    const processed: string[] = []
    for (const { seq, entry } of pending) {
      this.presentEntry(entry) // Validate the exact association before using private source semantics.
      const source = memorySourceEntry(entry, this.sessionStorage.keetModelPrompt(entry.id))
      const size = source?.text.length ?? 0
      if (entries.length > 0 && characters + size > MEMORY_EXTRACTION_BATCH_CHARS) break
      if (this.sessionStorage.archiveMetadata(entry.id)) throughRevision = Math.max(throughRevision, seq)
      processed.push(entry.id)
      if (source) {
        entries.push(source)
        characters += size
      }
    }
    if (entries.length === 0) {
      this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, throughRevision)
      this.sessionStorage.acknowledgeReferences('memorized', processed)
      return
    }

    const registry = this.registry()
    const operations = await extractMemoryOperations({
      models: await accountModels(modelEnv),
      model: selectedModel(modelEnv),
      selection: modelEnv,
      memories: await registry.listMemories(),
      entries,
      sessionId: this.sessionStorage.getMetadataSync().id,
    })
    await registry.applyMemoryExtraction({
      extractionId: `${this.sessionStorage.getMetadataSync().id}:${throughRevision}:${processed.at(-1)}`,
      sessionId: this.sessionStorage.getMetadataSync().id,
      throughRevision,
      operations,
    })
    this.sessionStorage.acknowledgeReferences('memorized', processed)
    const latestCursor = this.sessionStorage.getSetting<number>(MEMORY_EXTRACTION_CURSOR) ?? 0
    this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, Math.max(latestCursor, throughRevision))
  }

  private async modelEnvironment(): Promise<ModelEnvironment> {
    const instanceId = this.instanceId()
    if (!instanceId) return selfHostModelEnvironment(this.env)
    if (!this.env.PLATFORM || !this.env.CHAT_INTERNAL_SECRET) throw new Error('Hosted model service is unavailable')
    const response = await this.env.PLATFORM.fetch(`${this.env.PLATFORM_ORIGIN ?? 'https://app.lamplit.run'}/internal/chat-model/${instanceId}`, {
      headers: { 'x-lamplit-internal-secret': this.env.CHAT_INTERNAL_SECRET },
    })
    if (response.status === 404) throw new Error('Model is not configured.')
    if (!response.ok) throw new Error('Model configuration is unavailable')
    return { PI_SYSTEM_PROMPT: this.env.PI_SYSTEM_PROMPT, ...resolveModelSelection(await response.json()) }
  }
}

function photoBytes(input: PhotoUpload) {
  if (!UUID.test(input.operationId) || !UUID.test(input.id)) throw new Error('Invalid photo identity.')
  if (!Number.isInteger(input.order) || input.order < 0 || input.order >= 6) throw new Error('Too many photos.')
  if (!PHOTO_TYPES.has(input.mediaType) || input.name.length > 255) throw new Error('Unsupported photo type or name.')
  if (input.original.length > 11_000_000 || input.preview.length > 220_000 || input.model.length > 450_000) throw new Error('Photo exceeds size limits.')
  const original = decodeBase64(input.original)
  const preview = decodeBase64(input.preview)
  const model = decodeBase64(input.model)
  if (original.byteLength > 8_000_000 || preview.byteLength > 160_000 || model.byteLength > 320_000) throw new Error('Photo exceeds size limits.')
  if (!isPhotoBytes(original, input.mediaType) || !isPhotoBytes(preview, 'image/jpeg') || !isPhotoBytes(model, 'image/jpeg')) throw new Error('Photo bytes do not match the supported image type.')
  return { original, preview, model }
}

function isPhotoBytes(bytes: Uint8Array, type: string): boolean {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
  if (type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  if (type === 'image/gif') return bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/) !== null
  if (type === 'image/webp') return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  return false
}

async function promptFingerprint(prompt: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function storedEntry(seq: number, entry: Entry): StoredSessionEntry {
  return {
    seq,
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: new Date(entry.timestamp).toISOString(),
    message: entry.type === 'message' ? browserMessage(entry.message) : undefined,
    wakeSource: entry.type === 'message' && entry.message.role === 'custom' && entry.message.customType === WAKE_CUSTOM_TYPE ? entry.message.details as WakeSource : undefined,
    summary: entry.type === 'compaction' || entry.type === 'branch_summary' ? entry.summary : undefined,
  }
}

function browserMessage(message: Extract<Entry, { type: 'message' }>['message']): StoredSessionEntry['message'] {
  if (!('content' in message) || !Array.isArray(message.content)) return message
  return { ...message, content: message.content.filter((part) => part.type !== 'image') }
}

function messageText(message: unknown): string {
  const content = typeof message === 'object' && message !== null && 'content' in message
    ? message.content
    : message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function memorySourceEntry(entry: Entry, keetPrompt?: string): MemorySourceEntry | undefined {
  if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return
  let text = (keetPrompt ?? messageText(entry.message)).trim()
  if (!text) return
  if (text.length > MEMORY_SOURCE_ENTRY_CHARS) {
    const half = MEMORY_SOURCE_ENTRY_CHARS / 2
    text = `${text.slice(0, half)}\n[...truncated for memory extraction...]\n${text.slice(-half)}`
  }
  return { id: entry.id, role: entry.message.role, text }
}

function encodeBase64(bytes: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(value)
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

import { createWakeTools } from './timed-wake-tools'
import { makeWake } from './timed-wake'
import { WAKE_CUSTOM_TYPE, type WakeSource, type TimedWake, type WakeInput } from '../shared/timed-wake'
import { createPlatformFeedbackTools } from './platform-feedback-tool'
import { createWebTools, searchSettings } from './web-tools'
import { CompanionFiles, MaterialFailure, materialReply } from './companion-materials'
import type { MaterialRequest, MaterialReply } from '../shared/companion-materials'
import type { PiRegistry } from './pi-registry'
import {
  type DurableObjectStorageLike,
  Workspace,
} from '@cloudflare/computer'
import { laneState, operationMeta, pendingEntry } from '@earendil-works/pi-agent-core/harness/session'
import {
  DEFAULT_COMPACTION_SETTINGS,
  StorageBackedSession,
  type Entry,
} from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import { hostedCallable, HostedAgent } from './hosted-agent'
import type { StreamingResponse } from 'agents'
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
  PiStreamEvent,
  PhotoUpload,
  PromptAdmissionStatus,
  SessionBranch,
  SessionIndexEvent,
  SessionOverview,
  SessionSummary,
  StoredSessionEntry,
  SteerAdmissionStatus,
  WorkspaceFile,
  WorkspaceFileContent,
} from '../shared/pi-contract'
import { createPiHarness, getMemoryModel, type ModelEnvironment, type PiHarness } from './create-pi-harness'
import { admitAndDrivePrompt, exactPromptEntryId, getPromptAdmission, prepareOpenOperationResume } from './prompt-lifecycle'
import { extractMemoryOperations, type MemorySourceEntry } from './memory-extractor'
import { createMemoryTool } from './memory-tools'
import { createRelationshipTools } from './relationship-tools'
import { PiSessionStorage, type PiSessionMetadata } from './pi-session-storage'
import { toPiStreamEvent } from './stream-events'
import { PI_REGISTRY_INSTANCE } from '../shared/pi-contract'
import { createSessionSearchTool, createWorkspaceTools } from './workspace-tools'
import type { ComputerWorkspace } from './computer-workspace'
import { WORKSPACE_ROOT, workspacePath } from './workspace-root'

type InitializeMetadata = Pick<SessionSummary, 'id' | 'createdAt' | 'updatedAt' | 'lineage'> & { name?: string }
type SessionExport = {
  metadata: PiSessionMetadata
  entries: Entry[]
  compaction: CompactionSettings
  files: Array<{ path: string; content: string; encoding?: 'base64' }>
}
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
  revokePersonalSession(tokenHash: string): void {
    this.closeSessionConnections(tokenHash)
  }
  async materialsRequest(request: MaterialRequest): Promise<MaterialReply> {
    return materialReply(async () => {
      if (this.active) throw new MaterialFailure('busy', 409)
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
  private promptOperationId?: string
  private harness?: Promise<PiHarness>
  private harnessModelConfig?: string
  private memoryExtraction?: Promise<void>
  private readonly sessionStorage = new PiSessionStorage(this.ctx.storage)
  private coreSession?: StorageBackedSession
  private get session(): StorageBackedSession {
    return this.coreSession ??= new StorageBackedSession(this.sessionStorage.coreMetadata(), this.sessionStorage)
  }
  private readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    sessionId: this.ctx.id.toString(),
    useThink: true,
  }) as ComputerWorkspace

  async onStart(): Promise<void> {
    if (!this.sessionStorage.isInitialized() || this.active) return
    this.ctx.waitUntil(this.serializeWake(() => this.ensureWakeSchedules()))
    const durableState = this.sessionStorage.getValueSync(laneState('main'))?.value
    if (!durableState?.currentOperationId) {
      this.scheduleMemoryExtraction()
      this.ctx.waitUntil(this.schedulePendingDrain())
      return
    }
    this.active = true
    try {
      const lane = await this.getLane()
      const recovery = await prepareOpenOperationResume(
        lane, BACKGROUND_CONTEXT,
        (id) => this.sessionStorage.getPromptSubmission(id),
        async (id) => (await this.session.getValue(operationMeta(id), BACKGROUND_CONTEXT))?.value,
        (id) => this.sessionStorage.getEntrySync(id),
        (id, entryId) => this.sessionStorage.acceptPromptSubmission(id, entryId),
      )
      if (recovery) {
        if (recovery.browserPrompt) this.promptOperationId = recovery.operationId
        this.ctx.waitUntil((async () => {
          try {
            await this.wakeMutation
            const resumed = await lane.resume(BACKGROUND_CONTEXT)
            if (!resumed.ok) throw resumed.error
            await this.flushOutboxToRegistry()
          } finally {
            this.active = false
            this.promptOperationId = undefined
            this.scheduleMemoryExtraction()
            await this.schedulePendingDrain()
          }
        })())
      } else {
        this.active = false
        this.scheduleMemoryExtraction()
        this.ctx.waitUntil(this.schedulePendingDrain())
      }
    } catch (error) {
      this.active = false
      throw error
    }
  }

  async initialize(metadata: InitializeMetadata): Promise<SessionOverview> {
    await this.workspace.mkdir(WORKSPACE_ROOT, { recursive: true })
    const created = this.sessionStorage.initialize({
      id: metadata.id,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      lineage: metadata.lineage,
    })
    if (created && metadata.name) await this.session.setName(metadata.name, BACKGROUND_CONTEXT)
    return this.getOverview()
  }

  @hostedCallable()
  async getOverview(): Promise<SessionOverview> {
    await this.waitUntilInitialized()
    const metadata = this.sessionStorage.getMetadataSync()
    const rows = this.sessionStorage.getEntriesWithSeq()
    const leafId = this.sessionStorage.getLeafId()
    const activePath = new Set(this.sessionStorage.getPathToRoot(leafId).map((entry) => entry.id))
    const parentIds = new Set(rows.map(({ entry }) => entry.parentId).filter((id): id is string => id !== null))
    const stats = await this.session.getStats(BACKGROUND_CONTEXT)
    const labels = new Map(await Promise.all(rows.map(async ({ entry }) => [entry.id, await this.session.getLabel(entry.id, BACKGROUND_CONTEXT)] as const)))
    return {
      id: metadata.id,
      name: await this.session.getName(BACKGROUND_CONTEXT),
      status: 'ready',
      createdAt: metadata.createdAt,
      updatedAt: rows.at(-1) ? new Date(rows.at(-1)!.entry.timestamp).toISOString() : metadata.updatedAt,
      messageCount: stats.messageCount,
      activeLeafId: leafId,
      lineage: metadata.lineage,
      revision: rows.at(-1)?.seq ?? 0,
      running: Boolean((await this.session.getValue(laneState('main'), BACKGROUND_CONTEXT))?.value.currentOperationId),
      compaction: this.compactionSettings(),
      tree: rows.map(({ seq, entry }) => ({
        seq,
        id: entry.id,
        parentId: entry.parentId,
        type: entry.type,
        role: entry.type === 'message' ? entry.message.role : undefined,
        preview: entryPreview(entry),
        label: labels.get(entry.id),
        timestamp: new Date(entry.timestamp).toISOString(),
        isLeaf: !parentIds.has(entry.id),
        isOnActiveBranch: activePath.has(entry.id),
      })),
    }
  }

  @hostedCallable()
  async getBranch(leafId?: string): Promise<SessionBranch> {
    await this.waitUntilInitialized()
    const rows = this.sessionStorage.getEntriesWithSeq()
    const seqById = new Map(rows.map(({ seq, entry }) => [entry.id, seq]))
    const selectedLeaf = leafId ?? this.sessionStorage.getLeafId()
    const entries = this.sessionStorage.getPathToRoot(selectedLeaf)
    return {
      leafId: selectedLeaf,
      revision: rows.at(-1)?.seq ?? 0,
      entries: entries.map((entry) => ({ ...storedEntry(seqById.get(entry.id) ?? 0, entry), photos: this.sessionStorage.photosForEntry(entry.id) })),
    }
  }

  @hostedCallable()
  async navigateTree(entryId: string, options?: { summarize?: boolean; customInstructions?: string; label?: string }): Promise<{ editorText?: string }> {
    if (this.active) throw new Error('Pi is currently running.')
    this.active = true
    try {
      const result = await (await this.getLane()).navigateTree(entryId, options, BACKGROUND_CONTEXT)
      if (!result.ok) throw result.error
      await this.flushOutboxToRegistry()
      return {}
    } finally {
      this.active = false
    }
  }

  @hostedCallable()
  async setSessionName(name: string): Promise<SessionOverview> {
    return this.withExclusiveOperation(async () => {
      await this.session.setName(name, BACKGROUND_CONTEXT)
      await this.flushOutboxToRegistry()
      return this.getOverview()
    })
  }

  @hostedCallable()
  async setEntryLabel(entryId: string, label?: string): Promise<SessionOverview> {
    return this.withExclusiveOperation(async () => {
      await this.session.setLabel(entryId, label, BACKGROUND_CONTEXT)
      await this.flushOutboxToRegistry()
      return this.getOverview()
    })
  }

  @hostedCallable()
  async compact(focus?: string): Promise<{ summary: string; tokensBefore: number }> {
    if (this.active) throw new Error('Pi is currently running.')
    this.active = true
    try {
      const result = await (await this.getLane()).compact({ customInstructions: focus }, BACKGROUND_CONTEXT)
      if (!result.ok) throw result.error
      if (result.value.compaction.status !== 'completed') throw new Error('Compaction did not complete; conversation preserved.')
      const entry = this.sessionStorage.getEntrySync(result.value.compaction.tipId ?? '')
      if (!entry || entry.type !== 'compaction') throw new Error('Compaction entry was not saved.')
      await this.flushOutboxToRegistry()
      return { summary: entry.summary, tokensBefore: entry.tokensBefore }
    } finally {
      this.active = false
    }
  }

  @hostedCallable()
  async updateCompactionSettings(settings: CompactionSettings): Promise<CompactionSettings> {
    if (!Number.isSafeInteger(settings.reserveTokens) || settings.reserveTokens < 0 ||
        !Number.isSafeInteger(settings.keepRecentTokens) || settings.keepRecentTokens < 0) {
      throw new Error('Compaction token settings must be non-negative integers.')
    }
    return this.withExclusiveOperation(async () => {
      const value = { ...settings }
      this.sessionStorage.setSetting('compaction', value)
      await (await this.getHarness()).setCompactionSettings(value, BACKGROUND_CONTEXT)
      return value
    })
  }

  @hostedCallable()
  async submitSteer(input: { submissionId: string; prompt: string; photoIds?: string[] }): Promise<SteerAdmissionStatus> {
    await this.waitUntilInitialized()
    if (!UUID.test(input.submissionId)) throw new Error('A valid submission ID is required.')
    const prompt = validPhotoPrompt(input.prompt, input.photoIds)
    const photos = await this.modelPhotos(input.submissionId, input.photoIds)
    if (JSON.stringify([prompt, photos]).length > PHOTO_ROW_BUDGET) throw new Error('Photo group exceeds the Pi message size limit.')
    const fingerprint = await promptFingerprint(submissionFingerprintInput(prompt, input.photoIds))
    const record = this.sessionStorage.admitSteer(input.submissionId, fingerprint, input.photoIds ?? [])
    if (record.created) {
      const result = await (await this.getLane()).steer({ role: 'user', content: photos.length ? [...(prompt ? [{ type: 'text' as const, text: prompt }] : []), ...photos] : prompt, timestamp: record.timestamp }, undefined, BACKGROUND_CONTEXT)
      if (!result.ok) throw result.error
      this.sessionStorage.acceptSteer(input.submissionId, result.value.entryId)
      this.sessionStorage.acceptPhotos(input.submissionId, result.value.entryId)
      await this.schedulePendingDrain()
    }
    return this.getSteerAdmission(input.submissionId)
  }

  @hostedCallable()
  async getSteerAdmission(submissionId: string): Promise<SteerAdmissionStatus> {
    if (!UUID.test(submissionId)) throw new Error('A valid submission ID is required.')
    const record = this.sessionStorage.steerRecord(submissionId)
    if (!record) return { state: 'missing', submissionId }
    if (record.entryId) { this.sessionStorage.acceptPhotos(submissionId, record.entryId); return { state: 'accepted', submissionId, entryId: record.entryId } }
    const state = (await this.session.getValue(laneState('main'), BACKGROUND_CONTEXT))?.value
    for (const item of state?.inbox ?? []) {
      const pending = (await this.session.getValue(pendingEntry(item.entryId), BACKGROUND_CONTEXT))?.value
      if (pending?.type === 'message' && pending.payload.role === 'user' && pending.payload.timestamp === record.timestamp &&
          await this.steerFingerprint(submissionId, messageText(pending.payload)) === record.fingerprint) {
        this.sessionStorage.acceptSteer(submissionId, item.entryId)
        this.sessionStorage.acceptPhotos(submissionId, item.entryId)
        await this.schedulePendingDrain()
        return { state: 'accepted', submissionId, entryId: item.entryId }
      }
    }
    const candidates = this.sessionStorage.entriesInOrder().filter((entry) => entry.type === 'message' && entry.message.role === 'user' && entry.message.timestamp === record.timestamp)
    let committed: Entry | undefined
    for (const candidate of candidates) {
      if (await this.steerFingerprint(submissionId, messageText(candidate.type === 'message' ? candidate.message : '')) === record.fingerprint) { committed = candidate; break }
    }
    if (committed) {
      this.sessionStorage.acceptSteer(submissionId, committed.id)
      this.sessionStorage.acceptPhotos(submissionId, committed.id)
      return { state: 'accepted', submissionId, entryId: committed.id }
    }
    return { state: 'uncertain', submissionId }
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
    if (this.sessionStorage.wakeReceipt(source)) { await this.ensureWakeSchedules(); await this.schedulePendingDrain(); return }
    const lane = await this.getLane()
    // Eligibility is checked at public admission start, after all lane acquisition waits.
    if (this.sessionStorage.wakeReceipt(source)) { await this.ensureWakeSchedules(); await this.schedulePendingDrain(); return }
    const wake = this.sessionStorage.timedWakes().find(item => item.id === source.wakeId && item.revision === source.revision && item.nextAt === source.scheduledAt)
    if (!wake) return
    if (Date.now() < Date.parse(wake.nextAt)) return
    if (Date.now() - Date.parse(wake.nextAt) > 60_000) {
      this.sessionStorage.advanceWake(wake, Date.now())
    } else {
      try {
        const queued = await lane.followUp({ role: 'custom', customType: WAKE_CUSTOM_TYPE, display: true,
          content: `[Your self-set reminder, scheduled ${source.scheduledAt}] ${source.title}\n${source.reminder}`, details: source, timestamp: Date.now() }, undefined, BACKGROUND_CONTEXT)
        if (!queued.ok) throw queued.error
      } catch (error) {
        if (!this.sessionStorage.wakeReceipt(source)) throw error
      }
    }
    // Future repeats are reliably registered before any current model execution.
    await this.ensureWakeSchedules()
    await this.schedulePendingDrain()
  }

  private async awaitWakeSchedules(): Promise<void> {
    await this.serializeWake(() => this.ensureWakeSchedules())
  }

  async drainPendingWork(): Promise<void> {
    if (this.active || !this.sessionStorage.isInitialized()) return
    this.active = true
    try {
      await this.awaitWakeSchedules()
      const lane = await this.getLane()
      if (!(await lane.inspectExecution(BACKGROUND_CONTEXT)).current) {
        const state = (await this.session.getValue(laneState('main'), BACKGROUND_CONTEXT))?.value
        if (state?.inbox.some((item) => item.kind === 'steer' || item.kind === 'followUp')) {
          const operationId = crypto.randomUUID()
          const admission = await lane.accept({ kind: 'prompt', operationId, prompt: '' }, BACKGROUND_CONTEXT)
          if (!admission.ok) throw admission.error
          const driven = await lane.drive({ operationId, waitForRetry: true }, BACKGROUND_CONTEXT)
          if (!driven.ok) throw driven.error
          await this.flushOutboxToRegistry()
        }
      }
    } finally {
      this.active = false
      this.scheduleMemoryExtraction()
      await this.schedulePendingDrain()
    }
  }

  private async schedulePendingDrain(): Promise<void> {
    const state = (await this.session.getValue(laneState('main'), BACKGROUND_CONTEXT))?.value
    if (state?.inbox.some((item) => item.kind === 'steer' || item.kind === 'followUp')) {
      await this.schedule(1, 'drainPendingWork', undefined, { idempotent: true })
    }
  }

  @hostedCallable()
  async followUp(prompt: string): Promise<void> {
    const result = await (await this.getLane()).followUp(validPrompt(prompt), undefined, BACKGROUND_CONTEXT)
    if (!result.ok) throw result.error
  }

  @hostedCallable()
  async abort(): Promise<void> {
    const result = await (await this.getLane()).abort(BACKGROUND_CONTEXT)
    if (!result.ok) throw result.error
  }

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
    if (!(await this.workspace.stat(directory))) return []
    const names: string[] = []
    for (let offset = 0; ; offset += WORKSPACE_PAGE_SIZE) {
      const entries = await this.workspace.readDir(directory, { limit: WORKSPACE_PAGE_SIZE, offset })
      names.push(...entries.filter((entry) => entry.type === 'file' && DIARY_NAME.test(entry.path.slice(directory.length + 1))).map((entry) => entry.path.slice(directory.length + 1)))
      if (entries.length < WORKSPACE_PAGE_SIZE) break
    }
    return names.sort().reverse()
  }

  @hostedCallable()
  async readDiary(name: string): Promise<DiaryEntry | null> {
    await this.waitUntilInitialized()
    if (!DIARY_NAME.test(name)) return null
    const path = `${WORKSPACE_ROOT}/memory/${name}`
    const stat = await this.workspace.stat(path)
    if (stat?.type !== 'file') return null
    if (stat.size > DIARY_ENTRY_MAX_BYTES) return { tooLarge: true }
    const text = await this.workspace.readFile(path)
    return text === null ? null : { name, text }
  }

  @hostedCallable({ streaming: true })
  async prompt(stream: StreamingResponse, input: { operationId: string; prompt: string; photoIds?: string[] }): Promise<void> {
    const modelEnv = await this.modelEnvironment()
    if (!modelEnv.MODEL_API_KEY || !modelEnv.MODEL_BASE_URL || !modelEnv.AI_MODEL) throw new Error('Model is not configured.')
    if (this.harnessModelConfig !== modelConfigKey(modelEnv)) this.harness = undefined
    const prompt = validPhotoPrompt(input.prompt, input.photoIds)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.operationId)) {
      throw new Error('A valid operation ID is required.')
    }
    const photos = await this.modelPhotos(input.operationId, input.photoIds)
    if (JSON.stringify([prompt, photos]).length > PHOTO_ROW_BUDGET) throw new Error('Photo group exceeds the Pi message size limit.')
    const fingerprint = await promptFingerprint(submissionFingerprintInput(prompt, input.photoIds))
    if (this.active && !this.sessionStorage.getPromptSubmission(input.operationId)) {
      throw new Error('Pi is already running in this workspace.')
    }
    const submission = this.sessionStorage.admitPromptSubmission(input.operationId, fingerprint, input.photoIds ?? [])
    if (!submission.created) {
      try {
        const status = await this.getPromptAdmission(input.operationId)
        if (status.state === 'accepted' || status.state === 'settled') {
          stream.send({ type: 'accepted', operationId: input.operationId, entryId: status.entryId } satisfies PiStreamEvent)
        }
      } finally {
        try { stream.send({ type: 'done' } satisfies PiStreamEvent) } catch { /* disconnected */ }
        try { stream.end() } catch { /* disconnected */ }
      }
      return
    }

    this.active = true
    this.promptOperationId = input.operationId
    let unsubscribe: Array<() => void> = []
    try {
      const harness = await this.getHarness()
      const eventTypes = ['message_update', 'message_end', 'tool_start', 'tool_update', 'tool_end'] as const
      unsubscribe = eventTypes.map((type) => harness.events.on(type, (event) => {
        const payload = toPiStreamEvent(event)
        if (payload) stream.send(payload)
      }))
      await admitAndDrivePrompt(await this.getLane(), { operationId: input.operationId, prompt, images: photos }, BACKGROUND_CONTEXT, async () => {
        const entryId = await exactPromptEntryId(
          input.operationId,
          async (id) => (await this.session.getValue(operationMeta(id), BACKGROUND_CONTEXT))?.value,
          (id) => this.sessionStorage.getEntrySync(id),
        )
        this.sessionStorage.acceptPromptSubmission(input.operationId, entryId)
        return entryId
      }, (entryId) => {
        stream.send({ type: 'accepted', operationId: input.operationId, entryId } satisfies PiStreamEvent)
      })
      await this.flushOutboxToRegistry()
    } catch (error) {
      try { stream.send({ type: 'error', error: error instanceof Error ? error.message : String(error) } satisfies PiStreamEvent) }
      catch { /* The operation may already be durable even if the connection is gone. */ }
    } finally {
      for (const remove of unsubscribe) remove()
      this.active = false
      this.promptOperationId = undefined
      try { stream.send({ type: 'done' } satisfies PiStreamEvent) } catch { /* disconnected */ }
      try { stream.end() } catch { /* disconnected */ }
      this.scheduleMemoryExtraction()
      await this.schedulePendingDrain()
    }
  }

  @hostedCallable()
  async getPromptAdmission(operationId: string): Promise<PromptAdmissionStatus> {
    await this.waitUntilInitialized()
    return getPromptAdmission(
      await this.getLane(),
      operationId,
      BACKGROUND_CONTEXT,
      (id) => this.sessionStorage.getPromptSubmission(id),
      async (id) => (await this.session.getValue(operationMeta(id), BACKGROUND_CONTEXT))?.value,
      (id) => this.sessionStorage.getEntrySync(id),
      (id, entryId) => this.sessionStorage.acceptPromptSubmission(id, entryId),
      this.promptOperationId === operationId,
    )
  }

  private photoKey(id: string, variant: 'original' | 'preview' | 'model'): string {
    const instanceId = this.instanceId()
    return `${instanceId ? `instances/${instanceId}/` : ''}conversation-photos/${this.sessionStorage.getMetadataSync().id}/${id}/${variant}`
  }

  @hostedCallable()
  async uploadPhoto(input: PhotoUpload): Promise<ConversationPhoto> {
    await this.waitUntilInitialized()
    if (!this.env.COMPUTER_R2) throw new Error('Photo storage is not configured.')
    if (!UUID.test(input.operationId) || !UUID.test(input.id)) throw new Error('Invalid photo identity.')
    if (!Number.isInteger(input.order) || input.order < 0 || input.order >= 6) throw new Error('Too many photos.')
    if (!PHOTO_TYPES.has(input.mediaType) || input.name.length > 255) throw new Error('Unsupported photo type or name.')
    if (input.original.length > 11_000_000 || input.preview.length > 220_000 || input.model.length > 450_000) throw new Error('Photo exceeds size limits.')
    const original = decodeBase64(input.original)
    const preview = decodeBase64(input.preview)
    const model = decodeBase64(input.model)
    if (original.byteLength > 8_000_000 || preview.byteLength > 160_000 || model.byteLength > 320_000) throw new Error('Photo exceeds size limits.')
    if (!isPhotoBytes(original, input.mediaType) || !isPhotoBytes(preview, 'image/jpeg') || !isPhotoBytes(model, 'image/jpeg')) throw new Error('Photo bytes do not match the supported image type.')
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
      return { type: 'image' as const, data: encodeBase64(new Uint8Array(await object.arrayBuffer())), mimeType: 'image/jpeg' }
    }))
    if (JSON.stringify(content).length > PHOTO_ROW_BUDGET) throw new Error('Photo group exceeds the Pi message size limit.')
    return content
  }

  private async steerFingerprint(operationId: string, prompt: string): Promise<string> {
    return promptFingerprint(submissionFingerprintInput(prompt, this.sessionStorage.photosForOperation(operationId).map((photo) => photo.id)))
  }

  async exportSession(entryId?: string): Promise<SessionExport> {
    return this.withExclusiveOperation(() => this.createExport(entryId))
  }

  async exportFork(entryId: string): Promise<SessionExport> {
    return this.withExclusiveOperation(async () => {
      const target = await this.session.getEntry(entryId, BACKGROUND_CONTEXT)
      if (!target || target.type !== 'message' || target.message.role !== 'user') {
        throw new Error('A fork must select a user message on the source branch.')
      }
      return this.createExport(target.parentId ?? undefined)
    })
  }

  async exportClone(): Promise<SessionExport> {
    return this.withExclusiveOperation(async () => this.createExport(this.sessionStorage.getLeafId() ?? undefined))
  }

  async importSession(snapshot: SessionExport, metadata?: InitializeMetadata): Promise<SessionOverview> {
    return this.withExclusiveOperation(async () => {
      const targetMetadata: PiSessionMetadata = metadata ? {
        id: metadata.id,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        lineage: metadata.lineage,
      } : snapshot.metadata
      await this.sessionStorage.replace(targetMetadata, snapshot.entries)
      this.sessionStorage.setSetting('compaction', snapshot.compaction)
      this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, this.sessionStorage.getEntriesWithSeq().at(-1)?.seq ?? 0)
      for (const file of snapshot.files) {
        const path = workspacePath(file.path)
        const parent = path.slice(0, path.lastIndexOf('/')) || '/'
        if (parent !== '/') await this.workspace.mkdir(parent, { recursive: true })
        if (file.encoding === 'base64') await this.workspace.fs.writeFile(path, decodeBase64(file.content))
        else await this.workspace.writeFile(path, file.content)
      }
      this.coreSession = undefined
      if (metadata?.name) await this.session.setName(metadata.name, BACKGROUND_CONTEXT)
      this.harness = undefined
      return this.getOverview()
    })
  }

  async deleteContents(): Promise<void> {
    if (this.active) {
      const lane = await this.getLane()
      await lane.abort(BACKGROUND_CONTEXT)
      await lane.waitForIdle(BACKGROUND_CONTEXT)
    }
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

  // TODO: push these to PiRegistry when that binding is present in the generated Env type.
  async flushOutbox(): Promise<SessionIndexEvent[]> {
    return this.sessionStorage.getOutbox() as SessionIndexEvent[]
  }

  async acknowledgeOutbox(eventIds: string[]): Promise<void> {
    this.sessionStorage.acknowledgeOutbox(eventIds)
  }

  private async getHarness(): Promise<PiHarness> {
    const registry = this.registry()
    this.harness ??= this.modelEnvironment().then(modelEnv => {
      this.harnessModelConfig = modelConfigKey(modelEnv)
      return createPiHarness({
      env: modelEnv,
      session: this.session,
      tools: [
        ...createWorkspaceTools(this.workspace),
        createSessionSearchTool(registry),
        createMemoryTool(registry, this.sessionStorage.getMetadataSync().id),
        ...createRelationshipTools(registry),
        ...createWakeTools(this, () => registry.getReportedTimeZone()),
        ...createWebTools(this.env, this.instanceId()),
        ...createPlatformFeedbackTools(this.env, this.instanceId(), this.sessionStorage.getMetadataSync().id),
      ],
      memory: registry,
      compaction: this.compactionSettings(),
      loadCompactionPrompt: async () => (await new CompanionFiles(this.workspace).effective()).content,
      loadInstructions: () => this.workspace.readFile(`${WORKSPACE_ROOT}/AGENTS.md`),
      getUserTimeZone: () => registry.getUserTimeZone(),
      awaitWakeSchedules: () => this.awaitWakeSchedules(),
      })
    })
    const harness = await this.harness
    const lane = await harness.lane('main', BACKGROUND_CONTEXT)
    let searchEnabled = false
    try { searchEnabled = (await searchSettings(this.env, this.instanceId())).enabled } catch { /* Fail closed; page reading remains available. */ }
    const names = await lane.getActiveTools(BACKGROUND_CONTEXT)
    if (names.includes('web_search') !== searchEnabled) {
      await lane.setActiveTools(searchEnabled ? [...names, 'web_search'] : names.filter(name => name !== 'web_search'), BACKGROUND_CONTEXT)
    }
    return harness
  }

  private async getLane() {
    return (await this.getHarness()).lane('main', BACKGROUND_CONTEXT)
  }

  private compactionSettings(): CompactionSettings {
    return this.sessionStorage.getSetting<CompactionSettings>('compaction') ?? { ...DEFAULT_COMPACTION_SETTINGS }
  }

  private async createExport(entryId?: string): Promise<SessionExport> {
    const entries = entryId ? this.sessionStorage.getPathToRoot(entryId) : []
    const files = await this.listAllWorkspaceFiles()
    const contents: Array<{ path: string; content: string; encoding: 'base64' }> = []
    for (const { path } of files) {
      const content = await this.workspace.readFileBytes(path)
      if (content !== null) contents.push({ path, content: encodeBase64(content), encoding: 'base64' })
    }
    return {
      metadata: this.sessionStorage.getMetadataSync(),
      entries,
      compaction: this.compactionSettings(),
      files: contents,
    }
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
    if (this.active) throw new Error('Pi is currently running.')
    this.active = true
    try {
      return await operation()
    } finally {
      this.active = false
    }
  }

  private async flushOutboxToRegistry(): Promise<void> {
    const events = this.sessionStorage.getOutbox() as SessionIndexEvent[]
    if (events.length === 0) return
    await this.registry().applyIndexEvents(this.sessionStorage.getMetadataSync().id, events)
    this.sessionStorage.acknowledgeOutbox(events.map((event) => event.eventId))
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
      })
    this.memoryExtraction = extraction
    this.ctx.waitUntil(extraction
      .catch((error) => console.error('Could not extract session memory', error))
      .finally(() => {
        if (this.memoryExtraction === extraction) this.memoryExtraction = undefined
      }))
  }

  private async extractNextMemoryBatch(): Promise<void> {
    const modelEnv = await this.modelEnvironment()
    if (!modelEnv.MODEL_API_KEY || !modelEnv.MODEL_BASE_URL) return
    const cursor = this.sessionStorage.getSetting<number>(MEMORY_EXTRACTION_CURSOR) ?? 0
    const pending = this.sessionStorage.getEntriesWithSeq().filter(({ seq }) => seq > cursor)
    if (pending.length === 0) return

    const entries: MemorySourceEntry[] = []
    let characters = 0
    let throughRevision = cursor
    for (const { seq, entry } of pending) {
      const source = memorySourceEntry(entry)
      const size = source?.text.length ?? 0
      if (entries.length > 0 && characters + size > MEMORY_EXTRACTION_BATCH_CHARS) break
      throughRevision = seq
      if (source) {
        entries.push(source)
        characters += size
      }
    }
    if (entries.length === 0) {
      this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, throughRevision)
      return
    }

    const registry = this.registry()
    const operations = await extractMemoryOperations({
      models: (await this.getHarness()).models,
      model: getMemoryModel(modelEnv),
      memories: await registry.listMemories(),
      entries,
      sessionId: this.sessionStorage.getMetadataSync().id,
    })
    await registry.applyMemoryExtraction({
      extractionId: `${this.sessionStorage.getMetadataSync().id}:${throughRevision}`,
      sessionId: this.sessionStorage.getMetadataSync().id,
      throughRevision,
      operations,
    })
    const latestCursor = this.sessionStorage.getSetting<number>(MEMORY_EXTRACTION_CURSOR) ?? 0
    this.sessionStorage.setSetting(MEMORY_EXTRACTION_CURSOR, Math.max(latestCursor, throughRevision))
  }

  private async modelEnvironment(): Promise<ModelEnvironment> {
    const instanceId = this.instanceId()
    if (!instanceId) return this.env
    if (!this.env.PLATFORM || !this.env.CHAT_INTERNAL_SECRET) throw new Error('Hosted model service is unavailable')
    const response = await this.env.PLATFORM.fetch(`${this.env.PLATFORM_ORIGIN ?? 'https://app.lamplit.run'}/internal/chat-model/${instanceId}`, {
      headers: { 'x-lamplit-internal-secret': this.env.CHAT_INTERNAL_SECRET },
    })
    if (response.status === 404) return { ...this.env, MODEL_API_KEY: '', MODEL_BASE_URL: '', AI_MODEL: '', AI_MEMORY_MODEL: '' }
    if (!response.ok) throw new Error('Model configuration is unavailable')
    const config = await response.json() as { baseUrl: string; model: string; apiKey: string }
    return { ...this.env, MODEL_BASE_URL: config.baseUrl, AI_MODEL: config.model, AI_MEMORY_MODEL: config.model, MODEL_API_KEY: config.apiKey }
  }
}

function validPrompt(prompt: string): string {
  prompt = prompt.trim()
  if (!prompt) throw new Error('A prompt is required.')
  if (prompt.length > 20_000) throw new Error('Prompt exceeds 20,000 characters.')
  return prompt
}

function modelConfigKey(env: ModelEnvironment): string {
  return JSON.stringify([env.MODEL_API_KEY, env.MODEL_BASE_URL, env.AI_MODEL, env.AI_MEMORY_MODEL])
}

function validPhotoPrompt(prompt: string, photoIds?: string[]): string {
  prompt = prompt.trim()
  if (!prompt && !photoIds?.length) throw new Error('A prompt or photo is required.')
  if (prompt.length > 20_000) throw new Error('Prompt exceeds 20,000 characters.')
  return prompt
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

function submissionFingerprintInput(prompt: string, photoIds: readonly string[] | undefined): string {
  return photoIds?.length ? JSON.stringify([prompt, photoIds]) : prompt
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

function entryPreview(entry: Entry): string {
  let value = ''
  if (entry.type === 'message') value = messageText(entry.message)
  else if (entry.type === 'compaction' || entry.type === 'branch_summary') value = entry.summary
  else if (entry.type === 'custom') value = entry.customType
  return value.replace(/\s+/g, ' ').trim().slice(0, 160)
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

function memorySourceEntry(entry: Entry): MemorySourceEntry | undefined {
  if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return
  let text = messageText(entry.message).trim()
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

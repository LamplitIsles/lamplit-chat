export const PI_AGENT_NAME = 'PiSession'
export const PI_REGISTRY_NAME = 'PiRegistry'
export const PI_AGENT_PREFIX = 'api/agents'
export const PI_REGISTRY_INSTANCE = 'singleton'

export type PiStreamEvent =
  | { type: 'accepted'; operationId: string; entryId: string }
  | { type: 'text_start' | 'text_end' | 'thinking_start' | 'thinking_end' | 'done' }
  | { type: 'text_delta' | 'thinking_delta'; delta: string }
  | { type: 'tool_execution_start'; callId: string; name: string; args: unknown }
  | { type: 'tool_execution_update'; callId: string; name: string; result: unknown }
  | { type: 'tool_execution_end'; callId: string; name: string; isError: boolean; result?: unknown }
  | { type: 'error'; error: string }

export type PromptAdmissionStatus =
  | { state: 'accepted'; operationId: string; entryId: string; running: boolean }
  | { state: 'settled'; operationId: string; entryId: string; status: 'completed' | 'failed' | 'aborted' | 'declined' }
  | { state: 'uncertain'; operationId: string }
  | { state: 'missing'; operationId: string }

export type SteerAdmissionStatus = { state: 'accepted'; submissionId: string; entryId: string } | { state: 'uncertain' | 'missing'; submissionId: string }

export type ConversationPhoto = { id: string; operationId: string; name: string; mediaType: string; created: number; order: number; entryId?: string }
export type PhotoUpload = { operationId: string; id: string; order: number; name: string; mediaType: string; original: string; preview: string; model: string }
export type ConversationPhotoPage = { images: ConversationPhoto[]; nextCursor?: string }

export type WorkspaceFile = {
  path: string
  size: number
  mtime: string
}

export type WorkspaceFileContent = WorkspaceFile & {
  content: string
}

export type DiaryEntry = { name: string; text: string } | { tooLarge: true }

export type TranscriptMessage = {
  role?: string
  content?: unknown
}

export type SessionStatus = 'creating' | 'ready' | 'deleting' | 'error'
export type SessionLineage = {
  type: 'new' | 'fork' | 'clone'
  parentSessionId?: string
  sourceEntryId?: string
}

export type SessionSummary = {
  id: string
  name?: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  messageCount: number
  activeLeafId: string | null
  lineage: SessionLineage
}

export type SessionTreeNode = {
  seq: number
  id: string
  parentId: string | null
  type: string
  role?: string
  preview: string
  label?: string
  timestamp: string
  isLeaf: boolean
  isOnActiveBranch: boolean
}

export type StoredSessionEntry = {
  seq: number
  id: string
  parentId: string | null
  type: string
  timestamp: string
  message?: TranscriptMessage
  summary?: string
  firstKeptEntryId?: string
  targetId?: string | null
  label?: string
  name?: string
  photos?: ConversationPhoto[]
}

export type SessionOverview = SessionSummary & {
  revision: number
  running: boolean
  tree: SessionTreeNode[]
  compaction: CompactionSettings
}

export type SessionBranch = {
  leafId: string | null
  revision: number
  entries: StoredSessionEntry[]
}

export type CompactionSettings = {
  enabled: boolean
  reserveTokens: number
  keepRecentTokens: number
}

export type SessionSearchResult = {
  session: SessionSummary
  matches: Array<{
    entryId: string
    role: string
    timestamp: string
    text: string
  }>
}

export type SessionListInput = {
  query?: string
  limit?: number
  sort?: 'recent' | 'relevance' | 'threaded'
  namedOnly?: boolean
}

export type SessionIndexEvent =
  | { eventId: string; type: 'message'; entryId: string; entrySeq: number; role: string; timestamp: string; text: string }
  | { eventId: string; type: 'touch'; updatedAt: string; messageCount: number; activeLeafId: string | null }
  | { eventId: string; type: 'rename'; name?: string }
  | { eventId: string; type: 'delete' }

export type MemoryKind = 'preference' | 'fact' | 'instruction' | 'decision'

export type Memory = {
  id: string
  kind: MemoryKind
  content: string
  sourceSessionId?: string
  sourceEntryId?: string
  createdAt: string
  updatedAt: string
}

export type RelationshipMood = 'neutral' | 'serene' | 'bright' | 'playful' | 'tender' | 'pensive' | 'tired' | 'low'

export type RelationshipState = {
  mood: RelationshipMood
  note?: string
  affinity: number
  signature: string
}

export type RelationshipRecord = {
  at: string
  changes: {
    seed?: true
    mood?: { value: RelationshipMood; note?: string; reason?: string }
    affinity?: { delta: number; value: number; reason?: string }
    signature?: { value: string; reason?: string }
  }
  state: RelationshipState
}

export type RelationshipUpdate = {
  mood?: { value: RelationshipMood; note?: string; reason: string }
  affinity?: { delta: number; reason: string }
  signature?: { value: string; reason: string }
}

export type RelationshipSnapshot = {
  state: RelationshipState
  records: RelationshipRecord[]
  nextBefore?: number
  hasEarlier: boolean
  predecessor?: RelationshipRecord
}

export type MemoryExtractionOperation =
  | { action: 'add'; kind: MemoryKind; content: string; sourceEntryId: string }
  | { action: 'update'; id: string; expectedUpdatedAt: string; kind: MemoryKind; content: string; sourceEntryId: string }
  | { action: 'delete'; id: string; expectedUpdatedAt: string; sourceEntryId: string }

export type ApplyMemoryExtractionInput = {
  extractionId: string
  sessionId: string
  throughRevision: number
  operations: MemoryExtractionOperation[]
}

export interface PiSessionContract {
  readonly state: unknown
  getOverview(): Promise<SessionOverview>
  getBranch(leafId?: string): Promise<SessionBranch>
  navigateTree(entryId: string, options?: { summarize?: boolean; customInstructions?: string; label?: string }): Promise<{ editorText?: string }>
  setSessionName(name: string): Promise<SessionOverview>
  setEntryLabel(entryId: string, label?: string): Promise<SessionOverview>
  compact(focus?: string): Promise<{ summary: string; tokensBefore: number }>
  updateCompactionSettings(settings: CompactionSettings): Promise<CompactionSettings>
  submitSteer(input: { submissionId: string; prompt: string; photoIds?: string[] }): Promise<SteerAdmissionStatus>
  getSteerAdmission(submissionId: string): Promise<SteerAdmissionStatus>
  followUp(prompt: string): Promise<void>
  abort(): Promise<void>
  listFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<WorkspaceFileContent>
  listDiary(): Promise<string[]>
  readDiary(name: string): Promise<DiaryEntry | null>
  prompt(input: { operationId: string; prompt: string; photoIds?: string[] }): Promise<void>
  getPromptAdmission(operationId: string): Promise<PromptAdmissionStatus>
  uploadPhoto(input: PhotoUpload): Promise<ConversationPhoto>
  listConversationPhotos(input?: { cursor?: string; limit?: number }): Promise<ConversationPhotoPage>
}

export interface PiRegistryContract {
  readonly state: unknown
  reportUserTimeZone(timeZone: string): Promise<string>
  getUserTimeZone(): Promise<string>
  createSession(input?: { name?: string }): Promise<SessionSummary>
  listSessions(input?: SessionListInput): Promise<SessionSummary[]>
  searchSessions(input: SessionListInput): Promise<SessionSearchResult[]>
  renameSession(sessionId: string, name?: string): Promise<SessionSummary>
  deleteSession(sessionId: string): Promise<void>
  forkSession(input: { sourceSessionId: string; entryId: string; name?: string }): Promise<SessionSummary>
  cloneSession(input: { sourceSessionId: string; name?: string }): Promise<SessionSummary>
  getRelationshipSnapshot(input?: { limit?: number; before?: number }): Promise<RelationshipSnapshot>
  updateRelationship(input: RelationshipUpdate): Promise<RelationshipState>
}

export const PI_AGENT_NAME = 'PiSession'
export const PI_REGISTRY_NAME = 'PiRegistry'
export const PI_AGENT_PREFIX = 'api/agents'
export const PI_REGISTRY_INSTANCE = 'singleton'

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
  keet?: { kind: 'dm' | 'group'; destination: string; sender: string; text: string }
  wakeSource?: import('./timed-wake').WakeSource
  photos?: ConversationPhoto[]
}

export type SessionOverview = SessionSummary & {
  revision: number
  running: boolean
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
  archive?: { id: string; conversation: import('./history-import').HistoryConversation }
  session: SessionSummary
  matches: Array<{
    entryId: string
    sourceNodeId?: string
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
  setSessionName(name: string): Promise<SessionOverview>
  updateCompactionSettings(settings: CompactionSettings): Promise<CompactionSettings>
  listFiles(): Promise<WorkspaceFile[]>
  readWorkspaceFile(path: string): Promise<WorkspaceFileContent>
  listTimedWakes(): Promise<import('./timed-wake').TimedWake[]>
  listDiary(): Promise<string[]>
  readDiary(name: string): Promise<DiaryEntry | null>
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
  getRelationshipSnapshot(input?: { limit?: number; before?: number }): Promise<RelationshipSnapshot>
  updateRelationship(input: RelationshipUpdate): Promise<RelationshipState>
}

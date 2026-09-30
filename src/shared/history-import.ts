import { Type, type Static } from 'typebox'

export const HISTORY_LIMITS = {
  requestBytes: 1_000_000, nodeBytes: 256_000, batchNodes: 100,
  sessionBytes: 64_000_000, sessionNodes: 10_000, pendingSessions: 4,
  pendingBytes: 128_000_000, stagingTtlMs: 86_400_000,
  pageLimit: 20, diagnosticBytes: 4_096, diagnosticsPerMinute: 10,
} as const
const object = <T extends Parameters<typeof Type.Object>[0]>(fields: T) => Type.Object(fields, { additionalProperties: false })
const id = Type.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
const label = Type.String({ maxLength: 200 })
const nullableId = Type.Union([id, Type.Null()])
export const SourceTimeSchema = object({
  raw: Type.String({ minLength: 1, maxLength: 100 }),
  interpretation: Type.Union([Type.Literal('utc'), Type.Literal('offset'), Type.Literal('local-unknown')]),
  epochMs: Type.Optional(Type.Integer({ minimum: -8_640_000_000_000_000, maximum: 8_640_000_000_000_000 })),
})
const text = Type.String({ maxLength: HISTORY_LIMITS.nodeBytes })
export const HistoryPartSchema = Type.Union([
  object({ type: Type.Literal('text'), text }),
  object({ type: Type.Literal('thought'), text }),
  object({ type: Type.Literal('attachment'), name: label, reference: Type.String({ maxLength: 2_000 }), status: Type.Union([Type.Literal('not-restored'), Type.Literal('not-in-export')]) }),
  object({ type: Type.Literal('historical-tool'), name: label, text }),
])
export const HistoryNodeSchema = object({
  id, messageId: id, parentId: nullableId, alternativeGroupId: nullableId,
  sourceOrder: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }),
  selected: Type.Boolean(), speaker: label,
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('system'), Type.Literal('tool')]),
  time: SourceTimeSchema,
  parts: Type.Array(HistoryPartSchema, { minItems: 1, maxItems: 100 }),
})
export const HistoryConversationSchema = object({
  source: Type.Union([Type.Literal('rikka'), Type.Literal('deepseek')]),
  conversationId: id,
  assistant: Type.Optional(object({ id, name: label })),
  title: label, createdAt: SourceTimeSchema, updatedAt: SourceTimeSchema,
  selectedLeafId: nullableId,
})
export const HistoryStartSchema = object({ conversation: HistoryConversationSchema })
export const HistoryAppendSchema = object({
  batch: Type.Integer({ minimum: 0, maximum: 10_000 }),
  nodes: Type.Array(HistoryNodeSchema, { minItems: 1, maxItems: HISTORY_LIMITS.batchNodes }),
})
export const HistoryCommitSchema = object({ batches: Type.Integer({ minimum: 1, maximum: 10_001 }) })
// Structural field names only; dynamic mapping keys are represented by "*", never source IDs.
const diagnosticPosition = Type.Integer({ minimum: 0, maximum: 1_000_000_000 })
const diagnosticPath = Type.Array(Type.Union([
  Type.Union((['*', 'id', 'title', 'inserted_at', 'updated_at', 'mapping', 'parent', 'children', 'message', 'model', 'fragments', 'type', 'content', 'results', 'url', 'files', 'file_id', 'file_name', 'file_size', 'role', 'parts', 'annotations', 'createdAt', 'finishedAt', 'modelId', 'usage', 'translation'] as const).map(v => Type.Literal(v))),
  diagnosticPosition,
]), { minItems: 1, maxItems: 12 })
export const HistoryDiagnosticLocationSchema = Type.Union([
  object({ kind: Type.Literal('json'), path: diagnosticPath }),
  object({ kind: Type.Literal('db'), table: Type.Literal('message_node'), column: Type.Union((['id', 'conversation_id', 'node_index', 'messages', 'select_index'] as const).map(v => Type.Literal(v))), row: Type.Optional(diagnosticPosition), path: Type.Optional(diagnosticPath) }),
  object({ kind: Type.Literal('db'), table: Type.Literal('ConversationEntity'), column: Type.Union((['id', 'assistant_id', 'title', 'nodes', 'create_at', 'update_at'] as const).map(v => Type.Literal(v))), row: Type.Optional(diagnosticPosition), path: Type.Optional(diagnosticPath) }),
])
export type HistoryDiagnosticLocation = Static<typeof HistoryDiagnosticLocationSchema>
export const HistoryDiagnosticSchema = object({
  issueId: Type.Optional(Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' })),
  source: Type.Union([Type.Literal('rikka'), Type.Literal('deepseek')]),
  stage: Type.Union((['preflight', 'parse', 'normalize', 'upload', 'commit'] as const).map(v => Type.Literal(v))),
  code: Type.Union((['invalid-format', 'unsupported-part', 'resource-limit', 'role-missing', 'interrupted', 'invalid-data', 'conflict', 'role-mismatch', 'invalid-graph', 'batch-order', 'internal-error'] as const).map(v => Type.Literal(v))),
  filename: Type.Optional(Type.String({ maxLength: 120 })),
  member: Type.Optional(Type.Union([Type.Literal('conversations.json'), Type.Literal('rikka_hub.db'), Type.Literal('settings.json')])),
  location: Type.Optional(HistoryDiagnosticLocationSchema),
  originalBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
  expandedBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
  elapsedMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
  succeeded: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  failed: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  sourceId: Type.Optional(id),
})
export type SourceTime = Static<typeof SourceTimeSchema>
export type HistoryPart = Static<typeof HistoryPartSchema>
export type HistoryNode = Static<typeof HistoryNodeSchema>
export type HistoryConversation = Static<typeof HistoryConversationSchema>
export type HistoryStart = Static<typeof HistoryStartSchema>
export type HistoryAppend = Static<typeof HistoryAppendSchema>
export type HistoryCommit = Static<typeof HistoryCommitSchema>
export type HistoryDiagnostic = Static<typeof HistoryDiagnosticSchema>
export type ArchiveSummary = { id: string; conversation: HistoryConversation; messageCount: number }
export type ArchiveNode = HistoryNode & {
  // Pi-readable content, never a toolCall or a toolResult and never submitted to a harness.
  message: { role: string; content: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string }> }
}
export type HistoryImportStatus = { importId: string; archiveId: string; state: 'staging' | 'committed'; nextBatch: number; nodeCount: number; bytes: number; expiresAt: number; added?: number }
export type HistoryErrorCode = 'invalid-data' | 'resource-limit' | 'not-found' | 'role-mismatch' | 'conflict' | 'invalid-graph' | 'batch-order' | 'rate-limit' | 'internal-error' | 'forbidden' | 'method-not-allowed'
export type HistoryError = { error: { code: HistoryErrorCode; stage: string; issueId: string; sourceNodeId?: string } }
export type HistoryReply = { status: number; body: unknown }

export type HistoryImportSettings = { rikkaAssistantId: string | null }

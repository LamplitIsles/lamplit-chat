import { Type, type Static } from 'typebox'
import type { Memory } from './pi-contract'

export const MATERIAL_LIMITS = { fileBytes: 128_000, requestBytes: 800_000, basenameCharacters: 200, rootEntries: 200, memories: 64, memoryCharacters: 500 } as const
const version = Type.String({ minLength: 1, maxLength: 100 })
const content = Type.String({ maxLength: 128_000 })
export const FileCreateSchema = Type.Object({ content }, { additionalProperties: false })
export const FileUpdateSchema = Type.Object({ content, expectedVersion: version }, { additionalProperties: false })
export const ResetSchema = Type.Object({ expectedVersion: version }, { additionalProperties: false })
export const MemoryUpdateSchema = Type.Object({ content: Type.String({ minLength: 1, maxLength: 500 }), expectedUpdatedAt: version }, { additionalProperties: false })
export const MemoryDeleteSchema = Type.Object({ expectedUpdatedAt: version }, { additionalProperties: false })
export type FileCreate = Static<typeof FileCreateSchema>
export type FileUpdate = Static<typeof FileUpdateSchema>
export type MemoryUpdate = Static<typeof MemoryUpdateSchema>
export type MaterialFile = { name: string; content: string; version: string; bytes: number }
export type EffectiveCompaction = { mode: 'default' | 'custom'; content: string; version: string; bytes: number }
export type MaterialErrorCode = 'invalid-data' | 'resource-limit' | 'not-found' | 'conflict' | 'busy' | 'unconfigured' | 'forbidden' | 'method-not-allowed' | 'internal-error'
export type MaterialBody = MaterialFile | EffectiveCompaction | { files: Array<{ name: string; bytes: number }> } | { memories: Memory[] } | { memory: Memory } | { deleted: true } | { error: { code: MaterialErrorCode } }
export type MaterialReply = { status: number; body: MaterialBody }
export type MaterialAction = 'file-list' | 'file-read' | 'file-create' | 'file-update' | 'file-delete' | 'memory-list' | 'memory-update' | 'memory-delete' | 'compaction-read' | 'compaction-save' | 'compaction-reset'
export type MaterialRequest = { action: MaterialAction; id?: string; input?: unknown }

import type { ToolRegistration } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import type { Memory, MemoryKind } from '../shared/pi-contract'

type MemoryRegistry = {
  setMemory(input: {
    id?: string
    kind: MemoryKind
    content: string
    sourceSessionId?: string
  }): Promise<Memory>
  deleteMemory(id: string): Promise<void>
}

const parameters = Type.Object({
  action: Type.Union([Type.Literal('set'), Type.Literal('delete')]),
  id: Type.Optional(Type.String({ description: 'Required for delete; existing memory ID when correcting a memory' })),
  kind: Type.Optional(Type.Union([
    Type.Literal('preference'),
    Type.Literal('fact'),
    Type.Literal('instruction'),
    Type.Literal('decision'),
  ], { description: 'Required for set' })),
  content: Type.Optional(Type.String({ description: 'Required for set. One concise, durable fact. Never include secrets or conversation excerpts.' })),
})

export function createMemoryTool(registry: MemoryRegistry, sessionId: string): ToolRegistration<typeof parameters> {
  return {
    name: 'memory',
    description: 'Set, correct, or delete long-term memory only when the user directly asks to remember, save, correct, or forget something. Do not call this for ordinary statements of fact or preference.',
    parameters,
    executionMode: 'sequential',
    execute: async (input, _api, context) => {
      const signal = context.abortSignal
      signal?.throwIfAborted()
      if (input.action === 'delete') {
        if (!input.id) throw new Error('id is required for delete')
        await registry.deleteMemory(input.id)
        signal?.throwIfAborted()
        return result(`Deleted memory ${input.id}`)
      }
      if (!input.kind || !input.content?.trim()) throw new Error('kind and content are required for set')
      const memory = await registry.setMemory({
        id: input.id,
        kind: input.kind,
        content: input.content,
        sourceSessionId: sessionId,
      })
      signal?.throwIfAborted()
      return result(`Stored memory ${memory.id}`)
    },
  }
}

function result(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

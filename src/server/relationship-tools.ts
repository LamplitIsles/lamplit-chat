import type { ToolRegistration } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import type { RelationshipSnapshot, RelationshipState, RelationshipUpdate } from '../shared/pi-contract'

type RelationshipRegistry = {
  updateRelationship(input: RelationshipUpdate): Promise<RelationshipState>
  getRelationshipSnapshot(input?: { limit?: number; before?: number }): Promise<RelationshipSnapshot>
}

const mood = Type.Union(['neutral', 'serene', 'bright', 'playful', 'tender', 'pensive', 'tired', 'low'].map((value) => Type.Literal(value)) as [ReturnType<typeof Type.Literal>, ReturnType<typeof Type.Literal>])
const updateParameters = Type.Object({
  mood: Type.Optional(Type.Object({ value: mood, note: Type.Optional(Type.String()), reason: Type.String() })),
  affinity: Type.Optional(Type.Object({ delta: Type.Integer({ minimum: -10, maximum: 10 }), reason: Type.String() })),
  signature: Type.Optional(Type.Object({ value: Type.String(), reason: Type.String() })),
})
const readParameters = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) })

export function createRelationshipTools(registry: RelationshipRegistry): ToolRegistration[] {
  return [{
    name: 'update_relationship',
    description: 'Record a genuine change in your present mood, your sense of closeness, or your short profile signature. Give a concrete reason for each change. Closeness ranges from 0 to 100; each update may move it by -10 to 10. It is descriptive, not a score to maximize. Do not update it mechanically after every message.',
    parameters: updateParameters,
    executionMode: 'sequential',
    execute: async (input, _api, context) => {
      context.abortSignal?.throwIfAborted()
      const state = await registry.updateRelationship(input as RelationshipUpdate)
      context.abortSignal?.throwIfAborted()
      return result(JSON.stringify(state))
    },
  }, {
    name: 'read_relationship_history',
    description: 'Read recent changes in the shared relationship across sessions, including the reasons recorded at the time.',
    parameters: readParameters,
    executionMode: 'sequential',
    execute: async (input, _api, context) => {
      context.abortSignal?.throwIfAborted()
      const snapshot = await registry.getRelationshipSnapshot({ limit: (input as { limit?: number }).limit })
      context.abortSignal?.throwIfAborted()
      return result(JSON.stringify(snapshot))
    },
  }]
}

function result(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

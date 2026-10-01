import { Type } from 'typebox'
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core'
import type { WakeInput, TimedWake } from '../shared/timed-wake'
const plan = Type.Union([
  Type.Object({ type: Type.Literal('once'), at: Type.String() }),
  Type.Object({ type: Type.Literal('interval'), anchor: Type.String(), seconds: Type.Integer({ minimum: 60 }) }),
  Type.Object({ type: Type.Literal('daily'), time: Type.String(), timeZone: Type.String() }),
  Type.Object({ type: Type.Literal('weekly'), time: Type.String(), timeZone: Type.String(), weekday: Type.Integer({ minimum: 0, maximum: 6 }) }),
])
const fields = { title: Type.String({ minLength: 1, maxLength: 80 }), reminder: Type.String({ minLength: 1, maxLength: 8000 }), plan }
export function createWakeTools(session: {
  listTimedWakes(): Promise<TimedWake[]>; saveTimedWake(input: WakeInput, id?: string): Promise<TimedWake>; cancelTimedWake(id: string): Promise<boolean>
}, getTimeZone: () => Promise<string | undefined>): AgentHarnessTool<undefined>[] {
  return [{
    name: 'timed_wake', label: 'Manage timed wakes', executionMode: 'sequential',
    description: 'Manage your own reminders in this original chat: list, create, replace, or cancel by ID. List returns current UTC time and the reported browser IANA time zone (null if unavailable); ask for a specific zone if missing. once.at and interval.anchor require ISO times with explicit offsets. Daily/weekly use HH:mm and a saved IANA zone; Sunday=0. At most 32 active wakes. Humans read the drawer and request changes in chat. Due reminders wait after the current answer. Occurrences over 60 seconds late before public admission starts are skipped without catchup; an in-window submission may finish committing after that cutoff. A trigger is not proof of completed work. No extra system notifications; model calls use the existing model configuration.',
    parameters: Type.Object({
      action: Type.Union(['list', 'create', 'replace', 'cancel'].map(action => Type.Literal(action))),
      id: Type.Optional(Type.String({ minLength: 1 })),
      title: Type.Optional(fields.title), reminder: Type.Optional(fields.reminder), plan: Type.Optional(plan),
    }),
    execute: async (_id, parameters, _update, _toolContext, _invocation, context) => {
      context.abortSignal?.throwIfAborted()
      const input = parameters as WakeInput & { action: string; id?: string }
      if (!['list', 'create', 'replace', 'cancel'].includes(input.action)) throw new Error('Unknown timed_wake action.')
      if ((input.action === 'replace' || input.action === 'cancel') && (typeof input.id !== 'string' || !input.id.trim())) throw new Error('An arrangement ID is required.')
      const data = input.action === 'list' ? { now: new Date().toISOString(), timeZone: await getTimeZone() ?? null, wakes: await session.listTimedWakes() }
        : input.action === 'cancel' ? { cancelled: await session.cancelTimedWake(input.id!) }
        : await session.saveTimedWake(input, input.action === 'replace' ? input.id : undefined)
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: {} }
    },
  }]
}

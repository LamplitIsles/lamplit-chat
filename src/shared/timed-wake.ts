export type WakePlan =
  | { type: 'once'; at: string }
  | { type: 'interval'; anchor: string; seconds: number }
  | { type: 'daily'; time: string; timeZone: string }
  | { type: 'weekly'; time: string; timeZone: string; weekday: number }
export type TimedWake = { id: string; revision: string; title: string; reminder: string; plan: WakePlan; nextAt: string }
export type WakeSource = { wakeId: string; revision: string; scheduledAt: string; title: string; reminder: string }
export type WakeInput = { title: string; reminder: string; plan: WakePlan }
export const WAKE_CUSTOM_TYPE = 'timed-wake'
export const occurrenceKey = (source: WakeSource) => `${source.wakeId}:${source.revision}:${source.scheduledAt}`

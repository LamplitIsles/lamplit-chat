import { Cron } from 'croner'
import { validUserTimeZone } from './turn-time'
import type { WakeInput, WakePlan, TimedWake } from '../shared/timed-wake'

export function absoluteTime(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('An ISO time with an explicit offset is required.')
  // Date.parse normalizes impossible calendar days; reject them explicitly.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error('Invalid calendar date.')
  return Date.parse(value)
}
export function nextWake(plan: WakePlan, after: number): string {
  if (plan.type === 'once') return new Date(absoluteTime(plan.at)).toISOString()
  if (plan.type === 'interval') {
    const anchor = absoluteTime(plan.anchor)
    if (!Number.isSafeInteger(plan.seconds) || plan.seconds < 60) throw new Error('Interval must be an integer of at least 60 seconds.')
    const next = anchor + Math.max(0, Math.floor((after - anchor) / (plan.seconds * 1000)) + 1) * plan.seconds * 1000
    if (!Number.isFinite(next) || !Number.isFinite(new Date(next).getTime())) throw new Error('Interval is outside the supported date range.')
    return new Date(next).toISOString()
  }
  if (plan.type !== 'daily' && plan.type !== 'weekly') throw new Error('Unsupported wake type.')
  if (!validUserTimeZone(plan.timeZone)) throw new Error('A real IANA time zone is required; ask for one if browser time zone is unavailable.')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(plan.time)) throw new Error('Local time must be HH:mm.')
  if (plan.type === 'weekly' && (!Number.isInteger(plan.weekday) || plan.weekday < 0 || plan.weekday > 6)) throw new Error('Weekday must be 0 (Sunday) through 6.')
  const [hour, minute] = plan.time.split(':')
  const date = new Cron(`${minute} ${hour} * * ${plan.type === 'weekly' ? plan.weekday : '*'}`, { timezone: plan.timeZone }).nextRun(new Date(after))
  if (!date) throw new Error('No future occurrence.')
  return date.toISOString()
}
export function makeWake(input: WakeInput, now: number, id: string = crypto.randomUUID()): TimedWake {
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80) throw new Error('Title must contain 1–80 characters.')
  if (typeof input.reminder !== 'string' || !input.reminder.trim() || input.reminder.length > 8000) throw new Error('Reminder must contain 1–8,000 characters.')
  if (!input.plan || typeof input.plan !== 'object') throw new Error('A structured wake plan is required.')
  const nextAt = nextWake(input.plan, now)
  if (Date.parse(nextAt) <= now) throw new Error('One-time wake must be in the future.')
  return { id, revision: crypto.randomUUID(), title: input.title.trim(), reminder: input.reminder.trim(), plan: input.plan, nextAt }
}

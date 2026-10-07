import type { ToolRegistration } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { boundedRequest, isOperationAborted, isRequestTimeout, ResponseBodyLimitError, readResponseText } from './web-request'

export type FeedbackEnvironment = Pick<Env, 'HOSTED_MODE' | 'PLATFORM_ORIGIN' | 'CHAT_INTERNAL_SECRET'> & { PLATFORM?: Pick<Fetcher, 'fetch'> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fields = ['problem', 'circumstances', 'expected_improvement'] as const
const parameters = Type.Object({
  problem: Type.String({ minLength: 1, maxLength: 4000 }),
  circumstances: Type.Optional(Type.String({ maxLength: 4000 })),
  expected_improvement: Type.Optional(Type.String({ maxLength: 4000 })),
}, { additionalProperties: false })
export const PLATFORM_FEEDBACK_AUTHORIZATION = 'The Human has authorized submit_platform_feedback to autonomously send Lamplit product problems and improvement suggestions to the Lamplit platform. Only this tool has that standing authorization; all other sending, publishing and credential use still require explicit authorization. Exclude secrets and private conversation transcripts from feedback.'
function result(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} } }
function failure(code: string, message: string, outcome: 'not_sent' | 'rejected' | 'unconfirmed') { return result({ ok: false, code, outcome, message }) }
function validTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return false
  const normalized = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, fraction: string) => `.${fraction.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z')
  return new Date(time).toISOString() === normalized
}
const unconfirmed = 'Submission was not confirmed. It may have been saved; retry only with the same tool call identity to avoid duplicates.'

async function submissionKey(instanceId: string, sessionId: string, toolCallId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['lamplit-platform-feedback-v1', instanceId.toLowerCase(), sessionId.toLowerCase(), toolCallId]))))
  digest[6] = (digest[6] & 15) | 80
  digest[8] = (digest[8] & 63) | 128
  const hex = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createPlatformFeedbackTools(env: FeedbackEnvironment, instanceId: string | null, sessionId: string): ToolRegistration[] {
  if (env.HOSTED_MODE !== 'true' || !instanceId || !uuid.test(instanceId) || !uuid.test(sessionId)) return []
  return [{
    name: 'submit_platform_feedback', parameters,
    description: 'Autonomously submit a Lamplit product problem or improvement suggestion to the platform for the Human to view in the management app’s My feedback. Provide a problem, optional circumstances and expected improvement. Never include secrets or private conversation transcripts. This authorization applies only to this feedback tool.',
    replay: 'safe',
    execute: async (input, api, context) => {
      const toolCallId = api.callId
      if (typeof toolCallId !== 'string' || !toolCallId.trim()) return failure('missing_call_id', 'A trusted tool call ID is required.', 'not_sent')
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key as typeof fields[number]))) return failure('invalid_input', 'Only the three feedback description fields are allowed.', 'not_sent')
      const descriptions = { problem: '', circumstances: '', expected_improvement: '' }
      for (const field of fields) {
        const value = input[field] === undefined && field !== 'problem' ? '' : input[field]
        if (typeof value !== 'string' || Array.from(value).length > 4000) return failure('invalid_input', 'Each description must be text of at most 4000 Unicode characters.', 'not_sent')
        descriptions[field] = value.trim()
      }
      if (!descriptions.problem) return failure('invalid_input', 'A nonblank problem or suggestion is required.', 'not_sent')
      if (!env.PLATFORM || !env.CHAT_INTERNAL_SECRET?.trim()) return failure('service_unavailable', 'Hosted platform feedback is not configured.', 'not_sent')
      let sent = false
      try {
        const body = JSON.stringify({ ...descriptions, submission_key: await submissionKey(instanceId, sessionId, toolCallId) })
        if (new TextEncoder().encode(body).byteLength > 65536) return failure('invalid_input', 'Feedback JSON must not exceed 64KiB.', 'not_sent')
        return await boundedRequest(async (url, init) => {
          sent = true
          return env.PLATFORM!.fetch(url, init)
        }, `${env.PLATFORM_ORIGIN ?? 'https://app.lamplit.run'}/internal/chat-feedback/${instanceId}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-lamplit-internal-secret': env.CHAT_INTERNAL_SECRET },
          body, redirect: 'manual', credentials: 'omit',
        }, { callerSignal: context.abortSignal, timeoutMs: 10000, timeoutMessage: 'Platform feedback timed out' }, async (response, signal) => {
          if (response.status !== 200 && response.status !== 201) {
            await response.body?.cancel()
            if (response.status === 401 || response.status === 403) return failure('forbidden', 'Platform rejected feedback authorization.', 'rejected')
            if (response.status === 404) return failure('instance_not_found', 'Platform could not find this hosted instance.', 'rejected')
            if (response.status === 400 || response.status === 413) return failure('invalid_input', 'Platform rejected the feedback payload.', 'rejected')
            if (response.status === 409) return failure('submission_conflict', 'This tool call identity already submitted different feedback. Use a new call for changed content.', 'rejected')
            return failure('upstream_error', unconfirmed, 'unconfirmed')
          }
          const data = JSON.parse(await readResponseText(response, 65536, signal))
          const feedback = data?.feedback
          if (!feedback || typeof feedback.id !== 'string' || !uuid.test(feedback.id) || feedback.source !== 'machine' || !['received', 'processing', 'completed'].includes(feedback.status) || !validTime(feedback.created_at)) return failure('invalid_response', unconfirmed, 'unconfirmed')
          return result({ ok: true, id: feedback.id, source: feedback.source, status: feedback.status, created_at: feedback.created_at, message: 'Feedback received. The Human can view it in the management app’s My feedback.' })
        })
      } catch (error) {
        const code = isOperationAborted(error) ? 'cancelled' : isRequestTimeout(error) ? 'timeout' : (error instanceof SyntaxError || error instanceof ResponseBodyLimitError) ? 'invalid_response' : 'upstream_error'
        return failure(code, sent ? unconfirmed : 'Feedback was not sent.', sent ? 'unconfirmed' : 'not_sent')
      }
    },
  } satisfies ToolRegistration<typeof parameters>]
}

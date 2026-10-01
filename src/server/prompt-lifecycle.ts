import { WAKE_CUSTOM_TYPE } from '../shared/timed-wake'
import type { AgentLane } from '@earendil-works/pi-agent-core'
import type { Context } from '@earendil-works/pi-agent-core/harness/context'
import type { Entry, OperationMeta } from '@earendil-works/pi-agent-core/harness/session'
import type { PromptAdmissionStatus } from '../shared/pi-contract'
import type { PromptSubmissionRecord } from './pi-session-storage'

export async function exactPromptEntryId(
  operationId: string,
  readMeta: (operationId: string) => Promise<OperationMeta | undefined>,
  readEntry: (entryId: string) => Entry | undefined,
): Promise<string> {
  const meta = await readMeta(operationId)
  if (meta?.operationId !== operationId || meta.intent.kind !== 'run' || meta.intent.promptEntryIds.length !== 1) {
    throw new Error('Pi did not record exactly one prompt entry for this operation.')
  }
  const entryId = meta.intent.promptEntryIds[0]
  const entry = readEntry(entryId)
  if (entry?.type !== 'message' || entry.message.role !== 'user') {
    throw new Error('Pi prompt entry is not a durable user message.')
  }
  return entryId
}

export async function getPromptAdmission(
  lane: AgentLane,
  operationId: string,
  context: Context,
  getSubmission: (operationId: string) => PromptSubmissionRecord | undefined,
  readMeta: (operationId: string) => Promise<OperationMeta | undefined>,
  readEntry: (entryId: string) => Entry | undefined,
  acceptSubmission: (operationId: string, entryId: string) => PromptSubmissionRecord,
  admissionInProgress: boolean,
): Promise<PromptAdmissionStatus> {
  let submission = getSubmission(operationId)
  if (!submission || submission.state === 'submitting') {
    if (submission) {
      const meta = await readMeta(operationId)
      if (meta) {
        const entryId = await exactPromptEntryId(operationId, async () => meta, readEntry)
        submission = acceptSubmission(operationId, entryId)
      }
    }
    if (!submission || submission.state === 'submitting') {
      if (await lane.getResult(operationId, context)) {
        throw new Error('Terminal Pi result exists without accepted submission correlation.')
      }
      return admissionInProgress ? { state: 'uncertain', operationId } : { state: 'missing', operationId }
    }
  }

  const result = await lane.getResult(operationId, context)
  if (result) {
    if (result.kind !== 'run') throw new Error('Prompt submission has a non-run Pi result.')
    return { state: 'settled', operationId, entryId: submission.entryId!, status: result.status }
  }
  const execution = await lane.inspectExecution(context)
  return { state: 'accepted', operationId, entryId: submission.entryId!, running: execution.current?.id === operationId }
}

export async function prepareOpenOperationResume(
  lane: AgentLane,
  context: Context,
  getSubmission: (operationId: string) => PromptSubmissionRecord | undefined,
  readMeta: (operationId: string) => Promise<OperationMeta | undefined>,
  readEntry: (entryId: string) => Entry | undefined,
  acceptSubmission: (operationId: string, entryId: string) => PromptSubmissionRecord,
): Promise<{ operationId: string; browserPrompt: boolean } | undefined> {
  const current = (await lane.inspectExecution(context)).current
  if (!current) return undefined
  const meta = await readMeta(current.id)
  if (meta?.operationId !== current.id || meta.intent.kind !== current.kind) {
    throw new Error(`Open Pi operation ${current.id} is missing matching metadata.`)
  }
  const autonomous = meta.intent.kind === 'run' && meta.intent.promptEntryIds.every(id => {
    const entry = readEntry(id)
    return entry?.type === 'message' && entry.message.role === 'custom' && entry.message.customType === WAKE_CUSTOM_TYPE
  })
  const browserPrompt = meta.intent.kind === 'run' && meta.intent.promptEntryIds.length > 0 && !autonomous
  if (browserPrompt) {
    const submission = getSubmission(current.id)
    if (!submission) throw new Error(`Open browser prompt ${current.id} has no host submission ledger.`)
    const entryId = await exactPromptEntryId(current.id, async () => meta, readEntry)
    if (submission.state === 'accepted') {
      if (submission.entryId !== entryId) throw new Error(`Open browser prompt ${current.id} has conflicting entry identity.`)
    } else {
      acceptSubmission(current.id, entryId)
    }
  }
  if (await lane.getResult(current.id, context)) return undefined
  return { operationId: current.id, browserPrompt }
}

export async function admitAndDrivePrompt(
  lane: AgentLane,
  input: { operationId: string; prompt: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> },
  context: Context,
  correlate: () => Promise<string>,
  accepted: (entryId: string) => void,
): Promise<void> {
  const admission = await lane.accept({ kind: 'prompt', ...input }, context)
  if (!admission.ok) throw admission.error

  const entryId = await correlate()
  try { accepted(entryId) } catch { /* The browser may have disconnected after durable admission. */ }

  const driven = await lane.drive({ operationId: admission.value.operationId, waitForRetry: true }, context)
  if (!driven.ok) throw driven.error
  if (driven.value.kind === 'settled' && driven.value.outcome.status === 'failed') {
    throw new Error(driven.value.outcome.error?.message ?? 'Pi run failed.')
  }
  if (driven.value.kind === 'waiting' && driven.value.reason !== 'deferred') {
    throw new Error('Pi run did not settle.')
  }
}

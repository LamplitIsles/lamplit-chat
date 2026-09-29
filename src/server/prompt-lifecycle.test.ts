import { describe, expect, it, vi } from 'vitest'
import type { AgentLane } from '@earendil-works/pi-agent-core'
import type { Context } from '@earendil-works/pi-agent-core/harness/context'
import type { Entry, OperationMeta, OperationResultRecord } from '@earendil-works/pi-agent-core/harness/session'
import { admitAndDrivePrompt, exactPromptEntryId, getPromptAdmission, prepareOpenOperationResume } from './prompt-lifecycle'
import type { PromptSubmissionRecord } from './pi-session-storage'

const context = {} as Context
const operationId = 'browser-operation'
const user = { id: 'current-user', type: 'message', message: { role: 'user', content: 'hello' } } as Entry
const meta = { operationId, intent: { kind: 'run', promptEntryIds: [user.id] } } as OperationMeta
const result = {
  operationId, kind: 'run', status: 'completed', fromTipId: null,
  tipId: 'reply', startedAt: 1, endedAt: 2,
} as OperationResultRecord

describe('durable prompt admission', () => {
  it('correlates the exact user entry before acknowledging and driving', async () => {
    const order: string[] = []
    const lane = {
      accept: vi.fn(async (request: { operationId: string; prompt: string }) => {
        expect(request).toMatchObject({ kind: 'prompt', operationId, prompt: 'hello' })
        order.push('accept')
        return { ok: true, value: { operationId, kind: 'run' } }
      }),
      drive: vi.fn(async () => {
        order.push('drive')
        return { ok: true, value: { kind: 'settled', outcome: { status: 'completed' } } }
      }),
    } as unknown as AgentLane
    await admitAndDrivePrompt(lane, { operationId, prompt: 'hello' }, context,
      async () => { order.push('correlate'); return user.id },
      (entryId) => { expect(entryId).toBe(user.id); order.push('ack') })
    expect(order).toEqual(['accept', 'correlate', 'ack', 'drive'])
  })

  it('does not correlate or drive a rejected admission', async () => {
    const error = new Error('lane busy')
    const correlate = vi.fn()
    const notify = vi.fn()
    const drive = vi.fn()
    const lane = { accept: vi.fn(async () => ({ ok: false, error })), drive } as unknown as AgentLane
    await expect(admitAndDrivePrompt(lane, { operationId, prompt: 'hello' }, context, correlate, notify)).rejects.toBe(error)
    expect(correlate).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(drive).not.toHaveBeenCalled()
  })

  it('drives once after a lost acknowledgement, but never after failed correlation', async () => {
    const drive = vi.fn(async () => ({ ok: true, value: { kind: 'settled', outcome: { status: 'completed' } } }))
    const lane = { accept: vi.fn(async () => ({ ok: true, value: { operationId, kind: 'run' } })), drive } as unknown as AgentLane
    await expect(admitAndDrivePrompt(lane, { operationId, prompt: 'hello' }, context,
      async () => user.id, () => { throw new Error('stream disconnected') })).resolves.toBeUndefined()
    expect(drive).toHaveBeenCalledTimes(1)
    await expect(admitAndDrivePrompt(lane, { operationId, prompt: 'hello' }, context,
      async () => { throw new Error('correlation failed') }, vi.fn())).rejects.toThrow('correlation failed')
    expect(drive).toHaveBeenCalledTimes(1)
  })

  it('uses only Pi prompt metadata and validates the user entry', async () => {
    expect(await exactPromptEntryId(operationId, async () => meta, (id) => id === user.id ? user : undefined)).toBe(user.id)
    await expect(exactPromptEntryId(operationId,
      async () => ({ ...meta, intent: { kind: 'run', promptEntryIds: [] } }),
      () => user)).rejects.toThrow('exactly one')
    await expect(exactPromptEntryId(operationId, async () => meta,
      () => ({ id: user.id, type: 'message', message: { role: 'assistant' } } as Entry))).rejects.toThrow('user message')
  })
})

describe('prompt submission recovery', () => {
  function setup(state: 'submitting' | 'accepted') {
    let submission: PromptSubmissionRecord = {
      operationId, fingerprint: 'hash', state, ...(state === 'accepted' ? { entryId: user.id } : {}),
      createdAt: '2026-09-28T00:00:00.000Z',
    }
    const getSubmission = () => submission
    const acceptSubmission = vi.fn((_id: string, entryId: string) => {
      submission = { ...submission, state: 'accepted', entryId }
      return submission
    })
    return { getSubmission, acceptSubmission }
  }

  it('repairs a submitting row from exact active Pi metadata', async () => {
    const ledger = setup('submitting')
    const lane = {
      getResult: vi.fn(async () => undefined),
      inspectExecution: vi.fn(async () => ({ current: { id: operationId } })),
    } as unknown as AgentLane
    await expect(getPromptAdmission(lane, operationId, context, ledger.getSubmission,
      async () => meta, () => user, ledger.acceptSubmission, false))
      .resolves.toMatchObject({ state: 'accepted', entryId: user.id })
    expect(ledger.getSubmission()).toMatchObject({ state: 'accepted', entryId: user.id })
  })

  it('returns missing for unaccepted submission and rejects a terminal result without host correlation', async () => {
    const ledger = setup('submitting')
    const getResult = vi.fn(async (): Promise<OperationResultRecord | undefined> => undefined)
    const lane = { getResult } as unknown as AgentLane
    await expect(getPromptAdmission(lane, operationId, context, ledger.getSubmission,
      async () => undefined, () => user, ledger.acceptSubmission, false))
      .resolves.toMatchObject({ state: 'missing' })
    getResult.mockResolvedValueOnce(result)
    await expect(getPromptAdmission(lane, operationId, context, ledger.getSubmission,
      async () => undefined, () => user, ledger.acceptSubmission, false))
      .rejects.toThrow('without accepted submission correlation')
  })

  it('returns the mapped entry ID for a settled operation without branch inference', async () => {
    const ledger = setup('accepted')
    const lane = { getResult: vi.fn(async () => result) } as unknown as AgentLane
    await expect(getPromptAdmission(lane, operationId, context, ledger.getSubmission,
      async () => undefined, () => undefined, ledger.acceptSubmission, false))
      .resolves.toMatchObject({ state: 'settled', entryId: user.id, status: 'completed' })
  })

  it('reports a repaired terminal operation as settled and an idle accepted operation as not running', async () => {
    const repairing = setup('submitting')
    const terminalLane = { getResult: vi.fn(async () => result) } as unknown as AgentLane
    await expect(getPromptAdmission(terminalLane, operationId, context, repairing.getSubmission,
      async () => meta, () => user, repairing.acceptSubmission, false))
      .resolves.toMatchObject({ state: 'settled', entryId: user.id, status: 'completed' })

    const accepted = setup('accepted')
    const idleLane = {
      getResult: vi.fn(async () => undefined),
      inspectExecution: vi.fn(async () => ({ current: null })),
    } as unknown as AgentLane
    await expect(getPromptAdmission(idleLane, operationId, context, accepted.getSubmission,
      async () => undefined, () => undefined, accepted.acceptSubmission, false))
      .resolves.toEqual({ state: 'accepted', operationId, entryId: user.id, running: false })
  })

  it('repairs the host ledger before allowing an open Pi operation to resume', async () => {
    const ledger = setup('submitting')
    const order: string[] = []
    const resume = vi.fn(async () => { order.push('resume'); return { ok: true } })
    const lane = {
      inspectExecution: vi.fn(async () => ({ current: { id: operationId, kind: 'run' } })),
      getResult: vi.fn(async () => { order.push('result'); return undefined }),
      resume,
    } as unknown as AgentLane
    const acceptSubmission = (id: string, entryId: string) => {
      order.push('repair')
      return ledger.acceptSubmission(id, entryId)
    }
    const prepared = await prepareOpenOperationResume(lane, context, ledger.getSubmission,
      async () => meta, () => user, acceptSubmission)
    expect(prepared).toEqual({ operationId, browserPrompt: true })
    expect(order).toEqual(['repair', 'result'])
    expect(ledger.getSubmission()).toMatchObject({ state: 'accepted', entryId: user.id })
    expect(resume).not.toHaveBeenCalled()
  })

  it('does not resume terminal or absent operations and rejects an open browser prompt without a ledger', async () => {
    const ledger = setup('accepted')
    const lane = {
      inspectExecution: vi.fn(async () => ({ current: { id: operationId, kind: 'run' } })),
      getResult: vi.fn(async () => result),
    } as unknown as AgentLane
    await expect(prepareOpenOperationResume(lane, context, ledger.getSubmission,
      async () => meta, () => user, ledger.acceptSubmission)).resolves.toBeUndefined()
    await expect(prepareOpenOperationResume(lane, context, () => undefined,
      async () => meta, () => user, ledger.acceptSubmission)).rejects.toThrow('no host submission ledger')
    const idleLane = { inspectExecution: vi.fn(async () => ({ current: null })) } as unknown as AgentLane
    await expect(prepareOpenOperationResume(idleLane, context, () => undefined,
      async () => undefined, () => undefined, ledger.acceptSubmission)).resolves.toBeUndefined()
  })

  it('allows an open structural Pi operation without a browser submission ledger', async () => {
    const lane = {
      inspectExecution: vi.fn(async () => ({ current: { id: operationId, kind: 'compaction' } })),
      getResult: vi.fn(async () => undefined),
    } as unknown as AgentLane
    await expect(prepareOpenOperationResume(lane, context, () => undefined,
      async () => ({ ...meta, intent: { kind: 'compaction' } }), () => undefined, vi.fn()))
      .resolves.toEqual({ operationId, browserPrompt: false })
  })
})

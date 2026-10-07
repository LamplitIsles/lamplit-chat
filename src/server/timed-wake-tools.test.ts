import { expect, it, vi } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createWakeTools } from './timed-wake-tools'
import type { WakeInput } from '../shared/timed-wake'

it('provides provider-compatible structured CRUD and reports absent browser timezone without guessing', async () => {
  const session = { listTimedWakes: vi.fn(async () => []), saveTimedWake: vi.fn(), cancelTimedWake: vi.fn(async () => true) }
  const [tool] = createWakeTools(session, async () => undefined)
  // Root object is a real provider tool-schema contract, not a prompt/source check.
  expect(tool.parameters).toMatchObject({ type: 'object' })
  const execute = (input: unknown) => tool.execute(input, { callId: 'fixture-call' } as never, BACKGROUND_CONTEXT)
  const listed = await execute({ action: 'list' })
  expect(listed.content).toEqual([expect.objectContaining({ text: expect.stringContaining('"timeZone":null') })])
  await expect(execute({ action: 'replace', title: 'Must not create' })).rejects.toThrow('ID')
  await expect(execute({ action: 'cancel' })).rejects.toThrow('ID')
  await expect(execute({ action: 'pause', id: 'a' })).rejects.toThrow('Unknown')
  expect(session.saveTimedWake).not.toHaveBeenCalled()
  const input: WakeInput = { title: 'Tea', reminder: 'Synthetic', plan: { type: 'once', at: '2026-10-02T01:00:00Z' } }
  await execute({ action: 'create', ...input })
  expect(session.saveTimedWake).toHaveBeenLastCalledWith(expect.objectContaining(input), undefined)
  await execute({ action: 'replace', id: 'a', ...input })
  expect(session.saveTimedWake).toHaveBeenLastCalledWith(expect.objectContaining(input), 'a')
  await execute({ action: 'cancel', id: 'a' })
  expect(session.cancelTimedWake).toHaveBeenLastCalledWith('a')
})

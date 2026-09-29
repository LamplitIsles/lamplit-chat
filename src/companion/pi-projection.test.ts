import { describe, expect, it } from 'vitest'
import { acceptOptimisticPrompt, activityForPiEvent, beginOptimisticPrompt, branchItems, canStartSubmission, companionProjection, hasDurablePrompt, isCompactCommand, projectPromptBranch, visibleBranchEntries } from '../../frontend/src/lib/companion/pi-projection'
import type { StoredSessionEntry } from '../shared/pi-contract'

function entry(id: string, role: string, content: unknown): StoredSessionEntry {
  return { seq: 1, id, parentId: null, type: 'message', timestamp: '2026-09-27T00:00:00.000Z', message: { role, content } }
}

describe('Pi to Companion projection', () => {
  it('blocks another send throughout photo preparation and treats compact with photos as a message', () => {
    expect(canStartSubmission(undefined, true)).toBe(false)
    expect(companionProjection([], false, true, '', !canStartSubmission(undefined, true)).canSubmit).toBe(false)
    expect(canStartSubmission(undefined, false)).toBe(true)
    expect(isCompactCommand('/compact', 0)).toBe(true)
    expect(isCompactCommand('/compact', 1)).toBe(false)
    expect(isCompactCommand('/compact', 2)).toBe(false)
  })
  it('groups ordered durable photos with their caption and uses private previews', () => {
    const message = { ...entry('user-photo', 'user', [{ type: 'text', text: 'Look' }, { type: 'image', data: 'private-model-copy', mimeType: 'image/jpeg' }]), photos: [
      { id: 'first', operationId: 'operation', name: 'first.jpg', mediaType: 'image/jpeg', created: 1, order: 0, entryId: 'user-photo' },
      { id: 'second', operationId: 'operation', name: 'second.jpg', mediaType: 'image/jpeg', created: 2, order: 1, entryId: 'user-photo' },
    ] }
    const projection = companionProjection(branchItems([message], 'session-id'), false, true)
    expect(projection.messageUnits).toHaveLength(1)
    expect(projection.messageUnits[0].items.map((item) => item.id)).toEqual(['first', 'second', 'user-photo'])
    expect(projection.messageUnits[0].items[0]).toMatchObject({ previewUrl: '/api/conversation-images/session-id/first/preview' })
    expect(JSON.stringify(projection)).not.toContain('private-model-copy')
  })
  it('shows durable dialogue and compaction without exposing reasoning or tool arguments', () => {
    const items = branchItems([
      entry('user', 'user', [{ type: 'text', text: '早安' }]),
      entry('assistant', 'assistant', [
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'toolCall', name: 'read', arguments: { secret: 'private payload' } },
      ]),
      entry('answer', 'assistant', [{ type: 'text', text: '早安，Neil。' }]),
      { seq: 4, id: 'compact', parentId: 'answer', type: 'compaction', timestamp: '2026-09-27T00:01:00.000Z', summary: 'private summary' },
    ])
    expect(items.map((item) => item.kind)).toEqual(['text', 'text', 'continuity'])
    expect(JSON.stringify(items)).not.toMatch(/private reasoning|private payload|private summary/)
    expect(companionProjection(items, false, true).messageUnits).toHaveLength(3)
  })

  it('keeps tool-only and reasoning-only assistant entries out of the transcript', () => {
    expect(branchItems([entry('tool', 'assistant', [{ type: 'toolCall', name: 'read', arguments: { path: '/secret' } }])]))
      .toEqual([])
    expect(branchItems([entry('thinking', 'assistant', [{ type: 'thinking', thinking: 'private reasoning' }])])).toEqual([])
    expect(branchItems([entry('tool-preamble', 'assistant', [
      { type: 'text', text: 'Let me inspect that.' },
      { type: 'toolCall', name: 'read', arguments: { path: '/secret' } },
    ])])).toEqual([])
  })

  it('hides in-flight assistant entries until the durable turn settles', () => {
    const entries = [
      entry('previous-user', 'user', 'Earlier'),
      entry('previous-assistant', 'assistant', 'Earlier reply'),
      entry('current-user', 'user', 'Current'),
      entry('partial', 'assistant', [{ type: 'text', text: 'Growing token stream' }]),
    ]
    const running = branchItems(visibleBranchEntries(entries, true))
    expect(running.map((item) => item.id)).toEqual(['previous-user', 'previous-assistant', 'current-user'])
    expect(branchItems(visibleBranchEntries(entries, false)).map((item) => item.id)).toEqual(['previous-user', 'previous-assistant', 'current-user', 'partial'])
  })

  it('keeps the previous reply visible while a new prompt has no durable user entry', () => {
    const entries = [
      { ...entry('a-user', 'user', 'A'), seq: 1 },
      { ...entry('a-reply', 'assistant', 'a'), seq: 2 },
      { ...entry('b-user', 'user', 'B'), seq: 3 },
      { ...entry('b-reply', 'assistant', 'b'), seq: 4 },
    ]
    const sending = beginOptimisticPrompt('op-c', 'C')
    const visible = visibleBranchEntries(entries, true, sending)
    expect([...projectPromptBranch(visible, sending, 4), sending.item].map((item) => item.id))
      .toEqual(['a-user', 'a-reply', 'b-user', 'b-reply', 'op-c'])
    const accepted = acceptOptimisticPrompt(sending, { type: 'accepted', operationId: 'op-c', entryId: 'c-user' })!
    expect(visibleBranchEntries(entries, true, accepted)).toEqual(entries)
    const admitted = [
      ...entries,
      { ...entry('c-user', 'user', 'C'), seq: 5 },
      { ...entry('c-partial', 'assistant', 'unfinished'), seq: 6 },
    ]
    expect(branchItems(visibleBranchEntries(admitted, true, accepted)).map((item) => item.id))
      .toEqual(['a-user', 'a-reply', 'b-user', 'b-reply', 'c-user'])
  })

  it('reduces Pi telemetry to semantic activity without leaking tool names', () => {
    expect(activityForPiEvent('thinking', { type: 'text_delta', delta: 'private draft' })).toBe('thinking')
    expect(activityForPiEvent('thinking', { type: 'tool_execution_start', callId: '1', name: 'read', args: { path: '/secret' } })).toBe('reading')
    expect(activityForPiEvent('thinking', { type: 'tool_execution_start', callId: '2', name: 'session_search', args: {} })).toBe('searching')
    expect(activityForPiEvent('thinking', { type: 'tool_execution_start', callId: '3', name: 'update_relationship', args: {} })).toBe('remembering')
    expect(activityForPiEvent('thinking', { type: 'tool_execution_start', callId: '4', name: 'image_generate', args: {} })).toBe('creating')
    expect(activityForPiEvent('thinking', { type: 'tool_execution_start', callId: '5', name: 'private_opaque_tool', args: {} })).toBe('working')
    expect(activityForPiEvent('working', { type: 'tool_execution_update', callId: '5', name: 'private_opaque_tool', result: 'secret' })).toBe('working')
    expect(activityForPiEvent('working', { type: 'tool_execution_end', callId: '5', name: 'private_opaque_tool', isError: false })).toBe('thinking')
  })

  it('shows a normal outgoing bubble before and after acceptance, then reconciles by canonical entry ID', () => {
    const previous = { ...entry('old-user', 'user', '好'), seq: 1 }
    const current = { ...entry('new-user', 'user', '好'), seq: 3 }
    const sending = beginOptimisticPrompt('op-new', '好')
    const beforeAdmission = companionProjection([...projectPromptBranch([previous, current], sending, 1), sending.item], true, true)
    expect(beforeAdmission.messageUnits.map((unit) => unit.id)).toEqual(['old-user', 'op-new'])
    expect(beforeAdmission.messageUnits[1].pending).toBeFalsy()
    expect(beforeAdmission.messageUnits[1].pendingLabel).toBeUndefined()
    expect(beforeAdmission.running).toBe(true)
    expect(hasDurablePrompt([previous, current], sending)).toBe(false)

    const accepted = acceptOptimisticPrompt(sending, { type: 'accepted', operationId: 'op-new', entryId: 'new-user' })!
    expect(accepted.item).toMatchObject({ id: 'new-user' })
    expect(companionProjection([accepted.item], true, true).messageUnits[0].pending).toBeFalsy()
    expect(hasDurablePrompt([previous], accepted)).toBe(false)
    expect(hasDurablePrompt([previous, current], accepted)).toBe(true)
    expect(projectPromptBranch([previous, current], undefined, 1).map((item) => item.id)).toEqual(['old-user', 'new-user'])
    expect(acceptOptimisticPrompt(accepted, { type: 'accepted', operationId: 'another-op', entryId: 'wrong-user' })).toBe(accepted)
  })

  it('blocks a second send while submission identity is unresolved without marking Pi as running', () => {
    const projection = companionProjection([], false, true, '', true)
    expect(projection.running).toBe(false)
    expect(projection.canSubmit).toBe(false)
    expect(projection.status).toBe('ready')
  })


})

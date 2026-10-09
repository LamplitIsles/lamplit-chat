import { expect, it } from 'vitest'
import { createPiChatBackend, type PiChatSource } from './chat-adapter'
import type { StoredSessionEntry } from '../shared/pi-contract'

const entry = (id: string, role: string, content: unknown, stopReason = 'stop'): StoredSessionEntry => ({ id, seq: 1, parentId: null, type: 'message', timestamp: '2026-10-09T00:00:00Z', message: { role, content, ...{ stopReason } } })
function backend(entries: StoredSessionEntry[]) {
  const source = {
    branch: async () => ({ leafId: null, revision: 1, entries }), records: async () => new Map(),
    images: async () => [], pendingMessages: async () => [], outcomes: async () => [], recovery: async () => [],
    identity: async () => ({ id: 'fixture', name: 'fixture', turnId: null }),
    observation: async () => ({ sessionId: 'fixture', name: 'fixture', activeTurnId: null, contextUsage: { tokens: 0, capacity: 0 }, compaction: null }),
    imageLimits: () => false, search: {}, panels: {},
  } as unknown as PiChatSource
  return createPiChatBackend(source)
}
it('projects only assistant thinking strings in block order, independent of text, without modifying source blocks', async () => {
  const blocks = [ { type: 'thinking', thinking: 'first', thinkingSignature: 'private-signature' }, { type: 'text', text: 'answer one' }, { type: 'thinking', thinking: 'second' }, { type: 'thinking', thinking: 42 }, { type: 'toolCall', arguments: { private: 'tool-secret' } }, { type: 'text', text: 'answer two' } ]
  const original = structuredClone(blocks)
  const assistant = { ...entry('a', 'assistant', blocks), authoredAt: 1700000000000 }
  const view = await backend([assistant, entry('u', 'user', blocks), entry('t', 'toolResult', blocks), entry('plain', 'assistant', 'ordinary planning prose'), entry('empty', 'assistant', [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'empty thinking' }])]).read()
  expect(view.messages[0]).toMatchObject({ id: 'a', role: 'agent', thinking: 'first\nsecond', text: 'answer one\nanswer two', createdAt: assistant.authoredAt })
  expect(view.messages[1]).not.toHaveProperty('thinking')
  expect(view.messages[1]!.createdAt).toBe(Date.parse('2026-10-09T00:00:00Z'))
  expect(view.messages.find(m => m.id === 't')).toBeUndefined()
  expect(view.messages.find(m => m.id === 'plain')).not.toHaveProperty('thinking')
  expect(view.messages.find(m => m.id === 'empty')).not.toHaveProperty('thinking')
  expect(JSON.stringify(view)).not.toMatch(/private-signature|tool-secret/)
  expect(blocks).toEqual(original)
  expect((await backend([assistant, entry('cursor', 'user', 'later')]).history('cursor')).messages[0]).toEqual(view.messages[0])
})
it('retains thinking-only failure, tool-call-only omission, failure and stop notices', async () => {
  const thought = { type: 'thinking', thinking: 'actual thought' }
  const view = await backend([entry('only', 'assistant', [thought]), entry('tool', 'assistant', [thought, { type: 'toolCall', arguments: {} }], 'toolUse'), entry('error', 'assistant', [thought, { type: 'text', text: 'partial' }], 'error'), entry('stop', 'assistant', [thought], 'aborted')]).read()
  expect(view.messages.map(m => [m.id, m.role, m.text])).toEqual([['only', 'notice', '回复失败'], ['error', 'notice', '回复失败'], ['stop', 'notice', '已停止回复']])
  for (const message of view.messages) expect(message).not.toHaveProperty('thinking')
})
it('preserves Matrix original body/source/time alongside ordered assistant thinking through read and history', async () => {
  const matrix = { senderId: '@sender:fixture', senderDisplayName: '', roomId: '!room:fixture', text: '[Matrix: authored literal]\noriginal body' }
  const incoming = { ...entry('matrix', 'user', 'private model attribution'), matrix, authoredAt: 1700000000000 }
  const answer = { ...entry('answer', 'assistant', [{ type: 'thinking', thinking: 'first' }, { type: 'text', text: 'reply' }, { type: 'thinking', thinking: 'second' }]), authoredAt: 1700000001000 }
  const chat = backend([incoming, answer, entry('cursor', 'user', 'later')])
  const view = await chat.read()
  expect(view.messages[0]).toMatchObject({ id: 'matrix', text: matrix.text, createdAt: incoming.authoredAt, source: { kind: 'matrix', senderId: matrix.senderId, senderDisplayName: '', roomId: matrix.roomId } })
  expect(view.messages[0]).not.toHaveProperty('thinking')
  expect(view.messages[1]).toMatchObject({ text: 'reply', thinking: 'first\nsecond', createdAt: answer.authoredAt })
  expect((await chat.history('cursor')).messages).toEqual(view.messages.slice(0, 2))
  expect(JSON.stringify(view)).not.toContain('private model attribution')
})

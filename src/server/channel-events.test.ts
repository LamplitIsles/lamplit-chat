import { describe, expect, it } from 'vitest'
import { parseChannels } from './channel-config'
import { parseChannelEvent } from './channel-events'
const config = { webhookToken: 'synthetic-inbound-token', aliases: ['Companion'], selfUserId: '@self:test' }
const keet = { type: 'message', eventId: '00000000-0000-4000-8000-000000000001', sequence: 100, messageId: { deviceId: 'peer', seq: 1 }, timestamp: 42, destination: { kind: 'group', groupName: 'Room' }, senderLabel: 'Alice', text: 'ordinary', addressing: { mentionsIdentity: false } }
const matrix = { type: 'message', room_id: '!room:test', event_id: '$event', sender_id: '@other:test', sender_display_name: '', body: 'ordinary', mentions: [], timestamp: 42, truncated: false }
describe('independent inbound contracts', () => {
  it('retains exact credentials, aliases and Matrix identity, rejects obsolete/unknown fields', () => {
    expect(parseChannels({ matrix: config }).matrix).toEqual(config)
    expect(parseChannels({ keet: { webhookToken: config.webhookToken } }).keet?.aliases).toEqual([])
    for (const value of [{ keet: config }, { matrix: { webhookToken: config.webhookToken } }, { matrix: { ...config, selfUserId: ' @self:test' } }, { matrix: { ...config, selfUserId: '@self' } }, { matrix: { ...config, mcpUrl: 'https://example.invalid' } }, { keet: { webhookToken: 'short' } }, { keet: { webhookToken: 'é'.repeat(16) } }, { keet: { webhookToken: config.webhookToken }, matrix: config }]) expect(() => parseChannels(value)).toThrow()
  })
  it('uses current factual Keet addressing with text-first receiver policy', () => {
    const parse = (value: unknown) => parseChannelEvent('keet', value, config)
    expect(parse(keet)).toMatchObject({ trigger: false, buffer: true })
    for (const value of [{ ...keet, text: 'hello Companion' }, { ...keet, addressing: { mentionsIdentity: true } }, { ...keet, text: 'hello Bot', addressing: { mentionsIdentity: false, identityLabel: 'Bot' } }, { ...keet, replyTo: keet.messageId, addressing: { mentionsIdentity: false, replyToIdentity: true } }, { ...keet, destination: { kind: 'dm', groupName: 'Peer' } }]) expect(parse(value).trigger).toBe(true)
    expect(parse({ ...keet, replyTo: keet.messageId, addressing: { mentionsIdentity: false, replyToIdentity: false } }).trigger).toBe(false)
    expect(parse({ ...keet, destination: { kind: 'broadcast', groupName: 'News' }, addressing: { mentionsIdentity: true } })).toMatchObject({ trigger: false, buffer: false })
    expect(parse({ ...keet, text: '', images: [{ status: 'unavailable', mediaType: 'image/png' }], addressing: { mentionsIdentity: true } })).toMatchObject({ trigger: false, buffer: false })
    expect(() => parse({ ...keet, trigger: 'mention' })).toThrow()
    expect(() => parse({ ...keet, addressing: { mentionsIdentity: false, replyToIdentity: true } })).toThrow()
  })
  it('accepts original MFA blank/reply/UTF16/truncation facts without inventing activation', () => {
    const parse = (value: unknown) => parseChannelEvent('matrix', value, config)
    expect(parse({ ...matrix, body: '', mentions: ['@self:test'], reply_to_event_id: '' })).toMatchObject({ trigger: false, buffer: false })
    expect(parse({ ...matrix, sender_id: '@self:test', body: 'Companion', mentions: ['@self:test'] })).toMatchObject({ trigger: false, buffer: false })
    expect(parse({ ...matrix, mentions: ['@else:test'], reply_to_event_id: '$self' })).toMatchObject({ trigger: false, buffer: true })
    expect(parse({ ...matrix, mentions: ['@self:test'], body: '😀'.repeat(8000), truncated: true }).trigger).toBe(true)
    expect(() => parse({ ...matrix, body: '😀'.repeat(8001) })).toThrow()
    expect(parse({ ...matrix, body: 'Companion' }).trigger).toBe(true)
    expect(parse({ ...matrix, body: 'companion' }).trigger).toBe(false)
  })
  it('wakes only verified own replies, retaining normal mention/alias and self/blank rules', () => {
    const parse = (fields: object) => parseChannelEvent('matrix', { ...matrix, reply_to_event_id: '$target', ...fields }, config)
    expect(parse({ reply_to_sender_id: config.selfUserId })).toMatchObject({ trigger: true, buffer: true, source: { text: matrix.body, timestamp: matrix.timestamp, replyTo: '$target' } })
    expect(parse({ reply_to_sender_id: config.selfUserId, mentions: [config.selfUserId], body: 'Companion' }).trigger).toBe(true)
    for (const reply_to_sender_id of [undefined, '@else:test']) {
      expect(parse({ reply_to_sender_id })).toMatchObject({ trigger: false, buffer: true })
      expect(parse({ reply_to_sender_id, mentions: [config.selfUserId] }).trigger).toBe(true)
      expect(parse({ reply_to_sender_id, body: 'Companion' }).trigger).toBe(true)
    }
    for (const fields of [{ body: '' }, { body: ' \n\t' }, { sender_id: config.selfUserId }]) expect(parse({ reply_to_sender_id: config.selfUserId, mentions: [config.selfUserId], ...fields })).toMatchObject({ trigger: false, buffer: false })
    expect(parse({ reply_to_sender_id: '@' + '😀'.repeat(123) + ':test' }).trigger).toBe(false)
    expect(parse({ reply_to_sender_id: '@' + 'a'.repeat(249) + ':test' }).trigger).toBe(false)
  })
  it('rejects malformed and orphan reply authors without clipping identities', () => {
    for (const reply_to_sender_id of [null, 1, '', ' ', '@self', 'self:test', '@:test', '@self:', '@self :test', '@self:test\n', '@' + '😀'.repeat(125) + ':test', '@' + 'a'.repeat(250) + ':test']) expect(() => parseChannelEvent('matrix', { ...matrix, reply_to_event_id: '$target', reply_to_sender_id }, config)).toThrow()
    for (const reply_to_event_id of [undefined, '', ' \t']) expect(() => parseChannelEvent('matrix', { ...matrix, reply_to_event_id, reply_to_sender_id: config.selfUserId }, config)).toThrow()
  })
})

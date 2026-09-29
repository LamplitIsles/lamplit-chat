import { describe, expect, it } from 'vitest'
import { projectTurnTime } from './turn-time'

describe('Pi provider turn time', () => {
  it('projects durable prompt and queued steer times without changing their text or the leading prompt', () => {
    const prompt = { role: 'user' as const, content: 'Tonight?', timestamp: Date.parse('2026-09-28T12:34:56Z') }
    const steer = { role: 'user' as const, content: 'Actually tomorrow', timestamp: Date.parse('2026-09-28T12:35:00Z') }
    const messages = [
      { role: 'system' as const, content: 'Stable instructions', timestamp: 0 },
      prompt,
      steer,
    ]
    const projected = projectTurnTime(messages, 'Asia/Shanghai')
    expect(projected[0]).toEqual(messages[0])
    expect(projected[1]).toMatchObject({
      role: 'user', timestamp: prompt.timestamp,
      content: [
        { type: 'text', text: '[Host turn time: 2026-09-28 20:34:56 +08:00 (Asia/Shanghai)]' },
        { type: 'text', text: 'Tonight?' },
      ],
    })
    expect(projected[2]).toMatchObject({
      role: 'user', timestamp: steer.timestamp,
      content: [
        { type: 'text', text: '[Host turn time: 2026-09-28 20:35:00 +08:00 (Asia/Shanghai)]' },
        { type: 'text', text: 'Actually tomorrow' },
      ],
    })
    expect(projectTurnTime(messages, 'Asia/Shanghai')).toEqual(projected)
    expect(messages[1]).toEqual(prompt)
    expect(projectTurnTime(messages, 'America/New_York')[1]).toMatchObject({
      content: [
        { text: '[Host turn time: 2026-09-28 08:34:56 -04:00 (America/New_York)]' },
        { text: 'Tonight?' },
      ],
    })
  })
})

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

interface Processor {
  port: { onmessage: (event: { data: { type: string } }) => void }
  process(inputs: Float32Array[][]): boolean
}
function worklet() {
  const messages: (ArrayBuffer | { type: string })[] = []
  let Processor!: new () => Processor
  runInNewContext(readFileSync(new URL('../../frontend/src/lib/companion/client/voice-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: (value: ArrayBuffer | { type: string }) => messages.push(value), onmessage: undefined } },
    registerProcessor: (name: string, constructor: new () => Processor) => { expect(name).toBe('voice-pcm'); Processor = constructor },
  })
  return { processor: new Processor(), messages }
}
describe('deployed worklet wire behavior', () => {
  it('emits little-endian signed mono PCM and a last partial frame before flush acknowledgement', () => {
    const { processor, messages } = worklet()
    processor.process([[new Float32Array([1, -1, 0.5])]])
    expect(messages).toHaveLength(0)
    processor.port.onmessage({ data: { type: 'flush' } })
    const frame = new DataView(messages[0] as ArrayBuffer)
    expect(frame.byteLength).toBe(6)
    expect([frame.getInt16(0, true), frame.getInt16(2, true), frame.getInt16(4, true)]).toEqual([32767, -32768, 16384])
    expect(messages[1]).toEqual({ type: 'flushed' })
    expect(processor.process([[new Float32Array(1600)]])).toBe(false)
    expect(messages).toHaveLength(2)
  })
  it('frames 100ms at 16kHz and downmixes channels', () => {
    const { processor, messages } = worklet()
    processor.process([[new Float32Array(1600).fill(1), new Float32Array(1600).fill(-1)]])
    expect(messages).toHaveLength(1)
    expect((messages[0] as ArrayBuffer).byteLength).toBe(3200)
    expect(new DataView(messages[0] as ArrayBuffer).getInt16(0, true)).toBe(0)
  })
  it('caps five-minute raw samples while allowing normal final flush without exceeding 9,600,000 bytes', () => {
    const { processor, messages } = worklet()
    const frame = [[new Float32Array(1600)]]
    for (let i = 0; i < 3002; i++) processor.process(frame)
    expect(messages).toHaveLength(3001)
    expect(messages.at(-1)).toEqual({ type: 'duration-limit' })
    expect(messages.slice(0, -1).reduce((total, message) => total + (message as ArrayBuffer).byteLength, 0)).toBe(9_600_000)
    processor.port.onmessage({ data: { type: 'flush' } })
    expect(messages.at(-1)).toEqual({ type: 'flushed' })
  })
})

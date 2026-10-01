import { describe, expect, it, vi } from 'vitest'
import { VoiceRecordingController, VoiceRecordingError, normalizeVoiceTranscription, type VoiceRecordingControllerOptions } from '../../frontend/src/lib/companion/client/voice-input'
import { createComposerState, reduceComposer, shouldSubmitEnter } from '../../frontend/src/lib/companion/client/composer'

function capture(options: VoiceRecordingControllerOptions = {}) {
  let grant!: (stream: { getTracks: () => { stop: () => void }[] }) => void
  let stopped = 0
  let started = 0
  class Recorder {
    static isTypeSupported() { return true }
    mimeType = 'audio/webm'
    ondataavailable: ((event: { data?: Blob; error?: unknown }) => void) | null = null
    onstop: (() => void) | null = null
    onerror = null
    start() { started++ }
    stop() {
      this.ondataavailable?.({ data: new Blob(['isolated audio'], { type: this.mimeType }) })
      this.onstop?.()
    }
  }
  const controller = new VoiceRecordingController({
    mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve }) },
    mediaRecorder: Recorder,
    isSecureContext: true,
    ...options,
  })
  return {
    controller,
    grant: () => grant({ getTracks: () => [{ stop: () => { stopped++ } }] }),
    counts: () => ({ stopped, started }),
  }
}

describe('composer and recording lifecycle', () => {
  it('keeps Chinese composition intact until compositionend, including Enter', () => {
    let state = createComposerState('你好')
    state = reduceComposer(state, { type: 'compositionstart' })
    expect(shouldSubmitEnter({ key: 'Enter' }, state.composing)).toBe(false)
    expect(reduceComposer(state, { type: 'submit' })).toEqual(state)
    state = reduceComposer(state, { type: 'compositionend', value: '你好世界' })
    expect(shouldSubmitEnter({ key: 'Enter', isComposing: true }, state.composing)).toBe(false)
    expect(shouldSubmitEnter({ key: 'Enter', shiftKey: true }, state.composing)).toBe(false)
    expect(reduceComposer(state, { type: 'submit' })).toMatchObject({ draft: '', lastSubmitted: '你好世界' })
    expect(reduceComposer(createComposerState('  '), { type: 'submit' }).draft).toBe('  ')
  })

  it('cancels a pending permission request and stops its late stream without starting', async () => {
    const fake = capture()
    const start = fake.controller.start()
    const rejected = expect(start).rejects.toMatchObject({ code: 'cancelled' })
    await fake.controller.cancel()
    fake.grant()
    await rejected
    expect(fake.counts()).toEqual({ stopped: 1, started: 0 })
    expect(fake.controller.busy).toBe(false)
    expect(await fake.controller.stopAndGet()).toBeUndefined()
    fake.controller.dispose()
  })

  it('returns one recording on release, stops tracks and guards transcription', async () => {
    const fake = capture()
    const start = fake.controller.start()
    fake.grant()
    expect(await start).toBe(true)
    expect(fake.controller.busy).toBe(true)
    expect(fake.controller.markTranscribing()).toBe(false)
    const recording = await fake.controller.stopAndGet()
    expect(recording).toMatchObject({ mediaType: 'audio/webm', bytes: 14 })
    expect(fake.counts()).toEqual({ stopped: 1, started: 1 })
    expect(await fake.controller.stopAndGet()).toBeUndefined()
    expect(fake.controller.markTranscribing()).toBe(true)
    expect(fake.controller.markTranscribing()).toBe(false)
    expect(await fake.controller.start()).toBe(false)
    await fake.controller.cancel()
    expect(fake.controller.status).toBe('idle')
    expect(normalizeVoiceTranscription({ text: ' 测试 ', expression: 'happy' })).toEqual({ text: '测试' })
    fake.controller.dispose()
  })

  it('cancels an active recording without returning audio and disposes pending capture', async () => {
    const fake = capture()
    const start = fake.controller.start()
    fake.grant()
    await start
    await fake.controller.cancel()
    expect(await fake.controller.stopAndGet()).toBeUndefined()
    expect(fake.counts().stopped).toBe(1)
    const pending = fake.controller.start()
    const rejected = expect(pending).rejects.toBeInstanceOf(VoiceRecordingError)
    fake.controller.dispose()
    fake.grant()
    await rejected
    expect(fake.counts()).toEqual({ stopped: 2, started: 1 })
  })
})


describe('voice admission and limit cleanup', () => {
  it('stops and recognizes at the duration limit with actual bounded elapsed time', async () => {
    vi.useFakeTimers()
    let recording: ReturnType<VoiceRecordingController['stopAndGet']> | undefined
    const fake = capture({ maxDurationMs: 20, onDurationLimit: () => { recording = fake.controller.stopAndGet() } })
    try {
      const start = fake.controller.start()
      fake.grant()
      await start
      await vi.advanceTimersByTimeAsync(20)
      expect(await recording).toMatchObject({ durationMs: 20, bytes: 14 })
      expect(fake.counts()).toEqual({ stopped: 1, started: 1 })
    } finally { fake.controller.dispose(); vi.useRealTimers() }
  })

  it('rejects insecure capture without requesting media', async () => {
    const fake = capture({ isSecureContext: false })
    await expect(fake.controller.start()).rejects.toMatchObject({ code: 'insecure-context' })
    expect(fake.counts()).toEqual({ stopped: 0, started: 0 })
    fake.controller.dispose()
  })

  it('rejects oversize capture, keeps retry available, and releases all tracks', async () => {
    const stop = vi.fn()
    const fake = capture({ maxBytes: 2, mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { throw new Error('Invalid track') } }, { stop }] }) } })
    await fake.controller.start()
    await expect(fake.controller.stopAndGet()).rejects.toMatchObject({ code: 'size-limit' })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(fake.controller.busy).toBe(false)
    await fake.controller.start()
    await fake.controller.cancel()
    expect(stop).toHaveBeenCalledTimes(2)
    fake.controller.dispose()
  })
})

import { mount, unmount } from 'svelte'
import Fixture from './Fixture.svelte'
// Test-owned oscillator supplies real 16kHz AudioContext/worklet PCM, no physical mic.
const state = { grantDelay: 0, denied: false, unsupported: false, backpressure: false, durationLimit: false, starts: 0, tracks: 0, sends: [] as unknown[] }
Object.assign(window, { voiceFixture: state })
const nativeTimeout = window.setTimeout.bind(window)
window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => nativeTimeout(handler, state.durationLimit && delay === 300000 ? 200 : delay, ...args)) as typeof window.setTimeout
const NativeContext = window.AudioContext
class FixtureContext extends NativeContext {
  constructor(options?: AudioContextOptions) { super(state.unsupported ? { sampleRate: 48000 } : options) }
  createMediaStreamSource(stream: MediaStream) {
    const source = super.createMediaStreamSource(stream)
    const connect = source.connect.bind(source)
    source.connect = ((...args: Parameters<typeof source.connect>) => { state.starts++; return connect(...args) }) as typeof source.connect
    return source
  }
}
Object.assign(window, { AudioContext: FixtureContext })
const NativeSocket = window.WebSocket
class FixtureSocket extends NativeSocket {
  get bufferedAmount() { return state.backpressure ? 262144 : super.bufferedAmount }
}
Object.assign(window, { WebSocket: FixtureSocket })
Object.defineProperty(navigator, 'mediaDevices', { value: { async getUserMedia() {
  if (state.grantDelay) await new Promise(resolve => setTimeout(resolve, state.grantDelay))
  if (state.denied) throw new DOMException('Denied', 'NotAllowedError')
  const context = new NativeContext({ sampleRate: 16000 })
  const oscillator = context.createOscillator()
  const destination = context.createMediaStreamDestination()
  oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start()
  await context.resume()
  const track = destination.stream.getTracks()[0]
  const stop = track.stop.bind(track)
  track.stop = () => { state.tracks++; stop(); oscillator.stop(); void context.close() }
  return destination.stream
} } })
const instance = mount(Fixture, { target: document.getElementById('app')! })
Object.assign(state, { unmount() { void unmount(instance) } })

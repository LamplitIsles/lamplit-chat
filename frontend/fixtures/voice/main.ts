import { mount } from 'svelte'
import Fixture from './Fixture.svelte'
// Synthetic microphone installed before the actual component initializes capture.
const state = { grantDelay: 0, denied: false, starts: 0, tracks: 0, sends: [] as unknown[] }
Object.assign(window, { voiceFixture: state })
Object.defineProperty(navigator, 'mediaDevices', { value: { async getUserMedia() {
  if (state.grantDelay) await new Promise(resolve => setTimeout(resolve, state.grantDelay))
  if (state.denied) throw new DOMException('Denied', 'NotAllowedError')
  return { getTracks: () => [{ stop() { state.tracks++ } }] }
} } })
class Recorder {
  static isTypeSupported() { return true }
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror = null
  start() { state.starts++ }
  stop() { this.ondataavailable?.({ data: new Blob(['synthetic fixture audio'], { type: this.mimeType }) }); this.onstop?.() }
}
Object.assign(window, { MediaRecorder: Recorder })
mount(Fixture, { target: document.getElementById('app')! })

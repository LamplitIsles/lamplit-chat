<script lang="ts">
  import type { CompanionActions, CompanionRecoveredDraft } from '../../src/lib/companion/client/companion-bridge'
  import Companion from '../../src/lib/companion/client/Companion.svelte'
  import { companionTranslate } from '../../src/lib/companion/client/locale'
  import { companionProjection } from '../../src/lib/companion/pi-projection'
  import { normalizeVoiceTranscription, voiceBlobToBase64 } from '../../src/lib/companion/client/voice-input'
  import '../../src/lib/companion/client/daisy.css'
  import '../../src/lib/companion/client/companion.css'
  import '@fontsource/noto-sans-sc/400.css'
  import '@fontsource/noto-sans-sc/600.css'
  let sessionId = 'fixture-session'
  let scheme: 'light' | 'dark' = 'light'
  let available = true
  let busy = false
  let recoveredDraft: CompanionRecoveredDraft | undefined;
  const t = companionTranslate('zh')
  const time = new Date('2026-09-30T08:42:00+08:00').getTime()
  const items = [
    { id: 'a', messageKey: 'a', kind: 'text' as const, side: 'incoming' as const, text: '回来啦。今天想先聊点什么？或者什么都不安排，坐一会儿也好。', time },
    { id: 'b', messageKey: 'b', kind: 'text' as const, side: 'outgoing' as const, text: '今天有点累，想听你说说话。', time: time + 60000 },
    { id: 'c', messageKey: 'c', kind: 'text' as const, side: 'incoming' as const, text: '那就先不用急着做什么。跟我说说，今天最累的是哪一段？', time: time + 60000 },
  ]
  $: projection = companionProjection(items, busy, true, '', false)
  $: document.documentElement.dataset.theme = scheme === 'light' ? 'sticker-messenger' : 'night-voyage'
  const state = (window as Window & { voiceFixture: { sends: { text: string; images: number }[] } }).voiceFixture
  Object.assign(state, { switchSession() { sessionId += '-next' }, dark() { scheme = 'dark' }, capability(value: boolean) { available = value }, running(value: boolean) { busy = value }, recover(text: string) { recoveredDraft = { key: String(Date.now()), sourceIds: [], input: text, images: [] } } })
  const actions: CompanionActions = {
    async send(text, images) { state.sends.push({ text, images: images.length }) },
    async transcribeVoice(recording, signal) {
      const audioBase64 = await voiceBlobToBase64(recording.blob, recording.mediaType)
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      const response = await fetch('/api/voice/transcribe', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audioBase64, mediaType: recording.mediaType, durationMs: recording.durationMs }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      return normalizeVoiceTranscription(data)
    },
  }
</script>
<Companion {t} locale="zh" {projection} {scheme} {actions} {sessionId} {recoveredDraft} sessions={[]}
  workspaceReadiness="ready" sessionReadiness="ready" relationshipReadiness="ready"
  identity={{ companionName: 'Shio', userName: '你', preferredAddress: '你', signature: '', moodLabel: '平静', mood: 'neutral' }}
  voiceCapability={available ? 'available' : 'unavailable'} accountSettingsHref="/settings"
  imageLimits={{ mediaTypes: ['image/png'], maxImagesPerMessage: 6, maxImageBytes: 8000000, maxMessageImageBytes: 24000000 }} />

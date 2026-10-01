<script lang="ts">
  import Companion from '../../src/lib/companion/client/Companion.svelte'
  import { companionTranslate } from '../../src/lib/companion/client/locale'
  import { companionProjection } from '../../src/lib/companion/pi-projection'
  import type { TimelineItem } from '../../src/lib/companion/projection'
  import type { TimedWake } from '../../../src/shared/timed-wake'
  import '../../src/lib/companion/client/daisy.css'
  import '../../src/lib/companion/client/companion.css'
  import '@fontsource/noto-sans-sc/400.css'
  import '@fontsource/noto-sans-sc/600.css'
  let sessionId = 'synthetic-a'
  let scheme: 'light' | 'dark' = 'light'
  let wakeRefreshKey = 0
  let mode = 'list'
  let sends = 0
  let reads = 0
  let release: (() => void) | undefined
  const reminder = '喝一杯水，站起来伸展一下。今天不用急着把所有事情做完，也给自己留一点休息的时间。看看窗外，慢慢呼吸，想聊的时候我就在这里。'
  const wakes: TimedWake[] = [
    { id: 'a', revision: 'a', title: '一起休息一下', reminder, plan: { type: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, nextAt: '2026-10-02T09:00:00+08:00' },
    { id: 'b', revision: 'b', title: '晚间散步', reminder: '晚饭后，出去走走，看看夜色。', plan: { type: 'once', at: '2026-10-02T20:30:00+08:00' }, nextAt: '2026-10-02T20:30:00+08:00' },
  ]
  const source = { wakeId: 'a', revision: 'a', scheduledAt: wakes[0].nextAt, title: wakes[0].title, reminder }
  $: items = mode === 'trigger' ? [
    { id: 'wake', messageKey: 'wake', kind: 'wake', side: 'incoming', source, time: Date.parse(source.scheduledAt) },
    { id: 'reply', messageKey: 'reply', kind: 'text', side: 'incoming', text: '早上好。到了我们说好的时间，来陪你休息一下。先喝一口水吧，今天想从什么开始？', time: Date.parse(source.scheduledAt) + 10000 },
  ] as TimelineItem[] : []
  $: projection = companionProjection(items, false, true)
  $: document.documentElement.dataset.theme = scheme === 'dark' ? 'night-voyage' : 'sticker-messenger'
  const t = companionTranslate('zh')
  Object.assign(window, { wakeFixture: {
    mode(value: string, refresh = true) { mode = value; if (refresh) wakeRefreshKey++ },
    dark() { scheme = 'dark' }, switchSession() { sessionId = 'synthetic-b'; wakeRefreshKey++ },
    reconnect() { wakeRefreshKey++ }, release() { release?.() },
    stats() { return { reads, sends } },
  } })
  const actions = {
    async send() { sends++ }, async listDiary() { return [] }, async readDiary() { return null },
    async listTimedWakes() {
      reads++; const captured = mode; const capturedSession = sessionId
      if (capturedSession === 'synthetic-a' && (captured === 'loading' || captured === 'stale')) await new Promise<void>(resolve => release = resolve)
      if (captured === 'error') throw new Error('Synthetic read failure')
      return captured === 'empty' || capturedSession === 'synthetic-b' ? [] : wakes
    },
  }
</script>
<Companion {t} locale="zh" {projection} {scheme} {actions} {sessionId} {wakeRefreshKey} sessions={[]}
  workspaceReadiness="ready" sessionReadiness="ready" relationshipReadiness="ready" showRelationship showDiary showGallery
  identity={{ companionName: 'Shio', userName: '你', preferredAddress: '你', signature: '', moodLabel: '平静', mood: 'neutral' }} />

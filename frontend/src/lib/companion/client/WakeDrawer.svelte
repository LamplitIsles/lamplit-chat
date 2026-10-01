<script lang="ts">
  import AlarmClock from 'lucide-svelte/icons/alarm-clock';
  import CircleAlert from 'lucide-svelte/icons/circle-alert';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import type { TimedWake } from '../../../../../src/shared/timed-wake';
  import type { CompanionTranslate } from './locale';
  export let t: CompanionTranslate;
  export let locale: string;
  export let sessionId: string | undefined;
  export let refreshKey = 0;
  export let load: (() => Promise<TimedWake[]>) | undefined;
  let wakes: TimedWake[] = [];
  let state: 'loading' | 'ready' | 'error' = 'loading';
  let request = 0;
  let reading = false;
  let expanded = new Set<string>();
  let loadedSession: string | undefined;
  let loadedKey = -1;
  $: if (loadedSession !== sessionId || loadedKey !== refreshKey) {
    const changed = loadedSession !== sessionId;
    loadedSession = sessionId; loadedKey = refreshKey;
    if (changed) { wakes = []; expanded = new Set(); }
    if (changed || !reading) void reload(changed || state !== 'ready');
  }
  async function reload(showLoading = true) {
    const current = ++request;
    reading = true;
    if (showLoading) state = 'loading';
    try {
      const result = await load?.();
      if (!result) throw new Error('Wake reading unavailable');
      if (current === request) { wakes = result; state = 'ready'; }
    } catch { if (current === request) state = 'error'; }
    finally { if (current === request) reading = false; }
  }
  function toggle(id: string) { const next = new Set(expanded); if (next.has(id)) next.delete(id); else next.add(id); expanded = next; }
  function repeat(wake: TimedWake) {
    const plan = wake.plan;
    if (plan.type === 'once') return t('wake.once');
    if (plan.type === 'interval') return t('wake.interval', { seconds: plan.seconds });
    const weekday = plan.type === 'weekly' ? new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + plan.weekday))) : '';
    return plan.type === 'weekly' ? t('wake.weekly', { weekday, time: plan.time, zone: plan.timeZone }) : t('wake.daily', { time: plan.time, zone: plan.timeZone });
  }
</script>
<section class="companion-wakes" aria-label={t('drawer.wakes')}>
  <h2>{t('drawer.wakes')}</h2>
  <p class="wake-intro" role={state === 'loading' ? 'status' : undefined}>{t(state === 'loading' ? 'wake.loading' : 'wake.intro')}</p>
  {#if state === 'loading'}
    {#each [0, 1] as row}<div class="wake-skeleton" aria-hidden="true"><div class="wake-skeleton-time"><div class="cmp-skeleton"></div><div class="cmp-skeleton"></div></div><div><div class="cmp-skeleton"></div><div class="cmp-skeleton"></div></div></div>{/each}
  {:else if state === 'error'}
    <div class="wake-empty" role="alert"><CircleAlert size={30} aria-hidden="true" /><h3>{t('wake.failed')}</h3><p>{t('wake.failedHint')}</p><button type="button" class="cmp-btn cmp-btn-soft wake-retry" on:click={() => void reload()}>{t('wake.retry')}</button></div>
  {:else if !wakes.length}
    <div class="wake-empty"><AlarmClock size={30} aria-hidden="true" /><h3>{t('wake.empty')}</h3><p>{t('wake.emptyHint')}</p><blockquote>{t('wake.example')}</blockquote></div>
  {:else}
    <p class="wake-section">{t('wake.next')}</p>
    {#each wakes as wake (wake.id)}
      <div class="wake-row">
        <div class="wake-time"><span>{new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(wake.nextAt))}</span><time datetime={wake.nextAt}>{new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(wake.nextAt))}</time></div>
        <div class="wake-content"><h3>{wake.title}</h3><p class="wake-repeat">{repeat(wake)}</p><p class:wake-expanded={expanded.has(wake.id)} class="wake-reminder">{wake.reminder}</p></div>
        <button type="button" class="cmp-btn cmp-btn-ghost cmp-btn-circle cmp-btn-sm wake-expand" aria-expanded={expanded.has(wake.id)} aria-label={t(expanded.has(wake.id) ? 'wake.collapse' : 'wake.expand', { title: wake.title })} on:click={() => toggle(wake.id)}>{#if expanded.has(wake.id)}<ChevronDown size={18} />{:else}<ChevronRight size={18} />{/if}</button>
      </div>
    {/each}
  {/if}
</section>

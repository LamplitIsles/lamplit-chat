<script lang="ts">
  import Clock from 'lucide-svelte/icons/clock';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import type { WakeSource } from '../../../../../src/shared/timed-wake';
  import type { CompanionTranslate } from './locale';
  export let source: WakeSource;
  export let t: CompanionTranslate;
  export let locale: string;
  let expanded = false;
</script>
<div class="companion-wake-source">
  <button type="button" class="cmp-btn cmp-btn-ghost wake-source-toggle" aria-expanded={expanded} on:click={() => expanded = !expanded}><Clock size={18} aria-hidden="true" /><span>{new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(source.scheduledAt))} · {t('wake.source')}</span>{#if expanded}<ChevronDown size={18} />{:else}<ChevronRight size={18} />{/if}</button>
  {#if expanded}<div class="wake-source-content"><h3>{source.title}</h3><p>{source.reminder}</p></div>{/if}
</div>

<script lang="ts">
  import { onMount } from 'svelte';
  import { updated } from '$app/stores';
  import { AgentClient } from 'agents/client';
  import Companion from '$lib/companion/client/Companion.svelte';
  import { companionTranslate } from '$lib/companion/client/locale';
  import { APPEARANCE_STORAGE_KEY, LANGUAGE_STORAGE_KEY, initialPreferences, resolveScheme, writePreference, type CompanionAppearance, type CompanionLanguage } from '$lib/companion/client/preferences';
  import type { CompanionActions, CompanionActivity, CompanionHistoryView } from '$lib/companion/client/companion-bridge';
  import { affinityStage } from '$lib/companion/domain';
  import type { TimelineItem } from '$lib/companion/projection';
  import { acceptOptimisticPrompt, activityForPiEvent, beginOptimisticPrompt, branchItems, canStartSubmission, companionProjection, hasDurablePrompt, isCompactCommand, projectPromptBranch, visibleBranchEntries, type OptimisticPrompt } from '$lib/companion/pi-projection';
  import { CompanionPreControllerError } from '$lib/companion/client/admission';
  import { pollCompanionRefresh } from '$lib/companion/refresh';
  import { preparePhotoUploads } from '$lib/companion/photo-upload';
  import type { CompanionRecoveredDraft } from '$lib/companion/client/companion-bridge';
  import type { PiRegistryContract, PiSessionContract, PiStreamEvent, RelationshipState } from '../../../src/shared/pi-contract';

  const prefix = 'api/agents';
  const sessionKey = 'pi-on-cf.companion.session-id';
  const steerKey = 'pi-on-cf.pending-steer';
  const photoKey = 'pi-on-cf.pending-photos';
  const imageLimits = { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const, maxImagesPerMessage: 6, maxImageBytes: 8_000_000, maxMessageImageBytes: 24_000_000 };
  const sessionName = 'Companion';
  const reconnect = { minReconnectionDelay: 300, maxReconnectionDelay: 2_000, reconnectionDelayGrowFactor: 1.5 };
  const mark = (name: string) => { if (!performance.getEntriesByName(name).length) performance.mark(name); };
  type CurrentSubmission = OptimisticPrompt & {
    beforeRevision: number;
    onRetire?: Parameters<CompanionActions['send']>[2];
    retired: boolean;
    runError: string;
    transportError: string;
  };
  const preferences = initialPreferences();
  let language: CompanionLanguage = preferences.language;
  let appearance: CompanionAppearance = preferences.appearance;
  let systemDark = preferences.systemDark;
  let ready = false;
  let updateSafe = false;
  let mounted = false;
  let visible = false;
  let reloading = false;
  let online = true;
  let photosEnabled = false;
  let accountSettingsHref: string | null = null;
  let displayNames = { companionName: '', userName: '' };
  let namesRequest = 0;
  let hasAvatar = false;
  let hasUserAvatar = false;
  let hasBackground = false;
  let assetVersion = Date.now();
  let assetError = '';
  let running = false;
  let promptInFlight = false;
  let uploading = false;
  let assetOperations = 0;
  let compacting = false;
  let error = '';
  let sessionId = '';
  let durableItems: TimelineItem[] = [];
  let optimistic: CurrentSubmission | undefined;
  let recoveredDraft: CompanionRecoveredDraft | undefined;
  let optimisticAfterSeq = 0;
  let stopRequested = '';
  let activity: CompanionActivity = 'thinking';
  let lastRevision = 0;
  let session: AgentClient<PiSessionContract> | undefined;
  let registry: AgentClient<PiRegistryContract> | undefined;
  let reportedTimeZone = '';
  let zoneReport: Promise<void> = Promise.resolve();
  let relationship: RelationshipState = { mood: 'neutral', affinity: 50, signature: '' };
  let history: CompanionHistoryView = { status: 'loading', records: [], hasEarlier: false };
  let historyRequest = 0;
  let disposed = false;
  let requestId = 0;
  let reconciliationTimer: number | undefined;
  let reconciliationInFlight = false;
  let reconciliationAttempts = 0;
  $: if (mounted && $updated && updateSafe && !running && !promptInFlight && !uploading && !assetOperations && !compacting && online && !reloading && visible) {
    reloading = true;
    location.reload();
  }
  $: t = companionTranslate(language);
  $: scheme = resolveScheme(appearance, systemDark);
  $: if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = scheme === 'dark' ? 'night-voyage' : 'sticker-messenger';
    document.documentElement.style.colorScheme = scheme === 'dark' ? 'only dark' : 'only light';
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme === 'dark' ? 'only dark' : 'only light');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', scheme === 'dark' ? '#0b1220' : '#f3f6f8');
  }
  $: projection = companionProjection(
    [...durableItems, ...(optimistic ? [...(optimistic.images ?? []), ...(optimistic.item.text ? [optimistic.item] : [])] : [])],
    running, ready, error,
    !canStartSubmission(optimistic, uploading),
  );

  async function refreshRelationship() {
    if (!registry) return;
    const current = ++historyRequest;
    try {
      const snapshot = await registry.stub.getRelationshipSnapshot();
      if (disposed || current !== historyRequest) return;
      relationship = snapshot.state;
      history = { status: 'ready', records: snapshot.records, hasEarlier: snapshot.hasEarlier, nextBefore: snapshot.nextBefore, predecessor: snapshot.predecessor };
    } catch (cause) {
      if (!disposed && current === historyRequest) { history = { ...history, status: 'error' }; console.error('Could not load relationship history', cause); }
    }
  }

  async function refresh(settledAfterSeq?: number) {
    if (!session) return;
    const current = ++requestId;
    let [overview, branch] = await Promise.all([session.stub.getOverview(), session.stub.getBranch()]);
    for (let attempt = 0; settledAfterSeq !== undefined && attempt < 5 && (overview.running || !branchItems(branch.entries.filter((entry) => entry.seq > settledAfterSeq && entry.message?.role === 'assistant')).some((item) => item.kind === 'text')); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (disposed || current !== requestId) return;
      [overview, branch] = await Promise.all([session.stub.getOverview(), session.stub.getBranch()]);
    }
    if (disposed || current !== requestId) return;
    const stillRunning = promptInFlight || overview.running;
    const visibleEntries = visibleBranchEntries(branch.entries, stillRunning && !compacting, optimistic);
    durableItems = projectPromptBranch(visibleEntries, optimistic, optimisticAfterSeq, sessionId);
    lastRevision = branch.revision;
    if (hasDurablePrompt(visibleEntries, optimistic)) { if (optimistic?.steering) localStorage.removeItem(steerKey); localStorage.removeItem(photoKey); optimistic = undefined; }
    running = stillRunning;
    ready = true;
    mark('lamplit-can-send');
    if (!performance.getEntriesByName('lamplit-history-visible').length) setTimeout(() => performance.mark('lamplit-history-visible'), 0);
  }

  async function connect() {
    mark('lamplit-connect-start');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const connectRegistry = () => registry ??= new AgentClient<PiRegistryContract>({ agent: 'PiRegistry', name: 'singleton', prefix, host: window.location.host, protocol, ...reconnect });
    let firstOpen = true;
    const connectSession = (name: string) => {
      session = new AgentClient<PiSessionContract>({ agent: 'PiSession', name, prefix, host: window.location.host, protocol, ...reconnect, onConnectionError: (cause) => { if (!optimistic || optimistic.entryId) error = cause.message; ready = false; } });
      session.addEventListener('close', () => { if (!disposed) { ready = false; mark('lamplit-connection-lost'); } });
      session.addEventListener('open', () => { if (!disposed) { error = ''; if (firstOpen) firstOpen = false; else { mark('lamplit-reconnected'); void refresh().then(() => mark('lamplit-reconnect-ready')).catch(showError); } scheduleReconciliation(0); } });
      return session;
    };
    if (window.location.hostname.endsWith('.lamplit.run')) connectSession('default');
    const configRequest = fetch('/api/companion-config');
    const configResponse = await configRequest;
    mark('lamplit-config-response');
    if (!configResponse.ok) throw new Error('Could not load companion configuration.');
    const config = await configResponse.json() as { sessionId: string | null; photosEnabled: boolean; accountSettingsHref: string | null };
    photosEnabled = config.photosEnabled;
    accountSettingsHref = config.accountSettingsHref;
    void refreshNames().catch(showError);
    if (photosEnabled) void refreshAssets().catch(showError);
    let id = config.sessionId || localStorage.getItem(sessionKey);
    if (!id) {
      const currentRegistry = connectRegistry();
      await currentRegistry.ready;
      const existing = (await currentRegistry.stub.listSessions({ limit: 100 })).find((item) => item.name === sessionName && item.status === 'ready');
      id = existing?.id ?? (await currentRegistry.stub.createSession({ name: sessionName })).id;
    }
    mark('lamplit-session-selected');
    localStorage.setItem(sessionKey, id);
    if (disposed) return;
    sessionId = id;
    try {
      const saved = JSON.parse(localStorage.getItem(steerKey) || 'null') as { sessionId: string; operationId: string; text: string; entryId?: string } | null;
      if (saved?.sessionId === id && saved.operationId && saved.text) {
        optimistic = { ...beginOptimisticPrompt(saved.operationId, saved.text), steering: true, ...(saved.entryId ? { entryId: saved.entryId, state: 'accepted' as const } : { state: 'uncertain' as const }), beforeRevision: 0, retired: true, runError: '', transportError: '' };
      }
    } catch { localStorage.removeItem(steerKey); }
    try {
      const saved = JSON.parse(localStorage.getItem(photoKey) || 'null') as { sessionId: string; operationId: string; text: string; ids: string[]; names: string[]; steering: boolean; entryId?: string } | null;
      if (saved?.sessionId === id && saved.operationId && saved.ids?.length) {
        optimistic = { ...beginOptimisticPrompt(saved.operationId, saved.text), images: saved.ids.map((photoId, index) => ({ id: photoId, messageKey: saved.operationId, kind: 'image' as const, side: 'outgoing' as const, state: 'ready' as const, alt: saved.names[index] ?? 'Photo', previewUrl: `/api/conversation-images/${id}/${photoId}/preview?operation=${saved.operationId}` })), steering: saved.steering, ...(saved.entryId ? { entryId: saved.entryId, state: 'accepted' as const } : { state: 'uncertain' as const }), beforeRevision: 0, retired: true, runError: '', transportError: '' };
      }
    } catch { localStorage.removeItem(photoKey); }
    session ??= connectSession(id);
    await session.ready;
    if (!performance.getEntriesByName('lamplit-ws-connected').length) performance.mark('lamplit-ws-connected');
    await refresh();
    void connectRegistry().ready.then(() => { mark('lamplit-registry-ready'); void reportUserTimeZone(true); void refreshRelationship(); }).catch(showError);
    if (optimistic) scheduleReconciliation(0);
  }

  function showError(cause: unknown) {
    if (!disposed) error = cause instanceof Error ? cause.message : String(cause);
  }

  function reportUserTimeZone(force = false): Promise<void> {
    zoneReport = zoneReport.catch(() => {}).then(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (registry && (force || timeZone !== reportedTimeZone)) {
        await registry.stub.reportUserTimeZone(timeZone);
        reportedTimeZone = timeZone;
      }
    });
    return zoneReport;
  }

  function retireSubmission(submission: CurrentSubmission, reason: 'observed' | 'failed') {
    if (submission.retired) return;
    submission.retired = true;
    submission.onRetire?.({ reason });
  }

  function scheduleReconciliation(delayMs: number) {
    if (!optimistic || (optimistic.state !== 'admitting' && optimistic.state !== 'uncertain')) return;
    if (reconciliationTimer !== undefined) window.clearTimeout(reconciliationTimer);
    reconciliationTimer = window.setTimeout(() => {
      reconciliationTimer = undefined;
      void reconcilePromptSubmission(optimistic?.operationId).catch(showError);
    }, delayMs);
  }

  async function reconcilePromptSubmission(operationId?: string) {
    if (!operationId || reconciliationInFlight || !session) return;
    const submission = optimistic;
    if (!submission || submission.operationId !== operationId || submission.entryId) return;
    reconciliationInFlight = true;
    try {
      const status = submission.steering ? await session.stub.getSteerAdmission(operationId) : await session.stub.getPromptAdmission(operationId);
      if (disposed || optimistic?.operationId !== operationId || optimistic.entryId) return;
      const current = optimistic;
      if (status.state === 'accepted' || status.state === 'settled') {
        retireSubmission(current, 'observed');
        optimistic = acceptOptimisticPrompt(current, {
          type: 'accepted', operationId, entryId: status.entryId,
        }) as CurrentSubmission;
        if (current.steering) localStorage.setItem(steerKey, JSON.stringify({ sessionId, operationId, text: current.item.text, entryId: status.entryId }));
        const saved = localStorage.getItem(photoKey);
        if (saved) localStorage.setItem(photoKey, JSON.stringify({ ...JSON.parse(saved), entryId: status.entryId }));
        reconciliationAttempts = 0;
        if (reconciliationTimer !== undefined) window.clearTimeout(reconciliationTimer);
        reconciliationTimer = undefined;
        if (current.runError) error = current.runError;
        if (stopRequested === operationId) {
          stopRequested = '';
          if (status.state === 'accepted' && 'running' in status && status.running) await session.stub.abort();
        }
        await refresh(status.state === 'settled' ? current.beforeRevision : undefined);
      } else if (status.state === 'missing' && !promptInFlight) {
        optimistic = undefined;
        const restoreAfterReload = current.retired || !current.onRetire;
        retireSubmission(current, 'failed');
        error = current.transportError || current.runError || t('message.unconfirmed');
        if (current.steering) localStorage.removeItem(steerKey);
        const saved = localStorage.getItem(photoKey);
        if (saved && restoreAfterReload) {
          const draft = JSON.parse(saved) as { ids: string[]; names: string[]; text: string };
          recoveredDraft = { key: operationId, sourceIds: [operationId], input: draft.text, images: draft.ids.map((id, index) => ({ id, name: draft.names[index] ?? 'Photo', url: `/api/conversation-images/${sessionId}/${id}/original?operation=${operationId}` })) };
        }
        if (saved) localStorage.removeItem(photoKey);
        if (stopRequested === operationId) stopRequested = '';
        await refresh();
      } else {
        optimistic = { ...current, state: 'uncertain' };
        scheduleReconciliation(Math.min(10_000, 250 * 2 ** Math.min(++reconciliationAttempts, 6)));
      }
    } catch {
      if (optimistic?.operationId === operationId && !optimistic.entryId) {
        optimistic = { ...optimistic, state: 'uncertain' };
        scheduleReconciliation(Math.min(10_000, 250 * 2 ** Math.min(++reconciliationAttempts, 6)));
      }
    } finally {
      reconciliationInFlight = false;
      if (optimistic && !optimistic.entryId && reconciliationTimer === undefined) scheduleReconciliation(250);
    }
  }

  const actions: CompanionActions = {
    async send(text, images, onRetire) {
      if (!canStartSubmission(optimistic, uploading)) {
        throw new CompanionPreControllerError(t('connection.interrupted'));
      }
      const compactCommand = isCompactCommand(text, images.length);
      if (!session || !ready || (running && compactCommand)) throw new CompanionPreControllerError(t('connection.interrupted'));
      const steering = running;
      uploading = true;
      const operationId = crypto.randomUUID();
      const currentSession = session;
      try {
        void reportUserTimeZone().catch(showError);
        if (images.length && !photosEnabled) throw new Error('Photos require an R2 bucket configured by the operator.');
        if (images.length) {
          const uploads = await preparePhotoUploads(operationId, images);
          for (const upload of uploads) await currentSession.stub.uploadPhoto(upload);
          localStorage.setItem(photoKey, JSON.stringify({ sessionId, operationId, text, ids: uploads.map((upload) => upload.id), names: uploads.map((upload) => upload.name), steering }));
        }
      } catch (cause) { throw new CompanionPreControllerError(cause instanceof Error ? cause.message : String(cause)); }
      finally { uploading = false; }
      const photoIds = images.map((image) => image.id);
      const optimisticImages = images.map((image) => ({ id: image.id, messageKey: operationId, kind: 'image' as const, side: 'outgoing' as const, state: 'ready' as const, alt: image.file.name, previewUrl: image.previewUrl }));
      if (steering) {
        optimistic = { ...beginOptimisticPrompt(operationId, text), images: optimisticImages, steering: true, beforeRevision: lastRevision, onRetire, retired: false, runError: '', transportError: '' };
        localStorage.setItem(steerKey, JSON.stringify({ sessionId, operationId, text }));
        scheduleReconciliation(3000);
        try {
          const status = await currentSession.stub.submitSteer({ submissionId: operationId, prompt: text, photoIds });
          if (status.state === 'accepted' && optimistic?.operationId === operationId) {
            const submission = optimistic;
            retireSubmission(submission, 'observed');
            optimistic = acceptOptimisticPrompt(submission, { type: 'accepted', operationId, entryId: status.entryId }) as CurrentSubmission;
            localStorage.setItem(steerKey, JSON.stringify({ sessionId, operationId, text, entryId: status.entryId }));
            await refresh();
          }
        } catch (cause) {
          if (optimistic?.operationId === operationId) optimistic = { ...optimistic, state: 'uncertain', transportError: cause instanceof Error ? cause.message : String(cause) };
        }
        if (optimistic?.operationId === operationId && !optimistic.entryId) scheduleReconciliation(0);
        return;
      }
      if (compactCommand) {
        promptInFlight = true;
        compacting = true;
        running = true;
        try { await session.stub.compact(); await refresh(); }
        catch (cause) { showError(cause); throw cause; }
        finally { promptInFlight = false; compacting = false; await refresh().catch(showError); }
        return;
      }
      const beforeRevision = lastRevision;
      optimisticAfterSeq = beforeRevision;
      optimistic = {
        ...beginOptimisticPrompt(operationId, text), images: optimisticImages,
        beforeRevision, onRetire, retired: false, runError: '', transportError: '',
      };
      activity = 'thinking';
      error = '';
      promptInFlight = true;
      performance.clearMarks('lamplit-model-first-response');
      performance.mark('lamplit-prompt-start');
      running = true;
      scheduleReconciliation(3000);
      let completed = false;
      let runError = '';
      try {
        await currentSession.call('prompt', [{ operationId, prompt: text, photoIds }], { stream: {
          onChunk: (chunk) => {
            if (disposed || session !== currentSession) return;
            const event = chunk as PiStreamEvent;
            if ((event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'tool_execution_start') && !performance.getEntriesByName('lamplit-model-first-response').length) performance.mark('lamplit-model-first-response');
            if (event.type === 'error') {
              runError = event.error;
              if (optimistic?.operationId === operationId) optimistic = { ...optimistic, runError: event.error };
              return;
            }
            if (event.type === 'accepted' && event.operationId === operationId && optimistic?.operationId === operationId && !optimistic.entryId) {
              const submission = optimistic;
              retireSubmission(submission, 'observed');
              optimistic = acceptOptimisticPrompt(submission, event) as CurrentSubmission;
              if (stopRequested === operationId) {
                stopRequested = '';
                void currentSession.stub.abort().then(() => refresh()).catch(showError);
              }
              return;
            }
            activity = activityForPiEvent(activity, event);
          },
          onError: (message) => {
            if (optimistic?.operationId === operationId) optimistic = { ...optimistic, transportError: message };
          },
        } });
        completed = true;
      } catch (cause) {
        if (optimistic?.operationId === operationId) {
          optimistic = { ...optimistic, transportError: cause instanceof Error ? cause.message : String(cause) };
        }
      }
      finally {
        promptInFlight = false;
        if (optimistic?.operationId === operationId) {
          if (!optimistic.entryId) {
            optimistic = { ...optimistic, state: 'uncertain' };
            scheduleReconciliation(0);
          } else if (runError) {
            error = runError;
          }
        }
        if (runError && !optimistic) error = runError;
        try { await refresh(completed && optimistic?.entryId && !error ? beforeRevision : undefined); } catch (cause) { showError(cause); ready = false; running = false; }
        void refreshRelationship();
      }
    },
    async stop() {
      if (!session) return;
      if (optimistic && !optimistic.entryId) {
        stopRequested = optimistic.operationId;
        scheduleReconciliation(0);
        return;
      }
      await session.stub.abort();
      await refresh();
    },
    async loadEarlierHistory() {
      if (!registry || !history.hasEarlier || history.nextBefore === undefined || history.loadingEarlier) return;
      history = { ...history, loadingEarlier: true };
      try {
        const snapshot = await registry.stub.getRelationshipSnapshot({ before: history.nextBefore });
        if (disposed) return;
        relationship = snapshot.state;
        history = { status: 'ready', records: [...history.records, ...snapshot.records], hasEarlier: snapshot.hasEarlier, nextBefore: snapshot.nextBefore, predecessor: snapshot.predecessor };
      } catch (cause) {
        if (!disposed) { history = { ...history, loadingEarlier: false }; console.error('Could not load earlier relationship history', cause); }
      }
    },
    retryHistory() { history = { ...history, status: 'loading' }; void refreshRelationship(); },
    async listDiary() { return session ? session.stub.listDiary() : []; },
    async readDiary(name) { return session ? session.stub.readDiary(name) : null; },
  };

  onMount(() => {
    mounted = true;
    visible = document.visibilityState === 'visible';
    const syncPreferences = () => {
      const current = initialPreferences();
      appearance = current.appearance;
      language = current.language;
      systemDark = current.systemDark;
    };
    const checkUpdate = () => { if (navigator.onLine) void updated.check().catch(() => {}); };
    syncPreferences();
    checkUpdate();
    const onStorage = (event: StorageEvent) => {
      syncPreferences();
      if (event.key === 'lamplit.display-names.revision') void refreshNames().catch(showError);
      if (event.key === 'lamplit.ui-assets.revision' && photosEnabled) void refreshAssets().catch(showError);
    };
    window.addEventListener('storage', onStorage);
    const onFocus = () => { syncPreferences(); void refreshNames().catch(showError); };
    window.addEventListener('focus', onFocus);
    mark('lamplit-page-mounted');
    online = navigator.onLine;
    const onNetworkChange = () => {
      online = navigator.onLine;
      mark(online ? 'lamplit-network-online' : 'lamplit-network-offline');
      if (online) {
        checkUpdate();
        if (session) { void refresh().then(() => mark('lamplit-network-ready')).catch(showError); scheduleReconciliation(0); }
        else void connect().catch(showError);
      }
    };
    window.addEventListener('online', onNetworkChange);
    window.addEventListener('offline', onNetworkChange);
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onColorSchemeChange = (event: MediaQueryListEvent) => { systemDark = event.matches; };
    systemDark = colorScheme.matches;
    colorScheme.addEventListener('change', onColorSchemeChange);
    void connect().catch(showError);
    const onVisible = () => {
      visible = document.visibilityState === 'visible';
      if (document.visibilityState === 'visible') {
        syncPreferences();
        void refreshNames().catch(showError);
        checkUpdate();
        if (photosEnabled) void refreshAssets().catch(showError);
        mark('lamplit-foreground-start');
        void reportUserTimeZone(true).catch(showError);
        void refresh().then(() => mark('lamplit-foreground-ready')).catch(showError);
        scheduleReconciliation(0);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reportUserTimeZone().catch(showError);
      void pollCompanionRefresh({ ready, running, optimistic: Boolean(optimistic), promptInFlight, visible: document.visibilityState === 'visible' }, refresh)?.catch(showError);
    }, 3000);
    return () => { mounted = false; window.removeEventListener('storage', onStorage); window.removeEventListener('focus', onFocus); disposed = true; window.clearInterval(poll); if (reconciliationTimer !== undefined) window.clearTimeout(reconciliationTimer); document.removeEventListener('visibilitychange', onVisible); colorScheme.removeEventListener('change', onColorSchemeChange); window.removeEventListener('online', onNetworkChange); window.removeEventListener('offline', onNetworkChange); session?.close(); registry?.close(); };
  });

  function setLanguage(value: CompanionLanguage) { language = value; writePreference(LANGUAGE_STORAGE_KEY, value); }
  function setAppearance(value: CompanionAppearance) { appearance = value; writePreference(APPEARANCE_STORAGE_KEY, value); }
  async function refreshNames() {
    const request = ++namesRequest;
    const response = await fetch('/api/display-names', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load display names.');
    const names = await response.json() as typeof displayNames;
    if (!disposed && request === namesRequest) displayNames = names;
  }
  async function refreshAssets() {
    const response = await fetch('/api/ui-assets');
    if (!response.ok) throw new Error('Could not load interface images.');
    const data = await response.json() as { assets: Array<{ slot: string }> };
    hasAvatar = data.assets.some((asset) => asset.slot === 'avatar');
    hasUserAvatar = data.assets.some((asset) => asset.slot === 'user-avatar');
    hasBackground = data.assets.some((asset) => asset.slot === 'background');
    assetVersion = Date.now();
  }
  async function uploadAsset(slot: 'avatar' | 'user-avatar' | 'background', event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    assetOperations++;
    try {
      if (file.size > 8_000_000) throw new Error('Image exceeds 8 MB.');
      const response = await fetch(`/api/ui-assets/${slot}`, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
      if (!response.ok) throw new Error(await response.text());
      await refreshAssets(); assetError = '';
      try { localStorage.setItem('lamplit.ui-assets.revision', String(Date.now())); } catch {}
    } catch (cause) { assetError = cause instanceof Error ? cause.message : 'Upload failed.'; }
    finally { input.value = ''; assetOperations--; }
  }
  async function removeAsset(slot: 'avatar' | 'user-avatar' | 'background') {
    assetOperations++;
    try {
      const response = await fetch(`/api/ui-assets/${slot}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await response.text());
      await refreshAssets(); assetError = '';
      try { localStorage.setItem('lamplit.ui-assets.revision', String(Date.now())); } catch {}
    } catch (cause) { assetError = cause instanceof Error ? cause.message : 'Removal failed.'; }
    finally { assetOperations--; }
  }
  function moodText(): string { return t(`mood.${relationship.mood}` as Parameters<typeof t>[0]); }
  function affinityText(): string {
    const key = ({ '疏离': 'affinity.distant', '生疏': 'affinity.unfamiliar', '熟悉': 'affinity.familiar', '亲近': 'affinity.close', '深厚': 'affinity.deep' } as const)[affinityStage(relationship.affinity)];
    return t(key);
  }
</script>

<svelte:head><title>Lamplit · Companion</title></svelte:head>
<div style={`--companion-wallpaper:${hasBackground ? `url('/api/ui-assets/background?v=${assetVersion}')` : 'none'}`}>
<Companion bind:updateSafe networkOnline={online} {projection} {actions} {t} locale={language} {appearance} {activity} onLanguageChange={setLanguage} onAppearanceChange={setAppearance} {sessionId} {accountSettingsHref}
  imageSettings={photosEnabled ? { hasAvatar, hasUserAvatar, hasBackground, error: assetError, upload: (slot, event) => { void uploadAsset(slot, event); }, remove: (slot) => { void removeAsset(slot); } } : undefined}
  identity={{ companionName: displayNames.companionName || 'Companion', companionAvatar: hasAvatar ? `/api/ui-assets/avatar?v=${assetVersion}` : '', userName: displayNames.userName || t('you'), userAvatar: hasUserAvatar ? `/api/ui-assets/user-avatar?v=${assetVersion}` : '', preferredAddress: displayNames.userName || t('you'), signature: relationship.signature, mood: relationship.mood, moodLabel: moodText(), moodNote: relationship.note, affinity: relationship.affinity, affinityStage: affinityText() }}
  {history} workspaceReadiness={ready ? 'ready' : 'loading'} sessionReadiness={ready ? 'ready' : 'loading'} relationshipReadiness="ready" voiceCapability="unavailable" showRelationship={true} showDiary={true} showGallery={photosEnabled} imageLimits={photosEnabled ? imageLimits : undefined} {recoveredDraft} onHistoryOpenChange={(open) => { if (open) void refreshRelationship(); }} />
</div>

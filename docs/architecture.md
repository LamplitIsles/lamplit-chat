# Pi on Cloudflare Architecture

The Worker combines Pi, Cloudflare Agents SDK, SQLite-backed Durable Objects,
Computer's workspace file API, and the shared Framework7 App built by adjacent `lamplit-app`.
`src/server.ts` routes authenticated Agent RPC/WebSockets, private photos,
Companion materials, history archives/import and bounded web tools. Static
requests use the assets binding. Hosted and independent self-host deployments
share the same product code; Platform supplies hosted identity and BYOK settings.

## Durable state

`PiRegistry` indexes session metadata, search, lineage, learned memory and
relationship history. Hosted registry/session names include the instance scope.
Each `PiSession` owns its conversation tree, active leaf, durable Pi lane/inbox,
compaction settings and isolated `/workspace` files. Completed entries, queued
input and admitted operations survive eviction; transient browser stream deltas
are not replayed. Recovery resumes accepted operations using their durable source
identity. Browser submissions use the submission ledger; autonomous custom
reminders use their occurrence receipts.

The configured OpenAI-compatible model uses the existing BYOK key. The default
self-hosted edition requires neither Platform nor AI Gateway, Loader, containers,
shell or Git. Computer supplies bounded file reads/writes inside SQLite; optional
conversation photos use private R2. See README for the deployment/auth contract.

## Imported conversation archives

The registry also owns source-keyed `history_archives`, immutable nodes and bounded per-conversation staging. Archives never enter `pi_registry_sessions` or PiSession ownership. A synchronous SQLite transaction commits nodes, source-role binding and existing FTS entries together; there is no cross-DO protocol or harness execution. Search joins committed archives alongside runtime sessions and reports archive/source-node metadata; normal session lists exclude archives. [History import contract](history-import.md) defines authentication, schemas, limits, retry and diagnostic privacy.

## Companion boundary

The shared browser connects to authenticated `/api/chat/socket`. The Worker selects
PiRegistry's default Companion session, or the personal deployment's configured
`COMPANION_SESSION_ID`; hosted DO names retain the instance prefix. Management can
still use the existing native Agent RPC routes independently.

`getOverview()` and `getBranch()` retain the native management API. The default
browser uses `@lamplit/contracts` through authenticated `/api/chat/socket`; Pi's
adapter projects native durable entries, operation receipts, panels and FTS results.
Shared browser code, UI and browser behavior tests belong to `lamplit-app`.
Native relationship validation lives in `src/server/relationship-validation.ts`.
The retired frontend source, resources and tests are removed. No fallback UI or
`/slice` route remains.

Personal HTTP/WebSocket routing requires AUTH_PASSWORD. Hosted routing requires
Platform's trusted instance/secret headers and validates session tokens against
Platform on each delivery. Platform owns management, hosted manifest/service worker
and public authentication. Both app entries use the same root-relative assets.


## Timed wakes

Machine-only `timed_wake` tools manage arrangements in their current PiSession;
only list reading is browser-callable. Croner computes daily/weekly timezone
instants without timers. Agents SDK schedules the next Date callback, preserving
its existing alarm and pending drain. SQLite commits source/occurrence receipt,
Pi followUp input and next-occurrence advancement together. Current answers
finish before queued reminders run. Startup reconciliation is tracked background
work and completes before resumed model execution. Provider-message projection
with wake sources and idle drain await serialized schedule reconciliation, so internally consumed
followUps cannot generate before future registration. The 60-second eligibility
check occurs immediately before public followUp admission; an in-window call
may finish committing after the cutoff. The drawer reads current
arrangements on open, session changes and normal reconnect/poll refresh. Custom
message snapshots project to an inline companion source, rather than a human
bubble. [Timed-wake contract](timed-wake.md) specifies cutoff, quotas, DST,
recovery and synthetic workerd/browser acceptance.

## Mobile composer and appearance

The existing `Companion.svelte` owns the two-layer composer and an explicit attachment panel. Photo library, PWA environment-capture input, native Capacitor camera, and clipboard images all pass through `imageIntakeError` and `createImageDrafts`. Intake is atomic: invalid additions leave existing text/photos untouched, cancellation produces no error, and accepted files close the panel. The existing submission controller continues to own retirement and draft restoration; the view shows validation and pre-controller failure feedback without changing durable admission or photo storage.

The primary action retains text/image Send and Stop gates. The microphone uses click-to-start/click-to-stop and remains available alongside Send for existing drafts. Recognition inserts at the captured cursor selection, preserves surrounding text and attachments, and restores the cursor after the inserted text. Draft editing and Send are disabled during capture/recognition. Space/Enter activate the focused button normally; Escape cancels. `VoiceRecordingController` owns AudioContext, bundled PCM AudioWorklet, WebSocket, duration/size/queue admission and cleanup. Capture generation, session and draft revision prevent stale permission/transcription from overwriting another session or changed draft. Five minutes stops capture and recognizes with a limit notice. Cancel, tab hide, browser back and component destruction release capture. Results never call `actions.send` or add expression annotations.

`src/server/voice.ts` implements the fixed Beijing `qwen-audio-3.1-asr-flash-streaming` WebSocket relay. `src/server.ts` applies existing self-host password or hosted instance/internal-secret authentication before `/api/voice/capability` and `/api/voice/stream`; upgrade additionally requires exact Origin. Hosted settings come from the authenticated `PLATFORM /internal/chat-voice/<instanceId>` binding on every connection, with a five-second configuration deadline and no self-host fallback. The independent self-host `VOICE_API_KEY` secret needs no Platform. PCM16 LE mono16kHz streams only after matching task-started; finish-task follows the last flushed frame; finalized sentences are ordered/deduplicated and emitted once after task-finished. Bounded frames/queues/PCM/transcripts and setup/finish/absolute deadlines close every terminal path. It neither invokes Pi nor stores/logs audio/transcripts. Audio is processed while recording; cancellation cannot guarantee avoided billing. [Voice input](voice-input.md) owns the wire contract, limits, privacy, and committed local/joint fixture commands.

The light theme uses background `#f3f6f8`, surface `#ffffff`, tint `#e1ecf3`, text `#263747`, muted `#617384`, and primary `#365c78`; dark uses blue grey counterparts. Existing theme names remain internal selectors for the unchanged `light`/`dark`/`system` preference contract. Noto Sans SC is bundled, with Android/system sans-serif fallbacks; no remote font is added. Controls have at least 44px touch targets, the composer respects the bottom safe area, and reduced motion suppresses movement. Hosted navigation still uses `/chat` and `/settings`; identity, manifests and service workers are unchanged.

Unit coverage lives under the current `src/**/*.test.ts` Vitest discovery, including composer/recording lifecycle and atomic image intake. UI acceptance uses the real component in an isolated browser with fake actions and capture; no production services or real media device are required. Camera chooser and physical Android behavior remain device acceptance work, not a claim established by desktop emulation.

## Conversation photos

The browser accepts up to six PNG, JPEG, WebP, or GIF originals (8 MB each, 24 MB total), then makes JPEG preview and model variants. It uploads each under a stable photo ID before Pi admission. The host validates types, byte signatures, size, order, and aggregate serialized Pi message size, then sends the bounded variants as Pi native `ImageContent`. The model descriptor advertises image input. The entire message is capped at 1.5 MB, below the Durable Object SQLite 2 MB row limit. The original and preview bytes stay in the existing private `COMPUTER_R2` bucket under `conversation-photos/<session-id>/<photo-id>/`; no R2 URL is published.

`conversation_photos` in each `PiSession` Durable Object reserves an upload identity before R2 writes, then marks it ready after all variants are stored. Prompt or steer admission freezes the exact ordered IDs in `conversation_photo_groups`; retries can complete an identical interrupted upload but cannot replace its bytes or add photos to an admitted group. Recovery correlates only that frozen set to the canonical Pi entry. Unaccepted uploads are excluded from the album. The current session's bounded album query reads admitted records across every branch in stable order. `getBranch()` removes native image blocks from its browser-facing message projection while leaving the durable Pi entry intact; it includes photo metadata so the timeline can request previews. The authenticated Worker routes resolve a session and photo ID through that session's ledger before reading R2. Bubbles and the grid use previews; opening the lightbox requests the original. The browser keeps uploaded references across an uncertain admission and can restore the draft from private originals if the operation is missing after reload.

## Boundaries and limitations

The UI opens one conversation. Other registry and tree operations still exist on the Worker API but are not presented in the shared App. Reconnect reads the durable snapshot and current native turn; it does not resubmit an uncertain input automatically. Personal-deployment HTTP/WebSocket entry requires AUTH_PASSWORD authentication; hosted entry requires trusted platform instance/secret headers and instance-scoped session ownership. Read-only archive IDs cannot enter runnable-session routes.

## Verification

`npm run lint`, `npm run typecheck` and `npm test` check the native core. `npm run build` runs the adjacent App build. See [default shared frontend](default-shared-frontend.md) for exact-artifact native/browser checks. `npm run deploy` builds and deploys the self-hosted Worker; hosted deployment uses `wrangler.hosted.jsonc` after the same shared App build. No deployment is performed by local verification.

## Shared image and recovery adapter

The shared socket and bounded authenticated image HTTP routes reuse native
`uploadPhoto`, `modelPhotos`, prompt/steer ledgers and R2 variants. Immutable
submission identity includes text, ordered image metadata and replacement IDs.
Native storage records submitted input and exact main-lane cancellation proof,
and validates/tombstones replacement sources atomically with harness admission.
Shared envelopes alone remain uncertain. History and album project actual native
photo-entry membership, including agent provenance; uploads alone are excluded.
[Image sending and recovery](image-send-recovery.md) owns public endpoints,
limits, authorization and the frozen browser/native acceptance commands.

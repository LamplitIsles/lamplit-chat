# Pi on Cloudflare Architecture

The Worker combines Pi, Cloudflare Agents SDK, SQLite-backed Durable Objects,
Computer's workspace file API, and a static SvelteKit Companion frontend.
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

The browser connects to `PiRegistry` once to resolve its Companion session, then connects to that `PiSession` through `AgentClient`. A configured `COMPANION_SESSION_ID` takes priority. Otherwise it uses the browser's stored ID or finds/creates a named `霁霁` session.

`getOverview()` supplies active-turn status and `getBranch()` supplies the durable transcript. `frontend/src/lib/companion/pi-projection.ts` maps settled user and assistant text into Companion's timeline with a quiet compaction marker. The controller in `frontend/src/routes/+page.svelte` shows a temporary outgoing echo while `agent.call('prompt')` runs. The browser's operation ID is passed to Pi `accept()`; after that durable commit, an `accepted` stream event carries the canonical user entry ID and clears the sending state. Branch refresh replaces the echo by entry ID, including when two prompts have identical text. Pi `drive()` then runs the model; other stream events drive only the waiting box's semantic activity. Raw reasoning, tool details, and partial assistant text stay out of chat. Completion or reconnect refreshes the durable branch, and `abort()` handles stop while `compact()` handles `/compact`. The imported CFL appearance preference applies the resolved light or dark Daisy theme to the document root.

`Companion.svelte` and its domain/projection, composer, Markdown, preferences, localization, DaisyUI styles, and responsive layout were brought from Codex for Love. The old Node/Codex host is not deployed. The relationship drawer reads paged SQLite events from `PiRegistry`; its latest state is added to each Pi turn, and Pi has tools to update the state and read recent changes. Its diary tab reads dated Markdown files from the current `PiSession` workspace through read-only RPC calls, with the same 128 KiB entry limit as CFL. The imported photo picker, timeline image display, lightbox, and album are enabled for web conversation photos. The empty composer exposes a voice mode backed by authenticated Worker transcription, with capability refreshed by the root route. Telemetry remains hidden. The imported frontend source is Apache 2.0 licensed.

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

The primary action retains text/image Send and Stop gates. The microphone uses click-to-start/click-to-stop and remains available alongside Send for existing drafts. Recognition inserts at the captured cursor selection, preserves surrounding text and attachments, and restores the cursor after the inserted text. Draft editing and Send are disabled during capture/recognition. Space/Enter activate the focused button normally; Escape cancels. `VoiceRecordingController` owns stream, recorder, duration/size admission and cleanup. Capture generation, session and draft revision prevent stale permission/transcription from overwriting another session or changed draft. Five minutes stops capture and recognizes with a limit notice. Cancel, tab hide, browser back and component destruction release capture. Results never call `actions.send` or add expression annotations.

`src/server/voice.ts` implements the fixed Qwen executor. `src/server.ts` applies existing self-host password or hosted instance/internal-secret authentication before `/api/voice/capability` and `/api/voice/transcribe`; POST additionally rejects cross-origin mutation. Hosted settings come from the authenticated `PLATFORM /internal/chat-voice/<instanceId>` binding on every invocation, with a five-second configuration deadline and no self-host fallback. The independent self-host `VOICE_API_KEY` secret needs no Platform. The executor admits a canonical Base64 audio data URL up to 10,000,000 ASCII bytes, streams and bounds JSON before parsing, rejects redirects, and bounds provider response/deadline. It neither invokes Pi nor stores audio/transcripts. [Voice input](voice-input.md) defines operational limits, privacy and local integration fixtures.

The light theme uses background `#f3f6f8`, surface `#ffffff`, tint `#e1ecf3`, text `#263747`, muted `#617384`, and primary `#365c78`; dark uses blue grey counterparts. Existing theme names remain internal selectors for the unchanged `light`/`dark`/`system` preference contract. Noto Sans SC is bundled, with Android/system sans-serif fallbacks; no remote font is added. Controls have at least 44px touch targets, the composer respects the bottom safe area, and reduced motion suppresses movement. Hosted navigation still uses `/chat` and `/settings`; identity, manifests and service workers are unchanged.

Unit coverage lives under the current `src/**/*.test.ts` Vitest discovery, including composer/recording lifecycle and atomic image intake. UI acceptance uses the real component in an isolated browser with fake actions and capture; no production services or real media device are required. Camera chooser and physical Android behavior remain device acceptance work, not a claim established by desktop emulation.

## Conversation photos

The browser accepts up to six PNG, JPEG, WebP, or GIF originals (8 MB each, 24 MB total), then makes JPEG preview and model variants. It uploads each under a stable photo ID before Pi admission. The host validates types, byte signatures, size, order, and aggregate serialized Pi message size, then sends the bounded variants as Pi native `ImageContent`. The model descriptor advertises image input. The entire message is capped at 1.5 MB, below the Durable Object SQLite 2 MB row limit. The original and preview bytes stay in the existing private `COMPUTER_R2` bucket under `conversation-photos/<session-id>/<photo-id>/`; no R2 URL is published.

`conversation_photos` in each `PiSession` Durable Object reserves an upload identity before R2 writes, then marks it ready after all variants are stored. Prompt or steer admission freezes the exact ordered IDs in `conversation_photo_groups`; retries can complete an identical interrupted upload but cannot replace its bytes or add photos to an admitted group. Recovery correlates only that frozen set to the canonical Pi entry. Unaccepted uploads are excluded from the album. The current session's bounded album query reads admitted records across every branch in stable order. `getBranch()` removes native image blocks from its browser-facing message projection while leaving the durable Pi entry intact; it includes photo metadata so the timeline can request previews. The authenticated Worker routes resolve a session and photo ID through that session's ledger before reading R2. Bubbles and the grid use previews; opening the lightbox requests the original. The browser keeps uploaded references across an uncertain admission and can restore the draft from private originals if the operation is missing after reload.

## Boundaries and limitations

The UI opens one conversation. Other registry and tree operations still exist on the Worker API but are not presented in this slice. When a page reconnects during an active turn, it polls durable state until the turn completes; it cannot replay missed token deltas. Personal-deployment HTTP/WebSocket entry requires AUTH_PASSWORD authentication; hosted entry requires trusted platform instance/secret headers and instance-scoped session ownership. Read-only archive IDs cannot enter runnable-session routes.

## Verification

`npm run check:frontend` checks Svelte, `npm run typecheck` checks Worker TypeScript, `npm test` runs unit and Workers tests, and `npm run build` creates the static site. `npm run deploy` builds and deploys the self-hosted Worker; hosted deployment uses `wrangler.hosted.jsonc` after the same frontend build. No deployment is performed by local verification.

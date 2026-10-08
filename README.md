# Lamplit Chat

This repository is the canonical chat core for the self-hosted Free edition and the hosted Lamplit application. It was seeded from `pi-on-cf/feat/free-plan` at e938b28. Both deployments build the same `src/` and the approved immutable Framework7 App artifact from `lamplit-app`; hosted mode adds instance-scoped routing, a Platform service binding for account-bound model settings, and host-only identity enforced by the public Platform Worker. The self-hosted entry below remains independent of a Lamplit account or Platform deployment.

A single-user, self-hosted Pi companion on Cloudflare Workers and SQLite-backed Durable Objects. The default deployment needs no Workers Paid subscription, Worker Loader, Containers, R2, AI Gateway, work machine, Forgejo, or hosted Lamplit account. Bring one supported native provider API key or token. **This branch is a new-instance configuration; it does not migrate the author's production service.**

The Companion UI supports streaming chat, durable history, native submissions and reconnect recovery, a relationship profile, read-only timed-wake arrangements and reminder sources, learned memory, FTS5 session search, and a Markdown workspace in each session. The agent can read, write, edit, list, find, and search workspace files. It cannot run generated JavaScript or shell, use Git, build/deploy apps, or preview apps. Workspace files use the `@cloudflare/computer` SQLite file API inside the session DO; no Loader is needed. The file tools enforce `/workspace` paths, a 128 KB per-file limit, and bounded search results. Model memory extraction uses the configured model API key.

The chat core pins public `@earendil-works/pi-durable` and `pi-ai` **1.0.4**,
with Cloudflare Agents **0.26.0** public-beta `PiHarness`. Native task/submission
records own execution and restart recovery. The authenticated host adds immutable
content checking; native requestId deduplication itself does not compare payloads.
See [native runtime, data conversion and acceptance](docs/native-durable-submissions.md)
for #3436, the approved App identity, local gates and remaining Orc acceptance.

## Chat on mobile

The Companion uses a mist blue light theme and a coordinated blue grey dark theme. Theme (`light`, `dark`, or `system`) and Chinese/English preferences are stored locally using `her.companion.appearance` and `her.companion.language`. Hosted users configure them in the management App at `/settings`; the chat App opens at `/chat`. Both entries share the user's personal origin. The chat synchronizes preferences on storage events, focus and foreground return, without a manual refresh. Self-hosted users use the chat's Settings control.

Companion and user display names are persisted through `/api/display-names` and refreshed across the two entries; avatars and backgrounds use private UI assets. These names only affect display and greetings, not the personality file or system prompt. Basic hosted chat is free with BYOK; optional development environments remain planned and are not required for import, personality or memory management.

The shared Framework7 composer keeps text, photos and microphone actions together.
The idle attachment action opens the photo library; its long press offers the camera.
During recording or recognition that position becomes the accessible Cancel action.
Photos retain type, size, count, preview, removal and upload checks. Image-only sends
are supported; rejected drafts and attachments remain available for explicit retry.
Chinese IME composition cannot submit, Enter sends, and Shift+Enter inserts a newline.
Submitted input remains distinct from reply completion, failure and stop.

Click the microphone to stream recognition while speaking, then click Stop to flush and await final text. It remains available alongside Send when text already exists. Recognition inserts at the cursor or replaces selected text, preserves attachments, and never sends automatically. The draft is read-only during recording/recognition; Cancel or Escape preserves it. Cancel, tab hide, leaving the page, or changing sessions releases capture and discards late results. Cancellation before permission resolves never starts recording later. Space/Enter activate the focused button. Voice requires HTTPS (or localhost), microphone permission, AudioWorklet, and an actual 16kHz AudioContext.

Voice uses a separate Beijing-region Alibaba Model Studio key with the fixed `qwen-audio-3.1-asr-flash-streaming` WebSocket endpoint. Self-host operators set the **`VOICE_API_KEY` Worker secret** independently of the chat model key; hosted chat obtains current settings only from Platform. Capability refreshes on load, focus, and pageshow; every streaming connection resolves the current key again. See [voice setup, limits, privacy and isolated fixtures](docs/voice-input.md). The relay consumes the compiled `@lamplit/contracts/voice` package from the approved immutable App artifact; `/api/voice/capability` alone advertises recording availability, with no competing voice flag in chat snapshots. Missing or failing capability leaves text chat usable. The shared browser inserts only finalized text into an editable draft after Finish; drafts above the shared chat's 16,000 UTF-16-unit send limit must be shortened before Send. The shared App is the default frontend; recording remains separate from sending. Exact frozen native acceptance and remaining live/device checks are documented in [default shared frontend](docs/default-shared-frontend.md).

In a PWA, Camera uses an image file input with `capture="environment"`. The browser/device decides whether this directly opens a camera or offers a chooser. The existing Capacitor camera is used only in a native context. Real Android camera, microphone, installation, and software-keyboard behavior have not been tested for this UI update; isolated Chromium component tests and screenshots cover 390×844, 320px and desktop layouts.

## Install and run locally

Use Node.js 24 or newer and npm for this repository. App acceptance dependencies use Bun 1.3.14 inside the approved test-owned extraction. `.npmrc` preserves the packed local-contract dependency used by `package-lock.json`.

```bash
npm ci
# Put the approved immutable App archive at the path described in docs/default-shared-frontend.md.
cp .env.example .env.free
# Edit .env.free with your model key and a random, unique AUTH_PASSWORD (at least 24 characters).
# Edit MODEL_PROVIDER and AI_MODEL in wrangler.jsonc using native catalog IDs.
cp .env.free .dev.vars
npm run build
npx wrangler dev --config wrangler.jsonc --local-protocol https
```

Choose an enabled native provider/model from the 37 audited Pi built-ins, including DeepSeek, OpenAI, Anthropic, Google/Vertex, Copilot, Bedrock bearer-token auth and regional/token-plan variants. Each needs only its stored key or token; OAuth login and providers needing extra account/deployment fields are excluded. Pi supplies protocol, context/output capacity and image/thinking capabilities. `MODEL_THINKING_LEVEL` and `MODEL_MAX_OUTPUT_TOKENS` are empty for native defaults; set supported values only when you want an explicit override. Chat, memory extraction and compaction use that same selection. Custom endpoints and independent memory models are removed. See [native catalog, full provider inventory, options and verification](docs/provider-model-catalog.md) for exact IDs/contracts, scope and unchanged Platform consumer contract. An image-capable model and optional R2 are needed for new photos; existing albums remain readable after switching to text-only.

The first browser request asks for HTTP Basic credentials. Use any username and your `AUTH_PASSWORD`. The Worker then issues an `HttpOnly`, `Secure`, `SameSite=Strict` cookie so the browser's WebSocket handshake uses the same authentication. The entire site, `/api/agents/*`, album, history, and files require this cookie or Basic auth. Rotate the secret to revoke existing cookies. Use HTTPS in production. Wrangler's local HTTPS uses a development certificate; the browser may ask you to trust it.

## Deploy a new instance

Sign into the intended Cloudflare account and check the account and plan in the dashboard. The default `wrangler.jsonc` names a new Worker `lamplit-free`, enables its account-specific `workers.dev` URL, and has no custom domain or storage binding other than two SQLite-backed DO classes. If that name is already used, choose a fresh name before deploying. Never point this config at an existing production Worker or DO namespace.

```bash
npm run build
npx wrangler whoami
npx wrangler deploy --config wrangler.jsonc --secrets-file .env.free
```

`MODEL_API_KEY` and `AUTH_PASSWORD` are the only required secrets. Keep `.env.free` private and out of Git. The model key stays server-side. `PI_SYSTEM_PROMPT` overrides the default companion prompt. `COMPANION_SESSION_ID` is normally empty; the browser finds or creates a `Companion` session. The browser reports its IANA time zone and Pi includes local time beside each user input.

Without R2, the album and interface image controls are hidden; opening the attachment panel explains that pictures cannot be sent. To enable photos, first activate an R2 subscription in the target account, create a private bucket, and add a `COMPUTER_R2` R2 binding to a private copy of `wrangler.jsonc`; then regenerate types and deploy that copy. R2's included storage and operations are free up to its allowance, but Cloudflare requires an R2 subscription checkout to activate it. Full originals, previews, and model variants are stored in that private bucket. Avatar and chat background images use private R2 objects with metadata in Registry SQLite. Upload and remove them from the Images control; chat photos can be deleted with authenticated `DELETE /api/conversation-images/<session-id>/<photo-id>`. No public R2 URL or S3 credentials are required. Text chat, memory, Markdown, and FTS work without R2.

## Data portability

Chat, memory and customization remain portable. The authenticated history-import
backend accepts normalized RikkaHub, DeepSeek and Operit data into private read-only
archives and FTS; Platform owns parsing and the management import interface. Imports
never execute historical tools or change active context. A complete export/migration
interface remains outside this change. Native conversation history and files stay
durable within the instance.

The standalone shared App manifest uses `/` for identity, start URL and scope.
The App does not register a service worker. Hosted manifest, root service worker,
authentication and management `/settings` remain independently owned by Platform.
Physical-device installation, keyboard, safe-area and live provider behavior need
later joint verification; isolated Chromium acceptance does not establish them.

## Timed wakes

Your companion can create, list, replace and cancel one-time, fixed-interval,
daily or weekly reminders in the original chat. View upcoming arrangements in
the fourth home-drawer tab; long text and trigger sources expand inline. Due
work continues with the browser closed and waits after the current answer.
Occurrences over 60 seconds late at public admission start are skipped without catchup; already
accepted work follows Pi's durable recovery. Daily/weekly arrangements save an
explicit IANA timezone. There are no added system push notifications; model
usage uses your existing key and may incur charges.

See [timed-wake behavior, DST rules, operator notes and isolated verification](docs/timed-wake.md).

## Free-plan limits and verification

Official Cloudflare documentation checked 2026-09-29:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free has 100,000 entrance Worker requests/day and 10 ms CPU per HTTP request. Waiting on model `fetch()` is wall-clock time, not CPU. There is no fixed wall-time limit for a connected HTTP response, but disconnects can cancel work; Pi's durable admission/recovery handles lost connections.
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/): SQLite-backed DOs are available on Free. The Free allowance includes 100,000 DO requests/day, 13,000 GB-s active duration/day, 5 million SQLite rows read/day, 100,000 rows written/day, and 5 GB stored data total. Exceeding a Free allowance can make that operation fail. The DO limits page lists a default 30-second active CPU limit per invocation; confirm the effective behavior on the chosen Free account because the general Workers Free entrance limit is 10 ms.
- [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/): a DO may hibernate with an idle hibernatable WebSocket, but an in-progress request or awaited model fetch prevents hibernation. Model wait can therefore consume DO active-duration allowance. Test streaming and recovery on the target account.
- [R2 setup](https://developers.cloudflare.com/r2/get-started/) and [pricing](https://developers.cloudflare.com/r2/pricing/): optional photos require activating an R2 subscription; the standard storage free tier is 10 GB-month/month with included operations.

Run local checks with `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. On an explicitly authorized isolated Free account, verify: first session and two consecutive turns; close/reopen the browser during a turn; history and FTS query; Markdown write then read after reconnect; memory persistence; and anonymous HTTP and WebSocket rejection. Measure four timings separately: first page open, WebSocket connected, history visible, and model first response. Record network/location, cold or warm start, and sample count. Do not count model wait as page load. A Paid-account deployment does not establish Free compatibility.

The project is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution and [LICENSES/pi-on-cf-MIT.txt](LICENSES/pi-on-cf-MIT.txt) for the retained original pi-on-cf notice. The imported Codex for Love license remains in [LICENSES/codex-for-love-Apache-2.0.txt](LICENSES/codex-for-love-Apache-2.0.txt). Third-party dependencies retain their own licenses.

## History import backend

Authenticated `/api/history-import` and `/api/history-archives` accept normalized RikkaHub, DeepSeek and Android Operit conversation data and expose private, read-only archives. Archives and existing FTS become visible in the same PiRegistry SQLite commit. `session_search` finds plain text on all committed branches and identifies the source node; historical thoughts remain readable but are excluded from search. Import creates no runnable PiSession, changes no main context, executes no historical tools, restores no images/persona/memory/workspace, and makes no model calls.

See [the complete API contract](docs/history-import.md), [machine-readable schemas/types](src/shared/history-import.ts), and [fictional fixtures](src/server/fixtures/README.md). Request JSON is bounded to 1,000,000 UTF-8 bytes before parsing; nodes to 256,000 serialized bytes; conversations to 10,000 nodes / 64,000,000 normalized bytes. Batches allow longer conversations. Raw-file parsing and limits belong to platform (ZIP 100 MB; Operit JSON 24,000,000 bytes before reading). First successful Rikka commit fixes the source assistant ID. Operit independently fixes the exact role-card name via `card:<SHA-256 of UTF-8 name>`, or the distinct `none` group. Start/cancel/failure do not bind; renames and switching groups are rejected, and equal names cannot distinguish different cards. Operit optionally preserves an external parent conversation reference without requiring that parent archive; identical exports deduplicate, new branches append, and content conflicts never overwrite committed history. Structured diagnostics contain controlled fields and hashed IDs, with no body/thought/settings/secrets/raw exceptions.

For isolated integration run `node scripts/history-import-local.mjs` (or add `--hosted` for the trusted platform service-header contract) and follow the contract's test setup. It uses a fresh temporary directory, fictional authentication and example.invalid model endpoints. Personal deployments use their existing AUTH_PASSWORD auth. Platform owns source parsing and management UI. Operit backend Spec #3084 and platform Spec #3085 are implemented and Owner-reviewed; isolated parser→proxy→archive→search acceptance passed. The normalized fixture is fictional; supplemental Kotlin model-serializer output also parses successfully, but exact-release Android App export remains untested. PR and merge delivery is authorized; deployment requires separate authorization.

## Hosted mode

`wrangler.hosted.jsonc` deploys an internal `lamplit-chat` Worker with no public `workers.dev` or preview URL. The public `lamplit-platform` Worker verifies the personal hostname and session on each request, then sends the derived chat instance ID and personal session hash over a Service Binding. Chat maps each instance to its own `PiRegistry`, each session to an instance-prefixed `PiSession`, and R2 keys to an instance prefix. Every WebSocket RPC checks the personal session with Platform; logout also closes matching Registry and Session sockets. Chat obtains the current user's model configuration through a secret-protected internal Platform endpoint, including background memory extraction.

Hosted deployment uses the isolated `lamplit-chat-media` R2 bucket, the Platform Worker service, and the same high-entropy `CHAT_INTERNAL_SECRET` secret on both Workers. Build the shared App before deploying. In local development the Platform `--env local` Worker is named `lamplit-platform-local`, so a local-only copy of the hosted config must point its `PLATFORM` service there and set `PLATFORM_ORIGIN` to `http://app.localhost:8877`. The default `wrangler.jsonc` remains the independent self-hosted deployment. Deployment status and later live verification belong to Owner; this implementation does not deploy.

The default Framework7 App is served at standalone `/` and hosted `/chat`, with
root-relative `/assets/*` and `/icons/*`. `/slice` and missing assets return 404
rather than a SPA shell. The retired frontend source, resources and tests are
removed. Native relationship validation lives in `src/server/relationship-validation.ts`;
shared browser behavior is tested in `lamplit-app`. Management/native
routes, import, domain stores, tools and instance/auth boundaries remain on the public native runtime. See [the complete build and acceptance workflow](docs/default-shared-frontend.md).
No live state, provider, service or deployment is part of implementation verification.

The chat page updates Android browser/PWA theme-color with its resolved light/dark/system theme so the system bar matches the header. Platform owns the hosted launch background; the standalone manifest comes from the shared App. System time/battery/gesture bars remain browser-controlled; viewport-fit=cover and existing safe-area padding protect controls.

## Source repositories

The chat backend is open source at https://github.com/LamplitIsles/lamplit-chat and the shared App at https://github.com/LamplitIsles/lamplit-app; the public website lives at https://github.com/LamplitIsles/lamplit-site. Platform account management and the future hosted work machine are separate projects, outside this repository's open-source scope.

Local `origin` remains Forgejo for development and PRs; `github` points to the public GitHub repository for additional publication of merged `main`. Synchronization is explicit; merging or deploying does not automatically push GitHub.

## Companion materials

Authenticated `/api/companion-materials` edits the current companion’s original root Markdown, updates/deletes existing memory with conflict checks, and reads/saves/resets the full effective COMPACTION.md prompt. Only AGENTS.md is automatically injected; it can direct the companion to read other root Markdown. Management requires no model or inference. Selfhost must configure a ready `COMPANION_SESSION_ID`. See [API contract and isolated integration guide](docs/companion-materials.md), [machine-readable contract](docs/companion-materials.contract.json), and `src/server/fixtures/companion-materials.json`. An organizing assistant is paid Phase 2.

## Web search and public webpage reading

The companion has `web_search`, `web_fetch` and `web_links` tools. Search uses an independent
BYOK search credential for exactly one of Exa, Brave or DeepSeek; it never reuses
the model key. Search calls and an explicitly requested management test may incur
provider charges. Saving settings and skipping the test do not call a provider.
Normal zero-result searches succeed.

For self-hosting, set `WEB_SEARCH_PROVIDER` to `exa`, `brave` or `deepseek` in your
private Wrangler configuration or local `.dev.vars`, and keep
`WEB_SEARCH_API_KEY` in `.dev.vars` locally or as a Worker secret when deploying.
Both are optional; clearing either disables search. Hosted instances obtain
settings from Platform's secret-protected `/internal/chat-search/<instanceId>`
service binding endpoint. Platform owns encrypted per-user storage and the
management UI. Each actual search reads current settings; the next turn updates
available tools without a chat reload. Disablement blocks old tool calls too.
Already sent provider requests cannot be recalled or their charges reversed.

`POST /api/web-search/test` accepts `{query}` through the existing authenticated
entry and uses exactly the same executor as `web_search`. Hosted requests require
the internal secret and authenticated instance ID derived by Platform. Config
identifiers are `exa|brave|deepseek`; result labels are exactly
`Exa|Brave|DeepSeek`, with `{title,link,snippet,position}` results. Responses are
no-store and failures return bounded `{error,code}` without provider diagnostics.

`web_fetch` remains available without a search key and with search disabled. This
is the disclosed Owner implementation assumption for this release. It reads
public HTTP(S) HTML, Markdown or plain text. It sends only an Accept header,
requests Markdown first, forwards no user credentials/cookies, runs no webpage
JavaScript, and uses linkedom plus Defuddle 0.19.4 for article extraction, then
Turndown on the extracted DOM for Markdown. There is no browser, login capture or site-specific fetching. Content is untrusted
source material, not system instructions. Empty, failed or recognized access
interstitial pages return a failure rather than an article.

Page reading rejects URL credentials, local/private/reserved IP addresses,
nonstandard ports, local hostnames, nonpublic DNS answers and redirects to those
targets. Each redirect is checked again. Worker `node:dns` checks use Cloudflare
DNS; Worker fetch cannot pin that checked IP, so DNS rebinding remains a platform
limitation. Bounds are 15 seconds total network time, three redirects, 512 KiB
input, 24,000 body characters and 500 title characters. Clipping either body or
title sets `truncated` to true. Results include final `url`, `truncated`,
`inputBytes` and local `parseTimeMs`. Search transport is bounded to 30 seconds
and 1 MiB provider response. Extraction is synchronous and its CPU cannot be
preempted by the network timer. Local Worker fixtures and profiles establish
runtime support, not production site coverage or Free-account CPU compliance.

Provider execution and bounded readers are copied/adapted from guionai/web;
see NOTICE and LICENSES/guionai-web-Apache-2.0.txt. Defuddle, linkedom, Turndown and ipaddr.js
retain their upstream licenses. Run the isolated Worker coverage with
`npm run test:worker -- src/server/web-search.worker.test.ts`. Both chat and
Platform PRs must pass joint save → tool/provider/key change/disable/two-owner
isolation/test acceptance before either merges. This feature performs no D1
migration in chat and does not deploy either repository.


`web_links({url, limit?})` lists anchors from the original public HTML page, in
page order, with duplicate destinations removed. `limit` defaults to 100 and
accepts integers 1–100. The result is `{url, links: [{text, url}], truncated}`;
relative URLs respect the final page URL and HTML base element. Only HTTP(S)
destinations without embedded credentials are returned. Labels are bounded to
500 characters and URLs to 4,000; input shares `web_fetch`'s 512 KiB bound and
15-second timeout. `truncated` marks input or result-list truncation. An empty
HTML link list succeeds; non-HTML responses fail. Use `web_fetch` to read a
selected destination. Links are untrusted, and each subsequent fetch validates
its destination independently. No destination is fetched while listing links.
Like `web_fetch`, it runs without a search key or Platform in self-hosting, and
with search disabled in hosted mode. It does not render JavaScript or provide
Markdown heading trees. Anchor extraction follows the Apache-2.0 `guionai/web`
implementation, using Lamplit's existing bounded transport.

## Hosted platform feedback

Hosted companions can autonomously call `submit_platform_feedback` to send
Lamplit product problems or improvement suggestions: a required problem and
optional circumstances and expected improvement. The Human has authorized this
feedback tool without confirmation for each submission. Other sending and
publishing retain their existing authorization rules; feedback must exclude
secrets and private conversation transcripts.

Machine feedback appears under the owning account in the management app’s
**My feedback / 我的反馈**, with source and processing status. There is no dedicated
chat receipt interface. Self-hosted personal deployments do not provide the tool.
Existing hosted sessions receive it when their harness is rebuilt.

See [the tool contract and isolated chat checks](docs/platform-feedback-tool.md)
for trusted identity, existing bindings, stable submission keys, result validation
and uncertain outcomes. A timeout or disconnect is unconfirmed and may already
have been saved; replay the same call identity to avoid duplicates.

## Shared companion panels

The authenticated shared-app socket exposes bounded relationship/history, diary,
album and reminder reads from the existing PiRegistry/PiSession stores. Public
schemas come from the approved immutable `@lamplit/contracts` package; panel reads do not
start Agent turns. Images retain authenticated same-origin HTTP resources and
instance/session membership. Timed-wake input is shown as an application reminder;
the native 60-second lateness window and immutable admission receipts remain.

See [protocol, security, native scheduling and operator acceptance commands](docs/companion-panels.md).
Run `node scripts/companion-panels-local.mjs .scratch/default-shared-frontend/panels-unique`
with the approved extracted App handoff for an isolated actual-workerd host on
port 8951. The guide includes native seeding and read-only browser verification at
390/1280 with synthetic model/ASR responses. The shared App is the default frontend.

## Shared images and input recovery

The shared app now uses authenticated `/api/chat/images`, `/api/chat/media` and
`/api/chat/socket` with Pi's existing operation-owned R2 variants and native
durable submission admission. Image-only messages, ordered image history, album provenance
and eligible native-origin failed input are projected from native storage. Edited
resends upload under a fresh operation; consumed/replaced sources cannot replay.
Uncertain delivery remains visible and never automatically resubmits. Image intake
availability follows the existing R2 binding, while text/voice remain usable.

See [the public/native contract and frozen actual-host acceptance recipe](docs/image-send-recovery.md)
for limits, owner/session authorization, retry/replacement identity and isolated
workerd checks. The shared App is the default frontend. The local fixture uses
port 8973 and fresh test-owned state; its control route is never production routing.

## Shared quiet compaction

The shared browser's exact bare `/compact` invokes Pi's native compaction operation.
Busy or refused commands retain the draft; native running/failure feedback is shown,
and successful manual/automatic completion is silent. The capacity meter uses active
native context and selected model metadata. Stale pre-compaction usage displays zero until fresh valid assistant usage, retaining capacity.
Reconnect and lost replies do not replay compaction.

The public native ContextView replaces the old SDK export patch. No patched or
private engine entry point remains. See [quiet-compaction.md](docs/quiet-compaction.md)
and [the current acceptance guide](docs/native-durable-submissions.md).

## Shared conversation archive search

The shared App searches individual native user/assistant records and compaction
summaries across current/past sessions, preserved originals, branches and existing
imports. Pi retains FTS5 matching and BM25 ranking, with record-recency ties and
20 results total; there is no per-session quota. The separate agent-facing
`session_search` keeps its existing behavior. The read-only reader follows native
parents and unique successors without switching chat or clearing drafts. Selected
text is complete within the existing transport; nearby context is bounded to
eight eligible records per side and 12,000 Unicode code points. Ordinary read
failures support retry. See [protocol, ownership, summary indexing and exact
frozen native acceptance](docs/conversation-search.md). Both native hosts and joint
user approval gate merge; this feature does not deploy.

## Optional inbound integrations

Free and Hosted companions can receive current Keet and Matrix events independently
of MCP tools. Intake uses immutable event receipts, receiver-owned trigger/buffer
policy, queued native execution and restart recovery. Initialize a Free companion
session, set `COMPANION_SESSION_ID`, and configure optional inbound-only
`CHAT_INTEGRATIONS`. Hosted intake uses trusted Platform forwarding to the owner's
existing Companion. Keet and Matrix receiving settings are independent of generic
`MCP_CONFIG`; Matrix supplies `selfUserId` directly. See
[independent inbound setup, policy, receipts and recovery](docs/inbound-integrations.md)
and [native Keet source restoration](docs/keet-source-restoration.md).

Deployment-owned remote MCP tools can be enabled per instance with an optional
backend secret; see [injected remote MCP](docs/injected-remote-mcp.md).

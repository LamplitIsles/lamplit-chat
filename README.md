# Lamplit Chat

This repository is the canonical chat core for the self-hosted Free edition and the hosted Lamplit application. It was seeded from `pi-on-cf/feat/free-plan` at e938b28. Both deployments build the same `src/` and `frontend/`; hosted mode adds instance-scoped routing, a Platform service binding for account-bound model settings, and host-only identity enforced by the public Platform Worker. The self-hosted entry below remains independent of a Lamplit account or Platform deployment.

A single-user, self-hosted Pi companion on Cloudflare Workers and SQLite-backed Durable Objects. The default deployment needs no Workers Paid subscription, Worker Loader, Containers, R2, AI Gateway, work machine, Forgejo, or hosted Lamplit account. Bring an OpenAI-compatible model API key. **This branch is a new-instance configuration; it does not migrate the author's production service.**

The Companion UI supports streaming chat, durable history and branching, steer and reconnect recovery, a relationship profile, read-only timed-wake arrangements and reminder sources, learned memory, FTS5 session search, and a Markdown workspace in each session. The agent can read, write, edit, list, find, and search workspace files. It cannot run generated JavaScript or shell, use Git, build/deploy apps, or preview apps. Workspace files use the `@cloudflare/computer` SQLite file API inside the session DO; no Loader is needed. The file tools enforce `/workspace` paths, a 128 KB per-file limit, and bounded search results. Model memory extraction uses the configured model API key.

The chat core pins `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` to
**0.99.1**. Offline compatibility checks load synthetic 0.87.1 committed writes
into test-owned Durable Object SQLite, append a message and reconstruct storage;
a fake OpenAI-compatible response exercises the existing harness's prompt,
timezone, tool declarations, image projection and reply persistence. This upgrade
adds no MCP, codemode, Bash, image generation or import capability. It does not
establish production provider performance or deploy either edition.

## Chat on mobile

The Companion uses a mist blue light theme and a coordinated blue grey dark theme. Theme (`light`, `dark`, or `system`) and Chinese/English preferences are stored locally using `her.companion.appearance` and `her.companion.language`. Hosted users configure them in the management App at `/settings`; the chat App opens at `/chat`. Both entries share the user's personal origin. The chat synchronizes preferences on storage events, focus and foreground return, without a manual refresh. Self-hosted users use the chat's Settings control.

Companion and user display names are persisted through `/api/display-names` and refreshed across the two entries; avatars and backgrounds use private UI assets. These names only affect display and greetings, not the personality file or system prompt. Basic hosted chat is free with BYOK; optional development environments remain planned and are not required for import, personality or memory management.

The composer has a text area above a right-aligned action row. **+** opens a bordered **Camera / Photo library** panel; **×**, Escape, choosing a source, or cancelling the chooser closes it without clearing text. Photos use the existing type, size, count, preview, removal, and upload checks. You can send images without a caption. Invalid selections and failed sends show feedback; rejected drafts and attachments remain available to retry. Chinese IME composition cannot submit, Enter sends, and Shift+Enter inserts a newline. The primary action stops an active reply when there is no new draft; with a draft, Send and a separate Stop remain available.

Click the microphone to stream recognition while speaking, then click Stop to flush and await final text. It remains available alongside Send when text already exists. Recognition inserts at the cursor or replaces selected text, preserves attachments, and never sends automatically. The draft is read-only during recording/recognition; Cancel or Escape preserves it. Cancel, tab hide, leaving the page, or changing sessions releases capture and discards late results. Cancellation before permission resolves never starts recording later. Space/Enter activate the focused button. Voice requires HTTPS (or localhost), microphone permission, AudioWorklet, and an actual 16kHz AudioContext.

Voice uses a separate Beijing-region Alibaba Model Studio key with the fixed `qwen-audio-3.1-asr-flash-streaming` WebSocket endpoint. Self-host operators set the **`VOICE_API_KEY` Worker secret** independently of the chat model key; hosted chat obtains current settings only from Platform. Capability refreshes on load, focus, and pageshow; every streaming connection resolves the current key again. See [voice setup, limits, privacy and isolated fixtures](docs/voice-input.md). The relay consumes the compiled `@lamplit/contracts/voice` package from adjacent `lamplit-app/packages/contracts`; `/api/voice/capability` alone advertises recording availability, with no competing voice flag in chat snapshots. Missing or failing capability leaves text chat usable. The shared browser inserts only finalized text into an editable draft after Finish; drafts above the shared chat's 16,000 UTF-16-unit send limit must be shortened before Send. The existing frontend remains available until parity. Spec #3044 is verified on an isolated Pi/workerd host using the frozen app build and fake speech; the #3043/#3044/#3045 cross-host merge gate remains pending, with CFL #3045 paused until Framework7 merges. No merge or deployment is part of this change.

In a PWA, Camera uses an image file input with `capture="environment"`. The browser/device decides whether this directly opens a camera or offers a chooser. The existing Capacitor camera is used only in a native context. Real Android camera, microphone, installation, and software-keyboard behavior have not been tested for this UI update; isolated Chromium component tests and screenshots cover 390×844, 320px and desktop layouts.

## Install and run locally

Use Node.js 24 or newer and npm. The root and `frontend/` have separate lockfiles.

```bash
npm ci
npm ci --prefix frontend
cp .env.example .env.free
# Edit .env.free with your model key and a random, unique AUTH_PASSWORD (at least 24 characters).
# Edit AI_MODEL and MODEL_BASE_URL in wrangler.jsonc for your provider.
cp .env.free .dev.vars
npm run build
npx wrangler dev --config wrangler.jsonc --local-protocol https
```

The base URL must be the provider's OpenAI-compatible API root, such as `https://api.openai.com/v1`; do not append `/chat/completions`. Choose a model that supports tool calls. Configure `MODEL_CONTEXT_WINDOW` and `MODEL_MAX_TOKENS` to match the model's actual limits. Set `AI_MEMORY_MODEL` to the same model or another model available at the same base URL and key. An image-capable model is needed only if optional photos are enabled.

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

Chat, memory and customization should belong to the user and remain portable. Import and complete export tools are under construction; free migration in and out is a product commitment. Phase 1 prioritizes migration and hosted mobile use; optional development assistants are Phase 2. The complete migration interface and transfer format need a dedicated design before implementation. This release does not provide a complete migration endpoint or tool. Conversation history and files remain durable within this instance.

The installable PWA includes a manifest, icons, standalone launch mode, and a versioned service worker. In a mobile browser, open the authenticated site and use **Add to Home Screen** from the browser menu. The worker caches only the app's static JavaScript/CSS, icons, manifest, and the generic HTML shell after a successful authenticated load; it never caches API, history, or image responses. Offline launch shows the shell and an offline state; chat needs network access. On reconnect or foreground return, the page refreshes session state. Service worker updates activate in the background. The app checks for new versions every 60 seconds and on foreground return, then reloads when visible, online and idle. It waits while a reply, draft, attachment, recording or relevant dialog is active. Hosted mode uses Platform's shared root service worker; the self-hosted shell behavior described here belongs to this repository.

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

Run local checks with `npm run check:frontend`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. On an explicitly authorized isolated Free account, verify: first session and two consecutive turns; close/reopen the browser during a turn; history and FTS query; Markdown write then read after reconnect; memory persistence; and anonymous HTTP and WebSocket rejection. Measure four timings separately: first page open, WebSocket connected, history visible, and model first response. Record network/location, cold or warm start, and sample count. Do not count model wait as page load. A Paid-account deployment does not establish Free compatibility.

The project, including its Companion frontend, is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution and [LICENSES/pi-on-cf-MIT.txt](LICENSES/pi-on-cf-MIT.txt) for the retained original pi-on-cf notice. The imported Codex for Love license remains in [frontend/LICENSE.codex-for-love](frontend/LICENSE.codex-for-love). Third-party dependencies retain their own licenses.

## History import backend

Authenticated `/api/history-import` and `/api/history-archives` accept normalized RikkaHub and DeepSeek conversation data and expose private, read-only archives. Archives and existing FTS become visible in the same PiRegistry SQLite commit. `session_search` finds plain text on all committed branches and identifies the source node; historical thoughts remain readable but are excluded from search. Import creates no runnable PiSession, changes no main context, executes no historical tools, restores no images/persona/memory/workspace, and makes no model calls.

See [the complete API contract](docs/history-import.md), [machine-readable schemas/types](src/shared/history-import.ts), and [fictional fixtures](src/server/fixtures/README.md). Request JSON is bounded to 1,000,000 UTF-8 bytes before parsing; nodes to 256,000 serialized bytes; conversations to 10,000 nodes / 64,000,000 normalized bytes. Batches allow longer conversations. The original ZIP's 30 MB check belongs to platform. First successful Rikka commit fixes the source assistant ID; identical exports deduplicate, new branches append, and content conflicts never overwrite committed history. Structured diagnostics contain controlled fields and hashed IDs, with no body/thought/settings/secrets/raw exceptions.

For isolated integration run `node scripts/history-import-local.mjs` (or add `--hosted` for the trusted platform service-header contract) and follow the contract's test setup. It uses a fresh temporary directory, fictional authentication and example.invalid model endpoints. Personal deployments use their existing AUTH_PASSWORD auth. Platform source parsing and management UI are delivered separately under Spec #2904; both PRs stay open until cross-repo Android acceptance. This backend change does not deploy either repository.

## Hosted mode

`wrangler.hosted.jsonc` deploys an internal `lamplit-chat` Worker with no public `workers.dev` or preview URL. The public `lamplit-platform` Worker verifies the personal hostname and session on each request, then sends the derived chat instance ID and personal session hash over a Service Binding. Chat maps each instance to its own `PiRegistry`, each session to an instance-prefixed `PiSession`, and R2 keys to an instance prefix. Every WebSocket RPC checks the personal session with Platform; logout also closes matching Registry and Session sockets. Chat obtains the current user's model configuration through a secret-protected internal Platform endpoint, including background memory extraction.

Hosted deployment uses the isolated `lamplit-chat-media` R2 bucket, the Platform Worker service, and the same high-entropy `CHAT_INTERNAL_SECRET` secret on both Workers. Build the frontend before deploying. In local development the Platform `--env local` Worker is named `lamplit-platform-local`, so a local-only copy of the hosted config must point its `PLATFORM` service there and set `PLATFORM_ORIGIN` to `http://app.localhost:8877`. The default `wrangler.jsonc` remains the independent self-hosted deployment. The hosted Worker was deployed on 2026-09-29 and has no public route; the personal-domain DNS is live, and one user has confirmed BYOK chat. Online two-user isolation and a stable startup baseline are still pending. Deployment status is tracked in `lamplit-platform/docs/deployment.md`.

The mist blue UI slice was verified with `npm run check:frontend`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`, plus an isolated browser mounting the real Companion with fake send/stop/transcription actions. No live user state, email, model provider, microphone, phone, or production deployment was used. Hosted identity and the two PWA entries remain owned by Platform: host-only sessions, chat `/chat`, management `/settings`, distinct manifest identities/scopes/start URLs, and the shared root service worker's network-only private-page behavior. This UI change does not deploy either repository or force an app refresh.

The chat page updates Android browser/PWA theme-color with its resolved light/dark/system theme so the system bar matches the header. The manifest uses the default mist-blue launch background. System time/battery/gesture bars remain browser-controlled; viewport-fit=cover and existing safe-area padding protect controls.

## Source repositories

The chat frontend and backend are open source at https://github.com/LamplitIsles/lamplit-chat; the public website lives at https://github.com/LamplitIsles/lamplit-site. Platform account management and the future hosted work machine are separate projects, outside this repository's open-source scope.

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
schemas come from `@lamplit/contracts` in the adjacent app; panel reads do not
start Agent turns. Images retain authenticated same-origin HTTP resources and
instance/session membership. Timed-wake input is shown as an application reminder;
the native 60-second lateness window and immutable admission receipts remain.

See [protocol, security, native scheduling and operator acceptance commands](docs/companion-panels.md).
Run `node scripts/companion-panels-local.mjs .scratch/companion-panels/acceptance`
with the reviewed adjacent app handoff for an isolated actual-workerd host on
port 8951. The guide includes native seeding and read-only browser verification at
390/1280 with synthetic model/ASR responses. The existing native frontend remains
available pending full shared-app parity.

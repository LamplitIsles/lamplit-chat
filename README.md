# Lamplit Chat

This repository is the canonical chat core for the self-hosted Free edition and the hosted Lamplit application. It was seeded from `pi-on-cf/feat/free-plan` at e938b28. Both deployments build the same `src/` and `frontend/`; hosted mode adds instance-scoped routing, a Platform service binding for account-bound model settings, and host-only identity enforced by the public Platform Worker. The self-hosted entry below remains independent of a Lamplit account or Platform deployment.

A single-user, self-hosted Pi companion on Cloudflare Workers and SQLite-backed Durable Objects. The default deployment needs no Workers Paid subscription, Worker Loader, Containers, R2, AI Gateway, work machine, Forgejo, or hosted Lamplit account. Bring an OpenAI-compatible model API key. **This branch is a new-instance configuration; it does not migrate the author's production service.**

The Companion UI supports streaming chat, durable history and branching, steer and reconnect recovery, a relationship profile, learned memory, FTS5 session search, and a Markdown workspace in each session. The agent can read, write, edit, list, find, and search workspace files. It cannot run generated JavaScript or shell, use Git, build/deploy apps, or preview apps. Workspace files use the `@cloudflare/computer` SQLite file API inside the session DO; no Loader is needed. The file tools enforce `/workspace` paths, a 128 KB per-file limit, and bounded search results. Model memory extraction uses the configured model API key.

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

The UI hides the photo picker, album, and interface image controls and explains that photo storage is unavailable when R2 is absent. To enable photos, first activate an R2 subscription in the target account, create a private bucket, and add a `COMPUTER_R2` R2 binding to a private copy of `wrangler.jsonc`; then regenerate types and deploy that copy. R2's included storage and operations are free up to its allowance, but Cloudflare requires an R2 subscription checkout to activate it. Full originals, previews, and model variants are stored in that private bucket. Avatar and chat background images use private R2 objects with metadata in Registry SQLite. Upload and remove them from the Images control; chat photos can be deleted with authenticated `DELETE /api/conversation-images/<session-id>/<photo-id>`. No public R2 URL or S3 credentials are required. Text chat, memory, Markdown, and FTS work without R2.

## Data portability

Complete backup, restore, and migration from hosted Lamplit to a self-hosted instance are planned for Phase 2. Their interface and transfer format need a dedicated design before implementation. This release does not provide a complete migration endpoint or tool. Conversation history and files remain durable within this instance.

The installable PWA includes a manifest, icons, standalone launch mode, and a versioned service worker. In a mobile browser, open the authenticated site and use **Add to Home Screen** from the browser menu. The worker caches only the app's static JavaScript/CSS, icons, manifest, and the generic HTML shell after a successful authenticated load; it never caches API, history, or image responses. Offline launch shows the shell and an offline state; chat needs network access. On reconnect or foreground return, the page refreshes session state. Service worker updates activate in the background; refresh the page when you want the newest version.

## Free-plan limits and verification

Official Cloudflare documentation checked 2026-09-29:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free has 100,000 entrance Worker requests/day and 10 ms CPU per HTTP request. Waiting on model `fetch()` is wall-clock time, not CPU. There is no fixed wall-time limit for a connected HTTP response, but disconnects can cancel work; Pi's durable admission/recovery handles lost connections.
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/): SQLite-backed DOs are available on Free. The Free allowance includes 100,000 DO requests/day, 13,000 GB-s active duration/day, 5 million SQLite rows read/day, 100,000 rows written/day, and 5 GB stored data total. Exceeding a Free allowance can make that operation fail. The DO limits page lists a default 30-second active CPU limit per invocation; confirm the effective behavior on the chosen Free account because the general Workers Free entrance limit is 10 ms.
- [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/): a DO may hibernate with an idle hibernatable WebSocket, but an in-progress request or awaited model fetch prevents hibernation. Model wait can therefore consume DO active-duration allowance. Test streaming and recovery on the target account.
- [R2 setup](https://developers.cloudflare.com/r2/get-started/) and [pricing](https://developers.cloudflare.com/r2/pricing/): optional photos require activating an R2 subscription; the standard storage free tier is 10 GB-month/month with included operations.

Run local checks with `npm run check:frontend`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. On an explicitly authorized isolated Free account, verify: first session and two consecutive turns; close/reopen the browser during a turn; history and FTS query; Markdown write then read after reconnect; memory persistence; and anonymous HTTP and WebSocket rejection. Measure four timings separately: first page open, WebSocket connected, history visible, and model first response. Record network/location, cold or warm start, and sample count. Do not count model wait as page load. A Paid-account deployment does not establish Free compatibility.

The root project is MIT licensed. Imported Codex for Love Companion frontend files retain Apache 2.0; see [frontend/LICENSE.codex-for-love](frontend/LICENSE.codex-for-love).

## Hosted mode

`wrangler.hosted.jsonc` deploys an internal `lamplit-chat` Worker with no public `workers.dev` or preview URL. The public `lamplit-platform` Worker verifies the personal hostname and session on each request, then sends the derived chat instance ID and personal session hash over a Service Binding. Chat maps each instance to its own `PiRegistry`, each session to an instance-prefixed `PiSession`, and R2 keys to an instance prefix. Every WebSocket RPC checks the personal session with Platform; logout also closes matching Registry and Session sockets. Chat obtains the current user's model configuration through a secret-protected internal Platform endpoint, including background memory extraction.

Hosted deployment uses the isolated `lamplit-chat-media` R2 bucket, the Platform Worker service, and the same high-entropy `CHAT_INTERNAL_SECRET` secret on both Workers. Build the frontend before deploying. In local development the Platform `--env local` Worker is named `lamplit-platform-local`, so a local-only copy of the hosted config must point its `PLATFORM` service there and set `PLATFORM_ORIGIN` to `http://app.localhost:8877`. The default `wrangler.jsonc` remains the independent self-hosted deployment. The hosted Worker was deployed on 2026-09-29 and has no public route; the personal-domain DNS is live, and one user has confirmed BYOK chat. Online two-user isolation and a stable startup baseline are still pending. Deployment status is tracked in `lamplit-platform/docs/deployment.md`.

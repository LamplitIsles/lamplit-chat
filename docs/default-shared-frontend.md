# Default shared frontend

Spec #3163 / tickets #3168 and #3169 switch both deployments directly to the
Framework7 App in adjacent `lamplit-app`. Standalone `/` and hosted `/chat` serve
identical HTML; `/assets/*` and `/icons/*` use root-relative URLs. There is no
`/slice` alias, legacy UI fallback, migration or cutover framework. Missing routes
and assets return 404. Native registry/domain, tools, import, storage, management
routes, instance authentication and SDK 0.99.1 export patch are retained.

Platform independently owns hosted manifests, service worker, auth and `/settings`.
The standalone manifest has `/` identity/start/scope; App registers no service worker.
Licenses remain in NOTICE, LICENSES and frontend/LICENSE.codex-for-love. Retained
frontend domain/client modules are runtime/test consumers, with no build or route
entry. No repository AGENTS.md exists; portable/host instructions govern this work.

## Build and checks, in order

Install and check the adjacent App with its Bun lockfile and documented workflow.
This repository uses npm/package-lock; `.npmrc` enables packed local dependencies.
Do not change the pinned native SDK or discard its export patch.

```sh
bun install --frozen-lockfile --cwd ../lamplit-app
bun run --cwd ../lamplit-app/packages/contracts build
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run build` builds adjacent App, and both Wrangler configs use its
`apps/web/build`. `npm run dev` builds that App then starts the personal Worker.
Builds for production are separate from the immutable reviewed acceptance artifact.
The old frontend package/build and wrangler.slice.jsonc are removed.

## Approved artifact and actual native acceptance

Use the Owner-approved App archive from frozen-d1e800e, source HEAD
`d1e800e72807d52ea14eed59d13a3cef6a43fd09`. Extract into this repository's
`.scratch/default-shared-frontend/artifact`; preserve the archive, identity.json,
owner-approval.json, manifests and all manifested browser/contracts/runner bytes.
Read the complete archived acceptance/docs/default-shared-frontend.md first.
Install contracts/package first, then acceptance with `bun install`; this archive
has no dependency locks. Locally generated locks/node_modules belong only to the
extraction; record their hashes/versions. No rebuild/refreeze is permitted.

```sh
mkdir -p .scratch/default-shared-frontend/artifact
# Substitute the received, Owner-approved archive path.
tar -xzf /path/to/lamplit-default-shared-frontend.tgz -C .scratch/default-shared-frontend/artifact
(cd .scratch/default-shared-frontend/artifact/contracts/package && bun install)
(cd .scratch/default-shared-frontend/artifact/acceptance && bun install)
# Use exact archived contracts in this repository-owned node_modules for the gate.
ln -sfn ../../.scratch/default-shared-frontend/artifact/contracts/package node_modules/@lamplit/contracts
node scripts/default-shared-artifacts.mjs
```

Start one native suite at a time, using a new test-owned fixture root each run:

```sh
node scripts/default-shared-local.mjs text
# Other choices: voice, images, compact, search. DEFAULT_FIXTURE_PORT defaults 8980.
PANELS_FIXTURE_PORT=8985 \
  node scripts/companion-panels-local.mjs .scratch/default-shared-frontend/panels-unique
curl -X POST http://127.0.0.1:8985/__fixture/seed
```

From extracted acceptance/, run the corresponding unchanged runner with absolute
URL/control/evidence paths and synthetic credentials. Text and voice controls
follow the archived exact handoff. All public methods reach real native adapters,
SQLite/FTS/workspace/R2 and the relay. Controls only seed test-owned state, observe
transport, or hold/fail fake upstream delivery. No browser product-route mock or
fabricated public result is used. Panels seed a future one-time reminder because
native admission rejects past times; other native schedule rules remain unchanged.

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:8980/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:8980/__test/text \
APP_ACCEPTANCE_USERNAME=owner APP_ACCEPTANCE_PASSWORD=fixture-password-long-enough \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence/text bun browser.mjs
```

Repeat for Owner-approved voice-browser-eca3279.mjs (`/__test/voice`), images-browser.mjs
(`/__test/image-send-recovery`), compact-browser.mjs (`/__test/quiet-compaction`),
search-browser.mjs (`/__test/conversation-search`) and panels-browser.mjs (no
control URL; seed first). All six run at 390/1280; image/compact retain 320px checks.
Run `bun route-lifecycle-browser.mjs` as the additional isolated lifecycle check.
Verify SOURCE_HEAD, archive/manifests and every listed file before/after all runs
with `node scripts/default-shared-artifacts.mjs` and `shasum -a 256` on the received
archive/manifests. Capture commands, exit codes, native fixture identity and screenshots.
Owner-approved voice replacement: source eca32794e90ba4f00c1895e3fc2125da57b3d973,
file `voice-browser-eca3279.mjs`, SHA256
`0eed2c7c66929cc8b5e86e55a010fda49d14a293dc3860fda8a0e0e0e1628fc0`.
Follow its separate HANDOFF.md, copying it beside the original in acceptance/;
keep the parent candidate and native idle image capability unchanged. Hash parent
and replacement before/after the complete native voice run.

`node scripts/default-shared-hosted-local.mjs` uses read-only reviewed Platform
HEAD d61c1c4244af43a63758d6b1e42c187bc9fce8b2 with test-owned D1/DO/R2 and synthetic
personal sessions. It maps loopback host/origin into a synthetic assigned personal
hostname before the actual gateway, retaining foreign origins. Run the frozen
text runner at `http://127.0.0.1:8986/chat`, control `/__test/text`, without Basic
credentials; reset seeds the native session cookie. This does not test Better Auth
login, real DNS/TLS or physical-device service-worker/install behavior. Bun 1.3.14
exposes a relative HTTP response URL that Playwright 1.63.0 cannot use for cookie
parsing. The recorded hosted run uses a test-owned preload normalizing only that
transport metadata; it changes no product routes, payloads or runner assertions.
The complete preload and exact hosted text/voice/media commands are in the local
implementation report; Node Playwright/browser and native auth are otherwise real.

## Owner deployment after review

Workers leave one PR open; they do not merge, deploy, release, modify live state,
providers, services/configuration, restart services or develop on the NUC.
Merging alone does not deploy. After joint review and approval, Owner builds and
runs the appropriate documented deployment:

```sh
npm run build
npx wrangler deploy --config wrangler.jsonc --secrets-file .env.free
# Hosted, with the existing approved service bindings/secrets:
npx wrangler deploy --config wrangler.hosted.jsonc
```

Real provider behavior, native phone camera/microphone, keyboard/safe-area,
installation/service-worker update and joint hosted/auth/media/voice/PWA live
acceptance remain Owner verification. Local fake upstream/Chromium passes do not
establish those outcomes or Free-account performance.

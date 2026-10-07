# Native Pi Keet text ingress

Spec #3410 restores the bounded text feed, durable queue, source association and
four native tools from `lamplit-cloudflare`. It uses the installed Pi 0.99.1 public
harness/lane/storage APIs and the existing serialized execution owner. It adds
feature-local SQLite tables; it neither imports old DO data nor changes SDK/runtime.

## Optional self-host setup

Ordinary chat requires no Keet settings. For a new self-host instance, initialize
a session through the authenticated chat first. Set `COMPANION_SESSION_ID` in the
private Worker configuration to that ready session's UUID. Set an independent
`KEET_INGEST_TOKEN` secret for event intake. Tools additionally require
`KEET_MCP_TOKEN` and an operator-selected `KEET_MCP_URL`: HTTPS, exact `/mcp`, with
no embedded credentials, query or fragment. No personal session, domain or secret
is supplied by this repository. Ingest and tool tokens never fall back to model
credentials or `AUTH_PASSWORD`.

`POST /api/keet/events` uses `Authorization: Bearer <KEET_INGEST_TOKEN>` instead of
browser Basic/cookie auth. Missing/wrong token returns 401. Missing, malformed or
uninitialized configured session returns 503 without creating that session. Other
methods return 405 after authorization. Requests are limited to 112 KiB while
streaming, including requests without Content-Length. Invalid frames return 400;
oversized bodies return 413; sequence gaps/conflicts return 409. A scheduling
failure returns retryable 503 after persistence; replay the identical event, never
renumber it to bypass reconciliation.

Hosted Keet ingress and tools are **not provisioned**. Existing internal-secret,
instance and personal-session isolation remains enforced. A trusted hosted event
request returns 503, and an untrusted request returns 403. There is no public
hosted webhook, global companion mapping, credential onboarding or Platform UI.

## Event and durable behavior

The authoritative bounded envelope is `KeetFrame` in
[`keet-feed.ts`](../src/server/keet-feed.ts). It contains a UUID `eventId`, positive
sequential `sequence`, native `{deviceId, seq}` message identity, integer timestamp,
`destination: {kind: 'dm'|'group'|'broadcast', groupName}`, `senderLabel`, original
`text`, and optional trigger/reply/image/reaction metadata. Labels are nonblank,
single-line and at most 512 Unicode code points; text is at most 16,000. Up to 16
image descriptors and 16 bounded reaction-context items are accepted. DMs require
`trigger: 'dm'`; groups may trigger on mention, label or reply. Broadcasts never
trigger conversational turns.

An exact replay at a stored sequence returns the current checkpoint without a
second admission. Changed data at that sequence, a reused event identity at a
new sequence, and a sequence gap are rejected. Ordinary group messages retain the
last eight context snippets (500 UTF-16 units each) per destination. The next
trigger consumes that context; broadcast events only advance the checkpoint.

Triggers queue FIFO behind active web/native work. Queue operation identities are
durable. Restart repairs entry association from Pi's operation metadata and resumes
accepted native work; a terminal result settles without re-admission. Source
association and queue acknowledgement are one SQLite transaction. Native input
and reminder inbox work retain the existing lane behavior.

Pi does not materialize Keet images. Incoming image descriptors retain the original
text plus `[Keet image unavailable in this Pi companion.]`, including image-only
triggered input. No Keet image bytes are downloaded, attached from web photo storage,
or served. Existing ordinary web images keep their current behavior.

## Public display and model attribution

Native user entries store visible text. Backend source tables store attribution,
message identity, group/reaction context and private provider prompt separately.
The provider projection restores the prior Keet DM/Group attribution and authority
rules; neither source inherits the web Human's administrative authority. A native
message's admission timestamp still receives existing host-turn-time projection.
Compaction (including split-turn prefixes), branch summaries and memory extraction
also restore the persisted attribution before provider requests. Memory uses exact
entry IDs; maintenance leaves original stored display text unchanged.

The shared adapter emits only `{kind:'keet', channel:'dm'|'group', senderLabel,
destination}` and original visible text. Private context never enters chat views,
reconnect reads, paginated history, search records or submission DTOs. Ordinary
web input and agent replies retain their existing roles; reminder sources remain
unchanged. Shared contracts/rendering are owned by `lamplit-app`.

## Four optional native tools

Configured self-host harnesses expose `keet_list_destinations`,
`keet_list_members`, `keet_read_recent_messages` and `keet_send_message`. They use
the existing MCP Streamable HTTP client already selected by the project dependency
graph, registered through the current native tool seam. Before any named operation,
the client checks the exact destination against the remote admitted list. Reads
accept 1–50 recent messages. Send requires text (up to 16,000), with the existing
reply, exact-member mention and single reaction fields. Tools are sequential and
never automatically reply to an incoming destination. A lost send response reports
an uncertain outcome and disables automatic transport reconnection/retry; it may
already have delivered. Explicit remote tool errors remain errors. Tokens stay in
server-side headers; redirects are refused.

## Isolated verification and frozen App gate

Run `npm run lint`, `npm run typecheck`, `npm test`. Workerd tests cover ingress
auth/session/hosted boundaries, conflicts/gaps/duplicates, group/broadcast context,
held native work, source persistence/reconstruction and lost-ack/start recovery,
actual shared sockets, private provider projection, unavailable images, configured
native tool execution and disabled tools. Unit tests use owned fake MCP HTTP.
No live chat/gallery, credentials, provider or Keet service is used.

The approved original archive is App HEAD
`09bf71009ff931cfdc75c675d9b16037bbb1d881`, SHA-256
`c7219de5bf1596af8b27de3da38e3e75d375c7b8e7a9a975d822690a1aef31c2`.
Extract it to `.scratch/keet-source-restoration/artifact`, install with
`bun install --frozen-lockfile` in `contracts/package`, then `acceptance`. After
`npm ci`, copy the extracted contract package's `dist`, `LICENSE`, `package.json`
and `bun.lock` into `node_modules/@lamplit/contracts`. Do not build/refreeze App or
contracts. `scripts/keet-source-restoration-artifacts.mjs` checks all 307 manifest
files, archive/manifest identities and installed contract bytes.

Start `node scripts/keet-source-restoration-local.mjs` for an actual isolated
workerd on port 8985 with fresh scratch SQLite/R2 and fake model transport. Controls
use the real webhook, native lane, persistence and shared socket; acknowledgements
await native completion and shared publication. Reset selects a new owned session
and seeds the fixed historical group and DM through real ingress, then 16 ordinary native
turns; the runner's history controls replay the identical historical events. This
places it behind the current page without fabricating source DTOs or storage.

The original frozen runner's Group-image assertion is superseded by the Orc's
approved runner-only correction at `7061b0972266ef1a525ff9430278cde2384ea1e1`.
Correction archive SHA-256:
`effb16db242eaa7686623bf07cb1469919c91d79340528ba9fe44422078e3c42`;
runner SHA-256 `d9d2f05eb051dcda9a5334ab706f5edae0c7dbb2035753d62f7f0fe0a800a7eb`.
Extract its `runner/` alongside the unchanged original `acceptance/` and install
with `bun install --frozen-lockfile`; keep `runner.sha256` in owned
`.scratch/keet-source-restoration/runner-correction/`. The verifier's
`verifyCorrectedKeetRunner()` additionally checks all 11 correction files and the
identical inherited Bun lock. No original artifact is overwritten.

From `.scratch/keet-source-restoration/artifact/runner/`, run:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:8985/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:8985/__test/keet-source-restoration \
APP_ACCEPTANCE_KEET_IMAGE_PROFILE=text-only \
APP_ACCEPTANCE_EVIDENCE=../../browser bun keet-browser.mjs
```

This passes on actual workerd at 390/1280/320px in light/dark with DM/Group original
text and native unavailable notes, safe Markdown/literal hostile labels, ordinary
composer/reply and reminder, reload/reconnect without replay and paginated native
history. Six screenshots and results are owned scratch artifacts. The fixture
bootstraps real native Basic-to-cookie auth only on its loopback HTML entry and
removes Secure solely for test HTTP; other native routes retain cookie/bearer
checks. The corrected runner receives the actual persisted image explanation.
Pi claims no Keet image-byte coverage; final joint acceptance belongs to Orc.
No live credentials, provider/Keet calls, migration, merge or deployment is implied.

`npm run build` ordinarily builds adjacent App and must not run during this frozen
gate. Bundle the native Worker using Wrangler `deploy --dry-run` with an owned copy
of `wrangler.jsonc`, absolute native entry, frozen browser assets and owned output/
config/log directories. This verifies native bundling without rebuilding App or
contacting a deployment. Repository AGENTS.md is absent; user/host instructions
remain applicable. Retained attribution is in `NOTICE`.

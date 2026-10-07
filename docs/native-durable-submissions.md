# Native durable submissions (#3436)

Lamplit Chat uses the public `@earendil-works/pi-durable` 1.0.4 engine and
`@earendil-works/pi-ai` 1.0.4 provider factories through Cloudflare Agents 0.26.0
`PiHarness` (public beta). Chord 1.0.4 supplies the native invocation context.
The Worker runs directly in workerd with SQLite-backed Durable Objects. It needs
no Worker Loader, container, patched SDK, private package import or second engine.

## Submission and reply

The approved App contract is `lamplit.chat.v2`, ChatView version 2, transport
version 1, on the existing `/api/chat/socket`. `Submission` carries a UUID
`operationId`, immutable text, ordered image references and optional ordered
`replacementSourceIds`. `submit` returns a receipt with state `submitted` or
`failed`; `lookup` returns that receipt or null. A submitted receipt proves
admission, independently of whether the companion replies, fails or stops.
Null is ambiguous and never permits automatic replay or draft recovery.

At authenticated ingress, Chat compares immutable content before invoking native
submission. The same ID/content returns the original receipt. Changed text, image
metadata/order or replacement IDs reject before another execution. Native Pi's
requestId lookup itself deduplicates identity; it does not reject payload mismatch.
The host guard supplies that content check. The existing domain association stores
original input/media/replacement identity because a withdrawn queued native record
has no content. Native records own task, queue and execution state.

Active input uses native steer; idle input starts native generation. Native stop
aborts the selected reply. A queued input withdrawn before placement retains its
submitted receipt and original admitted bubble; confirmed original text/images
can appear in `InputRecovery`. A reply failure or stop creates a separate notice
and does not restore input. Recovery has no delivery-state field. Editing uses a
fresh operation and newly uploaded images; accepted replacement retires the source.
Every reuse reconciles native admission before testing replacement eligibility.

## Domain continuity

PiRegistry metadata, learned memory, relationships, archive/search, session files,
diary, media bindings, account/auth isolation and Keet/wake domain associations
remain in their existing stores. Tools register through public `ToolRegistration`.
Reads may opt into safe replay; mutations default to unsafe. Existing feedback
submission keys are receipts for their narrow remote operation. A safe native
replay receipt can avoid repeating an acknowledged effect; this establishes no
general exactly-once guarantee for external services.

All 37 supported providers retain native model metadata and account/provider key
isolation. Ambient credential environment/file fallback is disabled. A running
task keeps its opened provider/key/options; idle work resolves current settings.
Compaction and memory use current selected model configuration. Images require
native model image support and R2; existing domain media remains readable after
switching models. See [provider selection](provider-model-catalog.md).

Native compaction chooses and persists its range/checkpoint. Chat supplies the
companion continuity policy and private Keet projection, including the split-turn
prefix. Manual `/compact` reserves no work when busy and rechecks its captured
socket after asynchronous preparation. Automatic and manual observations use
actual native task/checkpoint records. Summaries stay out of the timeline. Active
usage reads public native ContextView: fresh valid assistant usage plus a bounded
host estimate of later text; it excludes pre-checkpoint usage and cumulative
billing. Unknown/post-compaction tokens display zero while capacity is retained.

Keet stores display text and private model attribution separately. Generation,
compaction and memory project the latter by native entry association. Display,
search, panels and recovery never expose private group context. Historical branch
summaries stay readable; tree navigation, fork/clone and summary-generation APIs
are removed because the product has no interface for them.

Wake schedules advance before model work. A minimal pending occurrence association
bridges schedule advancement and native requestId admission. Restart reconciles
that same occurrence identity rather than creating another input. Agents owns the
alarm and PiHarness resumes native tasks; provider preparation waits for schedule
reconciliation. Sources remain explainable in historical reads. Lateness permits
60 seconds and skips later unaccepted occurrences without catchup.

## Existing-data conversion

Conversion is a one-time public native root initializer, not an old engine fallback.
It keeps original `pi_v4_writes` bytes and archives all source records/IDs, including
historical alternate paths. The saved main tip selects active context. Deployed
0.99 compactions contribute the original summary and `retainedTail`; failed,
aborted and deferred assistant messages do not enter model context. A native
checkpoint preserves that tail, then following main-path messages continue it.
Historical branch summaries contribute context without creating branch execution.
Existing accepted operation/photo associations retain original entry IDs. Workspace,
R2 keys, registry data, memories and relationship tables are not rewritten.
Accepted Keet rows with their original source entry and matching terminal `pi.result`
(completed/failed/aborted prompt) are settled atomically during conversion, preserving
the completed-before-settle window without replay. Pending rows and all source IDs
remain intact. An accepted row without that proof refuses conversion before writes;
explicitly drain it on the old version and verify the saved queue before retrying.

Operators must first back up a consistent session SQLite snapshot, registry data,
workspace and referenced R2 variants. Finish or explicitly cancel old active work
and empty its inbox on the old version, then verify idle state before conversion.
The new version refuses an interrupted old lane, missing source path, cycle,
missing compaction tail or unsupported stored message role. Diagnose using a copy;
never delete source data or force a partial conversion. The initializer commits
native history and conversion marker atomically in the owning SQLite transaction.
A failure requires restoring/retaining the backup and correcting the source or
conversion issue before another attempt. Do not operate both engines concurrently.

The conversion executes automatically when the new public harness first opens
its root. It is not an operator RPC or a second engine. Before that first open,
inspect the backup copy with these read-only SQLite queries (not a live service):

```sql
SELECT json_extract(data,'$.value') AS old_lane
FROM pi_v4_writes
WHERE json_extract(data,'$.kind')='value'
  AND json_extract(data,'$.namespace')='pi.lane.state'
  AND json_extract(data,'$.key')='main'
ORDER BY seq DESC LIMIT 1;
SELECT count(*) AS source_writes FROM pi_v4_writes;
SELECT count(*) AS photos FROM conversation_photos;
SELECT operation_id, entry_id FROM pi_prompt_submissions;
SELECT sequence, operation_id, entry_id, state FROM keet_queue ORDER BY sequence;
```

The last lane value must have no `currentOperationId` and an empty `inbox`.
Preserve a consistent storage snapshot with workspace/domain tables and all
referenced R2 variants; a SQL record count alone is not a backup. This repository
does not add a production snapshot/export API. Use the deployment operator's
existing backup/restore procedure before cutover, validate restoration in an
isolated replica, then start the new version only after that procedure succeeds.
For the committed test-owned deployed-format replica, run
`npx vitest run --config vitest.worker.config.ts src/server/pi-upgrade.worker.test.ts`.
After opening the new root, check `pi_session_settings` key `nativeConversion`
and `conversation_archive` source IDs, then reopen and repeat read verification.

Verify conversion only in a test-owned replica first: raw-write equality, active
summary/tail, source and operation IDs, image ordering/variants, archive/search,
workspace bytes, memories, relationships, schedules and Keet checkpoints. Reopen
and verify no historic provider/tool execution. Local tests do not migrate a real
account or establish production cutover readiness. Deployment and backup/restore
operations belong to the operator after Orc review.

A modern submission keeps the public timeline row ID `submission:<operationId>`
from queue publication through placement. Its native entry/source ID stays in the
archive and media/search associations. Converted old rows keep their original IDs.

## Approved App identity and local acceptance

App #3439 HEAD `3aaa48a384549f72cc417a6cb3e6108fe0999b37` / PR 16 is the approved
backend handoff. Archive SHA-256 is
`a921c9d47f041cf6978653c5af6cda5d65a28e6cde3ceb5e91b0ecb5a5c301d1`.
`vendor/app-identity.json` pins its three manifests. The packed contract dependency
contains unchanged approved files. `npm run build` verifies archive, SOURCE_HEAD
and all 326 manifested files, then copies the approved browser into owned scratch
assets. It never reads/builds the adjacent moving App checkout.

Extract the approved archive into an empty test-owned directory. Verify all
manifested bytes before and after acceptance. Install contracts/package first,
then acceptance, using an owned Bun cache as the archived guide requires. Local
node_modules/lockfiles are auxiliary evidence. Do not edit App, contracts or runners.
An actual contract conflict requires an App-owned repair and a new Orc approval.

```sh
npm ci
npm run lint
npm run typecheck
npm test
LAMPLIT_APP_ARTIFACT=/absolute/approved/lamplit-native-durable-submissions.tgz npm run build
node scripts/native-durable-local.mjs
node scripts/native-submissions-local.mjs
```

The runtime-only first gate records public versions, bundle hash, restart/alarm
replay and safe/unsafe tool behavior. The submission host runs at loopback 8991
(`NATIVE_FIXTURE_PORT` can change it), with fresh owned SQLite/R2/config/log/cache
state and a fake external model. Its controls hold actual acknowledgement or socket
publication, withdraw actual queued native input and finish/fail fake responses.
They do not fabricate public receipts, views or native engine records.

From extracted acceptance, run the unchanged approved runner:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:8991/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:8991/__test/submissions \
APP_ACCEPTANCE_USERNAME=owner \
APP_ACCEPTANCE_PASSWORD=fixture-password-long-enough \
APP_ACCEPTANCE_ASSETS=/absolute/extracted/browser \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence \
bun optimistic-send-browser.mjs
```

The same approved affected-surface regressions remain required. Choose `images`,
`voice`, `search`, `keet` or `compact` after the native host command and use their
archived runner/control URL. The Keet fixture advertises the runner's supported
`APP_ACCEPTANCE_KEET_IMAGE_PROFILE=text-only` profile. Panels use
`scripts/companion-panels-local.mjs` and unchanged `panels-browser.mjs`.

On Bun 1.3.14, Playwright's API response transport can expose a relative
`IncomingMessage.url`, preventing cookie processing during `route.fetch`.
The local evidence records a test-owned node:http preload that normalizes this
transport URL to the request's absolute URL; it changes no payloads, routes,
assertions or approved files. Include its identity with affected image/panel runs.

The same approved affected-surface regressions remain required. Evidence identifies
native bundle/HEAD, App archive/contracts/runner and owned store. Local Chromium,
fake-provider and replica passes do not establish paid provider behavior, physical
camera/microphone/PWA behavior, production migration or a joint native PASS.
Orc owns joint native acceptance, lifecycle and merge. This work performs no merge,
deployment, live migration or production service operation.

# Shared image sending and submitted-input recovery

Spec #3097 adapts the reviewed app #3096 protocol to the existing Pi/workerd host.
The public contract remains owned by `@lamplit/contracts`; the native frontend and
its private RPC/photo routes remain available pending full shared-app coverage.

## HTTP and native storage

Authenticated same-origin `POST /api/chat/images` accepts JSON with `sessionId`,
UUID `operationId`, and ordered `images`: public `id`, contiguous `order`, `name`,
`mediaType`, and base64 `original`, `preview`, `model`. Its result carries the same
session/operation and ordered `ImageRef` metadata (`attachmentId`, name, mediaType,
availability). Public IDs bind deterministically to operation-specific native
UUIDs, preserving retry identity without bypassing native `uploadPhoto`.

Pi advertises media availability from `COMPUTER_R2`: PNG/JPEG/WebP/GIF, six images,
8,000,000 original bytes each and 24,000,000 original bytes per operation. The
common reader bounds streamed JSON to 36,000,000 UTF-8 bytes before parsing;
common validation and native decoded signature checks both apply. Preview/model
JPEG caps remain 160,000/320,000 bytes. The native 1,500,000-character serialized
message budget also applies. No decoder dependency or R2 provisioning is added.

The native ledger reserves immutable upload metadata/fingerprint before R2 writes
and marks a photo ready only after every variant succeeds. Identical interrupted
uploads can finish; changed bytes, names, IDs or ordering conflict. Upload alone
neither admits a message nor creates album membership. Shared submission checks
all ready variants and operation ownership before passing photo IDs to native
`prompt`/`submitSteer` and `modelPhotos`.

Authenticated `GET /api/chat/media/{attachmentId}/{original|preview|model}` reads
only the current owner's selected session. The ledger must prove native message
membership or a recorded native/shared input operation; opaque ID knowledge is
insufficient. Missing/incomplete objects return 404. Original reads have a finite
32 MiB ceiling independent of new-input intake; preview/model caps remain unchanged.
Responses use `no-store` and `nosniff`. Hosted requests require existing trusted
instance/session headers and revalidate the personal session at the DO storage
boundary, including after asynchronous reads. WebSocket prompt/steer revalidate the current
submitting connection after model/harness preparation, before native admission.
Self-host requests retain native
password authentication. New-intake unavailability leaves text and voice usable.

## Admission and recovery

`/api/chat/socket` uses immutable `Submission`: UUID operation ID, text, ordered
image refs and optional `replacementSourceIds`. Exact repeated payloads reconcile
before eligibility checks and never execute again; changed text, image metadata,
order or replacement identities conflict. Recent and paginated history project
native photo-entry membership, including image-only human/agent messages. Album
provenance derives from the actual native entry role.

A shared envelope is not native admission proof. Receipts use native exact entry
correlation and durable consumption, with missing native proof reported uncertain.
Native storage snapshots the original submitted text and ordered photo metadata.
Deletion preserves recovery identity with missing availability. Valid native names
over 200 characters use an ellipsis within the public display cap; native names,
IDs and stored image bytes retain their original values. At the main
lane's commit boundary it records cancellation only when a known human inbox entry
is deleted without becoming a committed message in that transaction. Queueing,
turn end and socket loss never imply non-consumption. This also covers inputs
submitted through the retained native frontend.

`view.recovery` exposes at most 20 source/operation identities, text, image refs,
state (`rejected`, `unconsumed`, `uncertain`) and replacement eligibility. Only
explicit pre-admission rejection or proven dropped input is eligible. Consumed or
replaced sources disappear permanently. Edited resend uses a fresh operation and
fresh normal upload bindings; it cannot reuse another operation's photos. Native
storage validates replacement eligibility and marks sources replaced in the same
transaction as harness admission, before execution. A same-operation retry can
still reconcile after its source has been replaced.

Restoring reads authorized originals. A missing original preserves editable text
and requires explicit removal/replacement before send. Dismiss/clear/discard are
page-local app behavior and do not consume native input. Uncertain input never
blindly replays. Unsent draft persistence is outside this contract.

## Isolated verification

Use only the Owner-approved `artifacts-review2` handoff. Browser/contracts retain
product HEAD `ebde803fb955349c8bd05de259f13ca14b63f668`; runner source is
`091c0def66abdb45728906785e6defd55c60d50c`, archive SHA256
`a755b0d535b8a5c6075ae64efbf85ec3775a26892c0a765052ff08e7e98ee5cc`.
Owner approval is recorded in spec #3097; preserve immutable identity.json even
though its freeze-time review field says pending. Extract into this repository's
`.scratch/image-send-recovery/review2/{browser,contracts,acceptance}`. Verify `identity.json`
archive/manifest hashes and every extracted file manifest before dependency installs.
Install runtime dependencies without building contracts or browser:

```sh
npm install --ignore-scripts --prefix .scratch/image-send-recovery/review2/contracts/package
npm install --ignore-scripts --install-links --prefix .scratch/image-send-recovery/review2/acceptance
npm install --no-save --package-lock=false --ignore-scripts --install-links \
  ./.scratch/image-send-recovery/review2/contracts/package
cp -R .scratch/image-send-recovery/review2/browser/. .scratch/image-send-recovery/browser/
# Full product validation (already reviewed product need not repeat for runner-only changes):
npm run typecheck
npm run lint
npm test
node scripts/image-send-recovery-local.mjs .scratch/image-send-recovery/native-FRESH
```

The fixture serves the extracted browser at `/slice/` on isolated port 8973
(`IMAGE_FIXTURE_PORT` overrides it), real workerd/DO/SQLite/R2 with a synthetic
OpenAI-compatible model and voice provider. It reads no repository credentials;
config/cache/logs/state/registry belong to the specified scratch root. Its control
endpoint exists only in `scripts/fixtures/image-send-recovery.ts`, never the
production entry. It drives native admission/cancellation, seeds native-origin
sources cumulatively, simulates rejection/uncertainty/storage failure/disabled
intake, finishes fake execution, seeds paginated history/agent membership and
reports actual submissions, recovery, messages, album and model requests. Fixture
cookies omit Secure only on this isolated local HTTP server; production cookies
retain their HTTPS transport requirement.

In another terminal, run the unmodified archived acceptance:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:8973/slice/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:8973/__test/image-send-recovery \
APP_ACCEPTANCE_EVIDENCE="$PWD/.scratch/image-send-recovery/review2/evidence" \
APP_ACCEPTANCE_USERNAME=owner \
APP_ACCEPTANCE_PASSWORD=fixture-password-long-enough \
  node .scratch/image-send-recovery/review2/acceptance/images-browser.mjs
node .scratch/image-send-recovery/review2/acceptance/route-lifecycle-browser.mjs
```

Chrome must be installed. The runner checks fixed semantic assertions and actual
advertised numeric limits at 390/1280/320. Existing native text/voice/panel tests
remain required; no paid provider, live home/config, external messages, deployment
or release is involved. Implementation reports and evidence remain untracked under
`.scratch/image-send-recovery`; Owner review/joint acceptance and merge are separate.
Run `bun scripts/image-send-recovery-regressions.mjs` against the same fixture
after image acceptance for retained text/reconnect, streaming voice with explicit
send, and all four native panels at 390/1280. Its synthetic seeding remains test-only.

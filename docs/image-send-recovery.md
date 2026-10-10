# Shared image sending and submitted-input recovery

Spec #3436 consumes the approved App #3439 v2 submission contract through public native Pi/workerd.
The public contract remains owned by `@lamplit/contracts`; the shared App is the
only frontend. Native RPC/photo routes remain available for management and tools.

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
public native submit and `modelPhotos`.

Authenticated `GET /api/chat/media/{attachmentId}/{original|preview|model}` reads
only the current owner's selected session. The ledger must prove native message
membership or a recorded native/shared input operation; opaque ID knowledge is
insufficient. Missing/incomplete objects return 404. Original reads have a finite
32 MiB ceiling independent of new-input intake; preview/model caps remain unchanged.
Responses use `no-store` and `nosniff`. Hosted requests require existing trusted
instance/session headers and revalidate the personal session at the DO storage
boundary, including after asynchronous reads. WebSocket submission revalidate the current
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

Public receipts are `submitted` or `failed`; lookup is that receipt or null.
Submitted means durable native admission, independently of reply outcome. Null
never permits recovery or automatic replay. Exact native request identity supplies
admission proof; the host guard compares immutable content before execution. Native
queued withdrawal may remove content from the engine record, so the existing domain
association preserves original text and ordered public image metadata.

`view.recovery` carries at most 20 confirmed source/operation identities, text,
image refs and replacement eligibility, without a delivery state. Only definite
pre-admission refusal or proven native withdrawal before placement is eligible.
Reply failure/stop creates a notice and never recovers input. Replacement uses a
fresh operation/upload binding and retires the old source after native admission;
repeated original payloads reconcile before eligibility checks. Native records
own task/queue state; the domain association does not duplicate an engine ledger.
Deletion retains immutable recovery metadata with missing availability. Native
names over 200 characters are abbreviated for display while original names, IDs
and bytes stay unchanged. Ordered refs and replacement IDs are part of the guard.

Restoring reads authorized originals. A missing original preserves editable text
and requires explicit removal/replacement before send. Dismiss/clear/discard are
page-local app behavior and do not consume native input. Uncertain input never
blindly replays. Unsent draft persistence is outside this contract.

## Isolated verification

The current immutable App #3439 handoff and actual native acceptance recipe are in
[native durable submissions](native-durable-submissions.md). The unchanged approved
submission runner covers text/images, slow/lost acknowledgement, publication order,
null lookup, explicit refusal, recovery editing, withdrawal, failure and stop on
real workerd/SQLite/socket. Image and affected domain regressions remain required.
All fixture R2, configuration and credentials are test-owned; no real account is
migrated. Orc owns joint native acceptance and later merge/deployment.

Settled ordinary input bodies are retired from admission storage after proven
native placement; immutable fingerprints retain changed-content rejection.
Unplaced, refused and withdrawn originals remain available for recovery. History
and album membership resolve the actual native/source entry with target-only
photo associations. [ADR #3646](native-durable-submissions.md#accepted-adr-3646)
defines the native history boundary and external public-source privacy checks.

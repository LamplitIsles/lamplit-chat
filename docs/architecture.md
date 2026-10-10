# Lamplit Chat architecture

The same Worker serves independent self-hosted and instance-scoped hosted Chat.
`src/server.ts` routes authenticated native Agent RPC, the shared v2 socket,
private photos, companion materials, archive import/search and bounded tools.
The assets binding serves the approved immutable Framework7 App. Platform supplies
hosted identity and account/provider model settings; self-hosting remains independent.

## Ownership and native execution

PiRegistry owns session discovery, original imported archives, FTS search, learned
memory and relationships. A PiSession owns domain metadata, workspace, media and
external-source associations. Public Pi Durable 1.0.4 owns its native conversation,
submissions/tasks, compaction, queue and execution state in SQLite. Agents 0.26.0
PiHarness integrates native recovery with Durable Object lifecycle/alarm scheduling.
There is no Loader/container or old engine fallback. Original records remain a
readable archive; the product exposes no tree navigation, fork/clone or branch
summary generation. [Native runtime and conversion](native-durable-submissions.md)
defines exact package and App identities, data handling and verification.
History pages query native records before presentation, with a frozen boundary and
opaque continuation; metadata references support bounded incremental consumers.
Original archive-only sources remain readable without a current transcript mirror.

The authenticated host compares immutable submission content before native admission.
Native requestId deduplication proves reuse, rather than content equality. Domain
associations retain necessary text/images/replacement identities missing from withdrawn queued
native records. Receipts distinguish submitted input and definite failed admission;
null means uncertain lookup. Native reply success/failure/stop is independent.
Reconnect reads persisted native state and does not replay ambiguous input.

Each opened runtime resolves one account/provider key into a fresh native credential
store with ambient env/file fallback disabled. Running native tasks retain their
configuration; safe idle work resolves current settings. The native 37-provider
catalog, thinking and output-cap rules apply to replies, compaction and memory.
Computer provides bounded SQLite workspace file tools; no shell, generated code,
Git, application build or deployment tool is registered.

## Original domain and external sources

Imported archives commit immutable source-role/node and FTS data together in the
registry, outside runnable sessions. Authenticated read-only search preserves all
historical source IDs and parent context without switching active execution.
Companion files and dated diary reads retain workspace bounds, CAS versions and
symlink/path protections. Panels read existing registry/domain sources and do not
start turns.

Photo upload reserves immutable metadata before private R2 writes and becomes ready
only after original/preview/model variants complete. Submission freezes ordered
photo IDs; native placement correlates them to the original domain entry identity.
Uploads alone are excluded from the album. The socket strips model bytes from
visible messages; authenticated HTTP serves bounded variants by owner/session
membership. Missing originals remain explainable. New image input requires R2 and
native model image support; existing media stays readable after switching models.

Keet FIFO/checkpoints/source tables remain domain data, including the immutable
original public body. Future native entries hold frozen private external prompts;
exact operation/request placement binds their public source facts. History, search
and panels read public source data and fail closed if association is unresolved.
Old native models stay unchanged under the user-accepted old-context limitation.
See [accepted ADR #3646 and history boundary](native-durable-submissions.md#accepted-adr-3646).
Optional MCP tools retain destination authorization, independent credentials and
uncertain-send rules. No automatic external exactly-once promise is introduced.

Timed-wake arrangements retain Croner zones/DST/anchors and Agents Date schedules.
Occurrences advance and future registration completes before model execution.
A pending domain occurrence association bridges advancement and native admission;
restart reconciles its stable requestId. Native Pi owns accepted execution recovery.
Unaccepted occurrences more than 60 seconds late skip without catchup. Historical
source metadata records the trigger rather than successful completion of its task.

## Browser and hosted boundary

The approved App owns composer, optimistic sending/sent/failed records, explicit
recovery editing, panels, appearance and route lifecycle. The Worker consumes
`@lamplit/contracts`, `lamplit.chat.v2`, ChatView v2 and transport v1 at
`/api/chat/socket`. Hosted calls/delivery revalidate Platform personal-session tokens;
self-hosting requires the existing password/cookie boundary. No other instance's
registry, credential, media or session can be selected by a public DTO.

Voice keeps its independent fixed Beijing ASR relay, key/config lookup, matching
task identity, bounded PCM/transcript/queues and cancellation/finish deadlines.
Recognition never submits automatically or stores audio; it inserts text through
App's explicit composer behavior. App owns camera, keyboard, safe-area, language,
appearance and PWA behavior. Local browser emulation does not prove physical-device
or production service behavior.

## Maintenance and verification

Native compaction selects and persists its own range/checkpoint; a companion policy
replaces coding-oriented summarization, preserving previous summary, split prefix,
file hints and private source projection. Summaries remain silent in the timeline.
The capacity meter reads actual active ContextView and native selected model metadata,
excluding pre-checkpoint usage, other conversations and cumulative billing.
Unknown usage displays zero until a fresh valid assistant observation.

The repository gates are lint, TypeScript, unit/workerd tests, immutable App build
and actual native/browser acceptance. All fixture state/config/cache/logs belong
under test-owned scratch, with fake external services. Native bundle, reviewed HEAD,
App contracts/runner and evidence hashes identify each result. Operators own backup,
idle old-data conversion and later deployment after Orc review; local work performs
no production migration, merge or deploy. Orc joint native acceptance remains a
separate requirement from local passes.

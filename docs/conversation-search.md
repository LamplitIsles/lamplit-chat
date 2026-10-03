# Shared conversation search · spec #3143

The authenticated shared App exposes `lamplit.chat.v1.search({query})` and
`searchRead({id})` through `/api/chat/socket`. Schemas and transport validation
come from `@lamplit/contracts`; the App owns the Framework7 card and reader UI.
These reads use the current instance's PiRegistry, without navigating, resuming,
changing the active branch or submitting a draft. The native frontend remains
available. This feature does not deploy either edition.

## Native search and reader

Queries are trimmed, nonblank, and at most 500 characters. Pi uses its existing
FTS5 quoted-term/phrase matching and Han segmentation. Shared queries always use
FTS, including literal `re:` text; the separate agent `session_search` retains
its grouped results and regex dispatcher. Shared results bypass grouping and
per-session quotas: at most 20 individual records, ordered by BM25, then record
timestamp descending, sequence descending and stable native identity. Session
update time does not reorder tied records. The response uses
`estimatedTotalHits: null`; `limited` means another matching record exists.

The existing registry projection contains completed user/assistant text and native
compaction summaries. New summaries flow through the usual eventual outbox
indexing. On shared search, sessions without a summary-refresh marker contribute
only their stored native compactions to the same projection, then save that
marker. This targeted refresh does not rebuild transcripts or change the SDK.
Already stored originals and unselected branches remain searchable. Imported
system/tool-role nodes, thinking, historical tools and attachments are excluded
from the shared hit/reader projection before the result limit.

Cards carry opaque native record identity, `kind: message | compaction`, session
metadata, source time and a bounded snippet with literal `<mark>` delimiters.
Selected records replace the snippet with complete `content`. No paths or complete
archive are sent to the browser. Native times use the stored entry timestamp;
imports preserve `time.raw`, including local time with an unknown zone.

The registry resolves imported records only in its own archive store, and checks
native session membership before resolving its owning DO. Public session metadata
never chooses an instance. Existing HTTP authentication and hosted per-call
Platform session authorization remain in force; there are no signed handles.

Context follows source ancestors and unique successors, stopping at a fork.
Unsupported source nodes participate in traversal but never appear as content.
Insertion order and the current engine branch do not select context. Return up
to eight eligible records before and after the selected record, with native
sequence indexes and a total 12,000 **Unicode code point** excerpt budget. Share
that budget across nearby records, preserving their prefixes; clipping or window
limits set `truncated`. Selected text remains complete separately. There is no
128 KiB selected-text cutoff. The contract guards the complete serialized reply
against its existing 2 MiB UTF-8 frame limit. Lookup, storage and oversize failures
are ordinary RPC read errors with retry, leaving the socket/chat usable.

## Isolated native acceptance

Approved App #3142 source HEAD is
`512ed6656c0564426838b7a82245453e6dd34114`. Frozen source:
`../lamplit-app/.scratch/conversation-search/frozen-512ed66`. Read `identity.json`
and `owner-approval.json`; approval permits adapter implementation, while merge
remains held for both native hosts and joint user approval.

Extract `lamplit-web-search.tgz`, `lamplit-contracts-search.tgz` and
`lamplit-acceptance-search.tgz` into this repository's test-owned sibling
`.scratch/conversation-search/artifacts/browser`, `contracts`, `acceptance`
directories. Verify archive/manifest hashes and every extracted file before using
it. Install dependencies in `contracts/package` first, then `acceptance` (the
frozen runner's README uses `bun install`). Do not rebuild or edit these bytes.
For native acceptance, the root `node_modules/@lamplit/contracts` must resolve to
that exact extracted package; `verifySearchArtifacts()` checks it too. Normal
repository development continues to use the npm/package-lock workflow and the
adjacent contract dependency. No dependency or SDK patch upgrade is required.

```sh
node --input-type=module -e "import { verifySearchArtifacts } from './scripts/conversation-search-artifacts.mjs'; verifySearchArtifacts()"
node scripts/conversation-search-local.mjs .scratch/conversation-search/native
# In artifacts/acceptance, with the isolated host running:
APP_ACCEPTANCE_URL=http://127.0.0.1:8975/slice/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:8975/__test/conversation-search \
APP_ACCEPTANCE_USERNAME=fixture \
APP_ACCEPTANCE_PASSWORD=fixture-password-long-enough \
APP_ACCEPTANCE_EVIDENCE=/absolute/repo/.scratch/conversation-search/evidence \
bun search-browser.mjs
# Repeat verifySearchArtifacts() after acceptance.
```

The launcher confines state, configuration, logs, registry and caches to its
scratch root, disables real dotenv loading/metrics and binds only loopback.
The test entry seeds actual native entries and an actual DeepSeek archive,
delivers their real outbox events, and serves the frozen browser. Its separate
control route can reset owned data, delay/fail delivery and return native IDs/state;
it never substitutes public hits/context. Model calls use the existing fictional
Pi provider fixture; no real history, credentials or paid services are used.
Evidence includes prompt/loading/results/reader/failure screenshots at 390/1280
and `results.json`. This entry/control route is never production routing.

Run `npm run test:worker -- src/server/conversation-search.worker.test.ts` for
native ranking, stored/new summaries, branch/import context, unknown-zone time,
record selection, owner isolation, full selected text and context limits. Finish
with the existing lint, typecheck, frontend check, `npm test` and frontend build.
The SDK 0.99.1 export-only quiet-compaction patch and licenses remain unchanged.
Repository AGENTS.md is absent; no agent workflow change requires a new file.

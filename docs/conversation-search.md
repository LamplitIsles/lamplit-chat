> Current default build/native acceptance: [default-shared-frontend.md](default-shared-frontend.md).
> Earlier artifact commands below are historical evidence, not the current delivery gate.

# Shared conversation search · spec #3143

The authenticated shared App exposes `lamplit.chat.v2.search({query})` and
`searchRead({id})` through `/api/chat/socket`. Schemas and transport validation
come from `@lamplit/contracts`; the App owns the Framework7 card and reader UI.
These reads use the current instance's PiRegistry, without navigating, resuming,
changing the active branch or submitting a draft. Retained native domain modules remain consumed. This feature does not deploy either edition.

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

## Isolated verification

Use the immutable approved App #3439 artifact and current public native host in
[native durable submissions](native-durable-submissions.md). Search checks read
original archive records/IDs and FTS results from test-owned SQLite, without
switching execution or replaying historical inputs. Public native conversion keeps
old compaction summaries and alternate source paths readable. No old SDK export
patch or private engine API is used. Orc joint native acceptance remains separate.

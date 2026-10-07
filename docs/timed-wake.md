# Timed wakes

Ask your companion in chat to return at an agreed time, for example “Tomorrow
at nine, remind me to take a break.” The `timed_wake` structured tool manages
arrangements in that original PiSession. The fourth tab in the companion's home
drawer shows active arrangements, sorted by their next time. It is read-only:
request changes or cancellation in chat. Long reminders expand in place.
Loading, an empty list, and a failed read with Reload are separate states.
Closing the drawer preserves the composer draft.

Supported plans are a one-time absolute ISO timestamp with an explicit offset,
a fixed interval of at least 60 seconds from an absolute anchor, daily local
HH:mm, and weekly local HH:mm with a weekday (Sunday = 0). The tool supports
`list`, `create`, `replace` (complete replacement by ID), and `cancel`. List
returns current UTC time and the browser's reported IANA timezone, or null when
it has not been reported. Daily/weekly creation requires a valid explicit zone;
the companion must ask for it if unavailable. The registry's existing turn-time
default is not used as a scheduling default. A saved zone stays fixed through
travel and other devices; changing it requires replacing the arrangement.

Each session allows 32 active arrangements, titles up to 80 characters and
reminders up to 8,000 characters. Empty, invalid, past one-time, or over-quota
inputs fail explicitly. The list shows the next instant in the viewer's local
zone; the saved timezone is available to the machine tool, without timezone
text or settings in the drawer. Calendar dates replace
the design's illustrative “tonight/tomorrow” labels when appropriate.

The browser can be closed when a wake is due. A wake joins Pi's durable followUp
inbox; it waits for the current answer instead of interrupting it or starting a
parallel model run. The chat marks it as the companion's self-set reminder,
with an expandable saved title/reminder and scheduled-time source. Acceptance
removes a one-time arrangement from the active list; repeats display the next
occurrence. The mark records a trigger, not successful completion of its task.
Replies use the normal companion message path.

Eligibility is checked after acquiring the Pi lane, immediately before starting
public `followUp` admission: more than 60 seconds after the planned time is
skipped; exactly 60 seconds is allowed. Once that public submission starts
in-window, its durable commit may finish after the deadline while waiting for
Pi’s serialized mutation line. This is an admission-start cutoff, not a strict
database commit-time cutoff. A retry without a receipt checks eligibility again.
Skipped occurrences write no chat message. A skipped
one-time arrangement disappears; a repeat advances strictly beyond now without
catchup. Intervals retain their original anchor. This cutoff is a lateness rule,
not an accurate measurement of downtime. Already accepted work follows normal
Pi recovery even after this window.

## Time zones and DST

Croner 10.0.1 calculates dates without a callback or an in-memory timer. The
Workers tests establish these actual rules: New York daily 02:30 on the 2026
spring-forward date resolves to 03:30 local (07:30Z). For the autumn repeated
01:30, the first occurrence is used; after that instant the next result is the
following day, not the second copy of 01:30. Berlin's Sunday 09:00 crosses the
March DST boundary at 07:00Z. Daily and weekly plans use the same calculation.
Fixed intervals measure elapsed seconds, independent of local clock changes.
No arbitrary cron expression or second model parser is exposed.

## Persistence, recovery and operations

Both hosted and self-hosted editions use the same PiSession path, its existing
session authorization, and Agents SDK 0.26.0 `schedule(Date)`, `listSchedules`,
and `cancelSchedule`. There are no additional secrets, bindings, migrations,
queues, or system push notifications. Hosted Platform's existing `/api/agents`
forwarding covers list reads; no new Platform business endpoint is required.
Model calls and memory extraction use the existing BYOK configuration and can
incur its normal charges. Local synthetic checks do not establish account CPU
limits or production provider performance.

Active arrangements live in session settings and SDK schedules hold their next
absolute occurrence. Before model work, acceptance saves a minimal pending source
association, advances the arrangement and registers its next callback. Native
PiHarness admits a stable occurrence requestId. Receipt reconciliation removes the
pending association after native proof. A restart repeats that identity, avoiding a
second native execution. Original source metadata is projected from the association
and remains readable with historical records across compaction.

Old revisions and cancelled callbacks cannot admit new input. Exactly 60 seconds
late is eligible; later unaccepted input skips without catchup. Already accepted
native work follows normal task recovery beyond the lateness window. This does not
promise exactly-once external side effects. Browser submission/recovery associations
are independent of autonomous reminders.

Repeats and next callbacks register before model work. Startup reconciliation uses
tracked background work and idempotent scheduling. Generation preparation waits for
serialized schedule reconciliation. Agents owns alarm scheduling and public
PiHarness resumes persisted native tasks after eviction; no old lane/inbox driver
or separate execution state is maintained. SDK dates round upward to second
precision while the occurrence retains its exact planned instant.

No reminder text or chat body is logged by the feature. If diagnosing callbacks,
record only arrangement ID, planned time, and outcome category; do not emit
contents or credentials. Application model failures do not recreate accepted
occurrences. The SDK owns callback retries; Pi owns accepted execution recovery.

The existing self-host deploy command is `npm run deploy` (build then Wrangler).
Hosted operators build with `npm run build` before their documented
`wrangler deploy --config wrangler.hosted.jsonc` step. Deployment is not performed
by this change and a PR merge alone does not deploy.

## Isolated verification

Run `npm run test:worker -- src/server/timed-wake.worker.test.ts`. It runs local
workerd with test-owned DO state and fictional model settings; synthetic SSE
responses exercise real Pi generation. It covers SDK alarm → acceptance → Pi
answer without a browser, CRUD/quota/isolation, old and duplicate callbacks,
admission-start cutoff and non-faulting expiry, anchored skipping, actual DST,
busy answer ordering, model failure, storage reconstruction and accepted-operation recovery.

The approved App/native browser and affected reminder regressions use the same
immutable handoff described in [native durable submissions](native-durable-submissions.md).
No browser fixture can establish production alarm timing or device behavior.

The full relevant checks are `npm run lint`,
`npm run typecheck`, `npm test`, and `npm run build`. Production account/provider
and device tests remain outside this isolated acceptance.

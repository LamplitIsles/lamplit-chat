> Current default build/native acceptance: [default-shared-frontend.md](default-shared-frontend.md).
> Earlier artifact commands below are historical evidence, not the current delivery gate.

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
session authorization, and Agents SDK 0.24.0 `schedule(Date)`, `listSchedules`,
and `cancelSchedule`. There are no additional secrets, bindings, migrations,
queues, or system push notifications. Hosted Platform's existing `/api/agents`
forwarding covers list reads; no new Platform business endpoint is required.
Model calls and memory extraction use the existing BYOK configuration and can
incur its normal charges. Local synthetic checks do not establish account CPU
limits or production provider performance.

Active arrangements live in session settings. SDK schedules hold only the next
absolute occurrence. A custom Pi message contains the saved source snapshot.
The occurrence key (arrangement ID, revision, planned instant), accepted Pi entry
ID, inbox write, and advancement of the arrangement commit in one DO SQLite
transaction. Old revisions and cancelled callbacks cannot accept input. Same
occurrence retries find the accepted receipt instead of adding another entry.
Receipts survive refresh and restart; custom message details survive historical
reads and remain explainable across compaction. Cloned/forked conversation
sources describe their history; active schedules belong to the original session.
This does not promise exactly-once external tool side effects.

Repeats advance and the next SDK callback is registered before current model
work runs. Startup reconciliation repairs interrupted registration using
idempotent scheduling. SDK readiness cannot be awaited from the startup hook:
reconciliation is tracked with `ctx.waitUntil`, and resumed model execution waits
for it. Idle drains and provider-message projections containing wake sources await serialized
reconciliation, covering followUps consumed internally by an active run.
Callback dates round upward to SDK second precision, retaining the exact
planned instant for identity and lateness. Pi's existing alarm and steer drain
remain in use; pending followUps can also start an idle run through lane admission
and drive. Browser submission ledgers are required only for browser inputs;
accepted wake custom messages do not fabricate browser submissions.

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

For screenshots, start
that isolated fixture and fails if already occupied. It mounts the real
Companion with synthetic arrangements/actions and uses an isolated agent-browser
session; screenshots and checks go to untracked `.scratch/timed-wake/`. Seven
390×844 states plus narrow, desktop and dark are captured. This fixture verifies
presentation and interaction; the workerd tests establish backend integration.
It reads no user tabs, model credentials, microphone or production state.

The full relevant checks are `npm run lint`,
`npm run typecheck`, `npm test`, and `npm run build`. Production account/provider
and device tests remain outside this isolated acceptance.

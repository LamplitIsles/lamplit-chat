> Current default build/native acceptance: [default-shared-frontend.md](default-shared-frontend.md).

# Shared companion panels

The shared app reads the original Pi stores through `lamplit.chat.v2` on the
existing authenticated `/api/chat/socket`. `@lamplit/contracts`, maintained in
`lamplit-app/packages/contracts`, owns the compiled schemas and public types.
There is no additional transport or content replica. The shared App is the
default frontend; native adapters and their domain consumers remain in place.

All six methods take one object with the selected `sessionId`. It is a stale
request check, not permission to select another session. The shared host validates
inputs and outputs at runtime; an invalid cursor, invalid name or failed read is a
recoverable RPC error. Hosted calls and deliveries recheck the personal session
with Platform, and revocation closes the socket. Self-host requests use the
existing password/cookie authentication. Opening panels does not admit an Agent
turn.

| Method | Extra input | Native source and bound |
| --- | --- | --- |
| `relationship` | none | Current deployment/instance PiRegistry state |
| `relationshipHistory` | `cursor: string \| null` | Registry journal, newest 20 records plus older predecessor |
| `diaryList` | `cursor: string \| null` | Original PiSession memory directory, newest 30 date names |
| `diaryRead` | `name: YYYY-MM-DD.md` | Original memory file, UTF-8 maximum 128 KiB |
| `album` | `cursor: string \| null` | Registered session photos, newest 30 by createdAt/id |
| `reminders` | none | Original pending timed wakes, native limit 32 |

First-page and terminal cursors are null. Continuations are opaque authenticated
strings bound to method and session, persisted across reconnects through a small
native setting. A cursor from another method/session is rejected. Relationship
scope is `pi-registry:singleton` for self-hosting and `pi-registry:<instance-id>`
for hosted deployments. All sessions in that scope see native relationship
updates; fetching old history does not replace current state. The predecessor
lets the app calculate the oldest visible record's affinity change accurately.

Diary reads are confined to date-named Markdown under native `/workspace/memory`.
Other Markdown, arbitrary paths, date-named symlinks and linked memory directories
are excluded. Results distinguish `found`,
`missing` and `too-large`; bounds use UTF-8 bytes, including a second check after
reading the file. A file removed after listing returns `missing` on detail read.

Albums include only photos correlated with an admitted conversation entry.
Uploading or browsing an unregistered image does not add it to the public album.
Native conversation uploads have human origin. Metadata contains opaque IDs,
filenames, UTC creation timestamps and same-origin URLs, without storage paths.
Availability checks both preview and original in R2. If an original is gone, the
record stays visible as unavailable even when preview bytes still exist.
`/api/conversation-images/<session>/<image>/preview` and `/original` preserve the
existing per-request authentication, session checks and hosted instance-prefixed
R2 ownership. Saving fetches original authenticated HTTP bytes, not WebSocket
payloads or a foreign redirect. No R2 layout migration is required.

Reminder views preserve native IDs, titles, bodies, UTC `nextAt` and structured
once/interval/daily/weekly schedules. Interval precision is seconds; original
anchors, including signed pre-1970 values, remain intact. Daily/weekly retain
IANA time zones and Sunday as weekday zero. Creation, editing and deletion stay
with native Agent tools. Merely reading reminders does not run a turn.

The existing DO scheduler admits due occurrences at or below 60 seconds late.
Strictly over 60 seconds late, one-time definitions end and repeated definitions
advance to their next future time without a model turn. Existing occurrence
receipts deduplicate admission. Edits/deletion leave an already admitted immutable
input unchanged; there is no replay queue or restart compensation. Persisted
`timed-wake` custom messages retain their text and entry identity and project
`source: {kind: "reminder", reminderId, occurrenceId}` in snapshots and history.
The shared app shows them incoming with an application-reminder badge.

## Local verification

Use the repository's npm lockfile and adjacent compiled app package. `npm ci
--install-links` installs a local compiled package rather than leaving an editable
symlink. Build that package in app when maintaining its public contracts; this
repository does not redefine them. For a frozen handoff verify its manifests
against the installed package as well as the extracted browser assets.

```sh
npm ci --install-links
npm run lint
npm run typecheck
npm test
npm run build
```

`companion-panels.worker.test.ts` uses real test-owned DO/workspace/R2 storage and
an authenticated public socket. `timed-wake.worker.test.ts` covers the 59/60/>60
second once/repeat boundaries, native receipts, immutable inputs and persisted
source. Existing relationship, photos and chat worker tests remain relevant.

For current actual frozen-browser acceptance, follow
[default-shared-frontend.md](default-shared-frontend.md). The panels host verifies
the approved parent archive, manifests and installed contracts, then loads its
unchanged `acceptance/panels-fixture.ts` facts into native stores: relationship
history, 35 diary names/photos, all four schedules and an admitted reminder
message. Only the fixture simulates the missing-diary race. A past historical
one-time timestamp is seeded in the future so native admission remains valid.

```sh
PANELS_FIXTURE_PORT=8985 \
  node scripts/companion-panels-local.mjs .scratch/default-shared-frontend/panels-unique
curl --fail -X POST http://127.0.0.1:8985/__fixture/seed
# From the test-owned artifact/acceptance extraction:
APP_ACCEPTANCE_URL=http://127.0.0.1:8985/ \
APP_ACCEPTANCE_USERNAME=owner \
APP_ACCEPTANCE_PASSWORD=fixture-password-long-enough \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/evidence/panels \
  bun panels-browser.mjs
```

The unchanged runner checks 390/1280 against actual native storage and public
methods, including original PNG save bytes, reminder source after reload, text
chat and microphone PCM to draft. The implementation report records current run
results and limitations. Use a fresh owned root and free port; inherited
Cloudflare credentials and dotenv loading are excluded. Recheck the parent and
replacement hashes after acceptance. Stop only this harness with Ctrl-C; its
fixture evidence remains for inspection. These commands do not deploy.

# Matrix source display and native acceptance (#3561)

The shared App shows Matrix inputs with an M avatar, Matrix badge and external
message bubble. The separate source header displays the exact display name,
sender ID and room ID. An empty display name falls back to the exact sender ID.
Long Unicode labels wrap and HTML-looking labels render as escaped text. No room
name is invented or looked up. The original multiline body retains normal safe
Markdown rendering and its original authored time.

Chat's existing `PiSession.getBranch()` reads the validated original webhook from
its durable `keet_sources` association. Only original sender ID, display name,
room ID and body enter the public adapter; `authoredAt` retains the original event
time. Public `MessageSource` is the closed `{kind:'matrix', senderId,
senderDisplayName, roomId}` variant, bounded to the gateway's 255 UTF-16 units.
No event ID, raw payload, context or credential is exposed in this source.
The original native attribution prompt, private buffered context, execution,
receipts, queue, compaction and owner authority remain unchanged. Prefixes are
never parsed to recover the body; a literal author-written prefix remains text.
Initial reads, socket reconnects and older pages all use this durable projection.

Keet, reminder and ordinary web behavior are retained. The approved App preserves
collapsed thinking. Original baseline `9004f0f` did not expose native assistant
thinking; main `76ab40d` subsequently introduced it through PR43. Integration
preserves that existing projection, block order and failure/time rules. Both the
imported native thinking fixture and shared App fixture verify this capability.

## Approved App bytes and consumption

Owner approved App #3560 candidate `3e95c3385ac00ba8317d21b85b76484637ce3fc6`.
The unchanged `lamplit-matrix-source-ui.tgz` has SHA256
`5b8fa6d5c2265017582465abafac6e684fffd44e2fa7150166e7c657bc9b0a6a`.
`vendor/app-identity.json` pins the browser (265), contracts (27) and acceptance
(42) file manifests. The existing vendored npm package contains those compiled
contract files unchanged; npm packaging omits the producer's auxiliary Bun lock.
Root npm lock integrity identifies that package. No contract/browser compilation
or App source modification is part of Chat consumption.

Place the approved archive at `.scratch/matrix-source-ui/lamplit-matrix-source-ui.tgz`
or set `LAMPLIT_APP_ARTIFACT` to its absolute path. Extract into a new test-owned
`.scratch/matrix-source-ui/approved-app` directory, or use `LAMPLIT_APP_EXTRACTION`.
Install archived dependencies with the frozen Bun locks, contracts first then
acceptance. Use the archived documented Bun version and an installed Chromium via
`APP_ACCEPTANCE_BROWSER` when the cached browser lacks host libraries.
`npm run build` checks archive, source and every manifested file, then copies the
frozen browser into the existing owned Wrangler asset directory.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
node scripts/default-shared-artifacts.mjs
NATIVE_FIXTURE_PORT=8996 node scripts/native-submissions-local.mjs matrix
```

From the extracted `acceptance/`, run the unchanged external-host runner:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:8996/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:8996/__test/matrix-source-ui \
APP_ACCEPTANCE_EVIDENCE=/absolute/test-owned/matrix-evidence \
bun matrix-browser.mjs
```

The native Matrix fixture reuses the existing local workerd launcher, native
Basic-to-cookie authentication and public socket. `reset` creates a new owned
session; `incoming` sends an original synthetic MFA event to the actual Worker
webhook. Native scheduling remains enabled, including memory extraction. All
provider calls use a local fake; other external fetches fail. The buffered
`native-only context sentinel` is private. The control acknowledges only after
the native queue and public projection settle. `history` pads the real native
lane with older synthetic entries to exercise the existing page boundary.
`reminder` uses a real timed wake; `complete` releases the fake web reply; `state`
reports ordinary web submissions. `/disconnect` closes observation sockets and
lets the actual browser reconnect without replaying input.

The frozen runner verifies named/empty/Unicode/hostile labels, exact multiline
body and time, first open/reload/reconnect/history, escaped/accessibly grouped
headers, no overflow, draft preservation and ordinary web/reminder regressions.
It captures 320/390/1280 light/dark screenshots. Run the existing Keet fixture on
a separate owned port with the frozen `keet-browser.mjs` and
`APP_ACCEPTANCE_KEET_IMAGE_PROFILE=text-only`. Run `thinking-browser.mjs` against
`node scripts/native-submissions-local.mjs thinking` using the existing
`/__test/collapsed-thinking` controls; see [native thinking](collapsed-thinking.md).
The packaged App fixture separately covers grouped assistant image UI.

For restart proof, retain the printed `native-browser-*` root. Stop only that
fixture process; restart the same suite/port with `NATIVE_FIXTURE_RESUME` set to
that root. Before any writes the launcher requires canonical path-segment
containment under its real scratch directory, its root-bound ownership marker,
and regular configuration files. Foreign roots and symlink escapes are rejected.
Old unmarked roots cannot resume; preserve their state and use a new marked root.
`node --test scripts/native-fixture-root.test.mjs` verifies ownership in temporary
fixtures without changing rejected state.
Registry selection and synthetic session/SQLite state persist. Reopen the real
public socket and older page, compare stable IDs/source/body/time before and
after restart, and inspect the actual rendered UI. Do not call `reset` during
this proof. Recheck all artifact manifests and retain raw native/public evidence
and screenshots in the ignored implementation report directory.

## Delivery gates and limits

App and host PRs require joint acceptance using the exact same approved bytes
on Chat and CFL before merge. After App squash merge, host source attribution must
bind to the actual merged commit with equal-tree verification while retaining the
approved archive identity. Orc owns named independent reviews, merge and closure.
Candidate acceptance does not assert these later gates passed.

No live deployment, native Rust release, real account/provider turn, production
config/state/service/credential access, conversation read or external message is
part of this verification. Hosted isolation is tested at the existing actual
Worker owner-routing/public-socket seam using fake Platform responses, without
Platform changes. No repository AGENTS.md or IMPORTS file exists; portable and
machine instructions still govern this unchanged npm/frozen-artifact workflow.

Current source attribution is actual merged App PR18 main
`132d7dedd8c52eecefa8ea6bb9bb6038d5cdc9e8`. Its tree
`ac660d08d4f7ccb0b3845de11ac185df5c50301a` equals the approved candidate tree.
`vendor/app-identity.json` records both merged `head` and frozen `artifactHead`
`3e95c3385ac00ba8317d21b85b76484637ce3fc6`, with their equal trees. The verifier
checks the frozen SOURCE_HEAD against artifactHead and all334 original file hashes;
it reports the merged source attribution separately. Archive bytes and SOURCE_HEAD
remain unchanged.

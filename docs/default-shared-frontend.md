# Default shared frontend

Both hosted `/chat` and standalone `/` serve the same approved Framework7 App.
Assets and icons are root-relative. Platform owns hosted authentication, manifests,
service worker and `/settings`; Chat retains its personal-deployment authentication.
Missing routes return 404. There is one v2 chat wire and one public native engine.

The build consumes immutable App #3560 bytes from candidate
`3e95c3385ac00ba8317d21b85b76484637ce3fc6`, attributed to equal-tree merged
main `132d7dedd8c52eecefa8ea6bb9bb6038d5cdc9e8`; it never builds/reads an adjacent moving
checkout. `vendor/app-identity.json` pins archive and manifests. The contract tgz
contains the approved compiled contracts without rebuilding. `npm run build` verifies all 334
manifested files and SOURCE_HEAD, then copies the browser to owned scratch assets
used by both Wrangler configurations.

```sh
npm ci
npm run lint
npm run typecheck
npm test
LAMPLIT_APP_ARTIFACT=/absolute/approved/lamplit-matrix-source-ui.tgz npm run build
```

An approved archive can instead be placed at
`.scratch/matrix-source-ui/lamplit-matrix-source-ui.tgz`.
It stays untracked. Contracts and acceptance dependencies install only in a
separate owned extraction; see [native durable acceptance](native-durable-submissions.md)
for installation order, exact runner and actual native handler/SQLite/socket gate.
App source, contract and runner changes require App ownership and Orc approval.
See [Matrix source acceptance](matrix-source-ui.md) for the current exact bytes,
controls, persisted restart proof and cross-host merge gates.

`npm run dev` verifies/prepares the approved assets and starts the personal Worker.
`npm run deploy` performs that build then the documented self-host Wrangler step;
hosted deployment uses `wrangler.hosted.jsonc` after the same build. These commands
are operator actions after review. Local implementation performs no merge/deploy,
production state conversion, real provider calls or credential operations.

Read-only domain panels, search, voice and media retain their original endpoints,
stores and authorization. Relationship validation lives in
`src/server/relationship-validation.ts`; browser source and behavior belong to App.
No repository AGENTS.md exists; user and host-local instructions govern the work.
NOTICE/LICENSES retain attribution. Physical camera/microphone, PWA installation,
production authentication/provider behavior and Orc joint acceptance remain separate
from passed local fake-provider/native checks.

Current source attribution is actual merged App PR18 main
`132d7dedd8c52eecefa8ea6bb9bb6038d5cdc9e8`. Its tree
`ac660d08d4f7ccb0b3845de11ac185df5c50301a` equals the approved candidate tree.
`vendor/app-identity.json` records both merged `head` and frozen `artifactHead`
`3e95c3385ac00ba8317d21b85b76484637ce3fc6`, with their equal trees. The verifier
checks the frozen SOURCE_HEAD against artifactHead and all334 original file hashes;
it reports the merged source attribution separately. Archive bytes and SOURCE_HEAD
remain unchanged.

For history changes, use the public native/SQLite/socket regressions in
`native-history.worker.test.ts` and the existing submission, source, search,
conversion and media suites. [ADR #3646](native-durable-submissions.md#accepted-adr-3646)
records the authority and preservation boundary. Keep old diagnosis/profile
results labeled with their original revisions; new behavior counters belong to
test-owned current native records. No App rebuild or contract change is needed.

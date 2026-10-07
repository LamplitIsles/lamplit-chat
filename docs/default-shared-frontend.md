# Default shared frontend

Both hosted `/chat` and standalone `/` serve the same approved Framework7 App.
Assets and icons are root-relative. Platform owns hosted authentication, manifests,
service worker and `/settings`; Chat retains its personal-deployment authentication.
Missing routes return 404. There is one v2 chat wire and one public native engine.

The build consumes immutable App #3439 HEAD
`3aaa48a384549f72cc417a6cb3e6108fe0999b37`; it never builds/reads an adjacent moving
checkout. `vendor/app-identity.json` pins archive and manifests. The contract tgz
contains unchanged approved compiled contracts. `npm run build` verifies all 326
manifested files and SOURCE_HEAD, then copies the browser to owned scratch assets
used by both Wrangler configurations.

```sh
npm ci
npm run lint
npm run typecheck
npm test
LAMPLIT_APP_ARTIFACT=/absolute/approved/lamplit-native-durable-submissions.tgz npm run build
```

An approved archive can instead be placed at
`.scratch/native-durable-submissions/lamplit-native-durable-submissions.tgz`.
It stays untracked. Contracts and acceptance dependencies install only in a
separate owned extraction; see [native durable acceptance](native-durable-submissions.md)
for installation order, exact runner and actual native handler/SQLite/socket gate.
App source, contract and runner changes require App ownership and Orc approval.

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

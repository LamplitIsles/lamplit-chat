# Quiet native compaction

Chat spec #3120 consumes the Owner-reviewed App #3119 handoff at
`95f0f06fc00fd4e7fa3e664ca2b1fe12fe8d10b8`. The native frontend remains available;
this integration does not deploy or replace either frontend.

The exact bare `/compact` without images invokes `compact({sessionId})`, returning
`{sessionId,accepted}`. Ordinary `submit` rejects that exact text. Arguments remain
ordinary text; the shared browser refuses command-plus-images and restores the
editable selection. Busy, refusal and offline feedback retain the draft. Native
completion has no toast, status or history marker. Pi's compaction entry remains
in its native tree, and prompts, settings, cut points and cancellation are unchanged.

`ChatView.contextUsage` contains nullable `tokens` and `capacity`; `compaction` is
null or `{id:string|null,status:"running"|"complete"|"failed"}`. All observations
belong to `sessionId`. The meter displays missing tokens as zero, silently. Capacity
comes from the selected native lane model, including configured context window.
Counts are validated as finite, nonnegative and safe; capacity must be positive.
The adapter projects the active branch through native `buildSessionContext`, uses
Pi's estimator for trailing messages, and excludes retained pre-compaction usage,
other branches, summary-call usage and billing adjustments. Compaction, navigation
and context import invalidate older observations. Tokens remain null until fresh
valid assistant usage; a complete snapshot can already contain fresh tokens.

The shared host checks ownership and known busy state preliminarily. Pi captures
the submitting connection, prepares the harness/lane, then revalidates authorization,
connection membership, current session and active/queued human work before reserving
the existing exclusive guard. Native `lane.compact` still owns atomic admission.
The RPC acknowledges its native `compaction_start`, not completion. Pre-start
refusal returns false and creates no queue. Native start/end events persist one
bounded latest lifecycle observation; manual and automatic events use native run
IDs. Socket loss neither completes nor cancels native work. Lost replies, reconnect
and reload never replay the operation. Pi can refuse an already compacted tip as
`NothingToCompact`; another command is an explicit new action.

## Repository-maintained SDK export

The pinned `@earendil-works/pi-agent-core` 0.99.1 implements the projection but omits
its public export. The Owner authorized an export-only patch in this repository:
`patches/@earendil-works+pi-agent-core+0.99.1.patch` changes only
`dist/harness/session/index.js` and `index.d.ts`, exposing `buildSessionContext` and
`SessionContextBuildOptions`. Root already reexports that facade. This is local
export support, not an upstream published API. `npm ci` applies it via
`postinstall: patch-package --error-on-fail`. Keep the version pin and patch together;
installation fails if the patch cannot apply. No private runtime import or SDK
algorithm change is used. A pristine test-owned install verifies runtime and
TypeScript imports from both public facades.

## Isolated native acceptance

Read the frozen acceptance README for the exact common control and environment
contracts. Extract unchanged archives into `.scratch/quiet-compaction/frozen/`
with `web`, `contracts/package` and `acceptance`; install compiled contracts with
npm and acceptance dependencies with its existing manager. Never rebuild or alter
these artifacts. `scripts/quiet-compaction-artifacts.mjs` validates approval HEAD,
archives, manifests, every extracted file and installed compiled contract bytes.

```sh
node scripts/quiet-compaction-local.mjs .scratch/quiet-compaction/native
QUIET_COMPACTION_ACCEPTANCE=true IMAGE_FIXTURE_PORT=8975 \
  node scripts/image-send-recovery-local.mjs .scratch/quiet-compaction/images
QUIET_COMPACTION_ACCEPTANCE=true PANELS_FIXTURE_PORT=8976 \
  node scripts/companion-panels-local.mjs .scratch/quiet-compaction/panels
curl -X POST http://127.0.0.1:8976/__fixture/seed
```

Run unchanged `compact-browser.mjs`, `images-browser.mjs`, `panels-browser.mjs` from
extracted acceptance with `APP_ACCEPTANCE_URL` pointing at the relevant `/slice/`,
`APP_ACCEPTANCE_USERNAME=owner`, and the fictional
`APP_ACCEPTANCE_PASSWORD=fixture-password-long-enough`. Set separate absolute
`APP_ACCEPTANCE_EVIDENCE` directories. Compact's control URL is
`http://127.0.0.1:8974/__test/quiet-compaction`; images use
`http://127.0.0.1:8975/__test/image-send-recovery`. Panels retain their seed/state
protocol and native interval/time-zone mappings. Ports can be changed with
`COMPACT_FIXTURE_PORT`, `IMAGE_FIXTURE_PORT`, `PANELS_FIXTURE_PORT`.

Each launcher owns its Wrangler config/cache/log/SQLite/R2 directories beneath
its explicit scratch root, disables real dotenv loading, uses fictional auth and
intercepts native model requests. Production never imports the test entry. The
compact controls append real native entries, drive real threshold compaction and
retain native call/event/entry evidence. They do not replace the chat adapter with
an App fixture. A held-result scenario seeds a new native user entry if Pi's tip is
already compacted, allowing the next deliberate operation to traverse native
admission. This is test setup, not a product retry or ordinary shared submission.

`npm test`, `npm run typecheck`, `npm run lint`, `npm run check:frontend` and
`npm run build` remain the repository checks. Browser coverage is desktop Chrome
at 390/1280/320 widths (panels 390/1280), not a physical mobile keyboard/safe-area
or deployment check. The full historical Composer/attachment design is superseded;
attachment acceptance uses the frozen CFL-derived 72px square/44px remove baseline.
Owner joint review and governed merge remain pending; no deployment is implied.

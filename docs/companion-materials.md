# Companion materials API

Authenticated `/api/companion-materials` manages the current companion's original root Markdown and existing memory. It uses the same hosted trusted instance identity and selfhost `AUTH_PASSWORD` cookie/Basic authentication as chat. Hosted mode resolves the registry's default Companion session; selfhost must set `COMPANION_SESSION_ID` to a ready session in the singleton registry. Missing or non-ready selfhost configuration returns `409 {"error":{"code":"unconfigured"}}`; the API never guesses a workspace. No query parameters, session/instance selectors, general filesystem operations, or memory creation are accepted.

Every feature response uses JSON, `Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`. Mutations with a foreign Origin return 403. Authentication failures use the existing shared gateway response: selfhost 401 authentication challenge; invalid hosted credentials/identity 403. Authenticated hosted foreign-Origin mutations in this exact namespace reach the feature JSON forbidden response with private no-store/nosniff headers. Those gateway responses are plain text, not the feature error envelope.

Machine-readable routes and JSON schemas: [companion-materials.contract.json](companion-materials.contract.json). TypeScript requests/responses and runtime request schemas: `src/shared/companion-materials.ts`. Fictional examples: `src/server/fixtures/companion-materials.json`. JSON requests reject extra fields. GET requests have no body. DELETE requests require a JSON body. Content-Type must be `application/json` (optional charset accepted).

| Method | Path after namespace | JSON request | Successful JSON response |
| --- | --- | --- | --- |
| GET | `/files` | none | `{files:[{name,bytes}]}` (200) |
| GET | `/files/{name}` | none | `{name,content,version,bytes}` (200) |
| POST | `/files/{name}` | `{content}` | `{name,content,version,bytes}` (201) |
| PUT | `/files/{name}` | `{content,expectedVersion}` | `{name,content,version,bytes}` (200) |
| DELETE | `/files/{name}` | `{expectedVersion}` | `{deleted:true}` (200) |
| GET | `/memories` | none | `{memories:[Memory]}` (200) |
| PUT | `/memories/{id}` | `{content,expectedUpdatedAt}` | `{memory:Memory}` (200) |
| DELETE | `/memories/{id}` | `{expectedUpdatedAt}` | `{deleted:true}` (200) |
| GET | `/compaction` | none | `{mode,content,version,bytes}` (200) |
| PUT | `/compaction` | `{content,expectedVersion}` | `{mode,content,version,bytes}` (200) |
| DELETE | `/compaction` | `{expectedVersion}` | `{mode,content,version,bytes}` (200) |

`{name}` is a URL-encoded single basename of 1–200 JavaScript string characters ending in case-sensitive `.md`. Slash, backslash, Unicode control/format characters, and traversal are rejected. Encode names with `encodeURIComponent`; there is no recursive or directory read. Only regular root files are listed; symlinks (including dangling links), directories named `.md`, and nested files are excluded. Read/update and COMPACTION.md read/save/reset reject nonregular entries with invalid-data; create conflicts on any same-name entry, including dangling symlinks. All root names are preserved, including files outside any preset list. The list is sorted by raw name ascending, with no pagination. More than 200 total root entries (including directories/non-Markdown) returns resource-limit, never a truncated list. Listing returns actual file sizes even if a file is too large to read.

Files contain at most 128,000 UTF-8 bytes; an ordinary Markdown file may be empty. Requests are bounded to 800,000 UTF-8 bytes before JSON parsing, accommodating JSON escaping at the content boundary. Invalid UTF-8 is rejected. The version is the lowercase SHA-256 of the complete UTF-8 content, independent of timestamp precision. POST is create-if-absent: any same-name entry conflicts. PUT and DELETE require a currently existing file and its expectedVersion. DELETE removes only that root document; deleting COMPACTION.md restores the default effective prompt. Other documents, memories and chat remain unchanged. Stale versions conflict and never overwrite. Single-file writes use the existing workspace storage operation within PiSession's existing exclusive boundary; reads and memory management also use that boundary. A busy session returns 409; preserve the local editor contents and retry after idle. A conflict requires re-reading and reconciling with the current original before retrying.

Memory has `{id,kind,content,createdAt,updatedAt,sourceSessionId?,sourceEntryId?}`. Existing storage kinds stay unchanged (`fact`, `preference`, `instruction`, `decision`); the management UI may display instruction as “约定”. The complete list is bounded by the existing 64-memory budget, sorted by createdAt descending then ID ascending for ties. Model memory-context ordering remains unchanged. Updates accept only content, trim it, enforce the existing nonempty 500-character/secret checks and 8,000-character rendered context budget, and preserve kind, creation time, and both source fields. The registry checks expectedUpdatedAt in the same SQLite transaction as edit/delete. updatedAt advances on edit. Missing IDs return not-found; updates never create memory. Delete does not alter the source chat. The normal memory tool, automatic extraction, and archive search remain available.

COMPACTION.md is the single original override. Both root-file editing and `/compaction` save require non-whitespace content within 128,000 UTF-8 bytes. If absent, effective-read returns `{mode:"default",content:<full builtin>,version:"default",bytes:<UTF8 size>}`. No default file is created or listed. A custom file returns mode custom and the same content hash as the ordinary file endpoint. Save from default uses expectedVersion `default`. Reset checks the version first and deletes only the override; reset of an already-default matching version succeeds. Previously persisted summaries are not rewritten.

The next actual manual or automatic compaction reads the effective prompt in the
public Pi Durable 1.0.4 CompactionTask hook. Native Pi selects/persists the range;
Chat supplies history, previous summary, split-turn prefix, optional focus and
sorted read/modified file hints through the selected native provider. Keet private
attribution is projected before generation. Failed, empty, aborted or unconfigured
summarization declines without replacing context or invoking a coding default.
No separate summary engine or model selector is added. See
[native compaction](quiet-compaction.md).

Only AGENTS.md is automatically injected. Other root Markdown is read through existing workspace tools when AGENTS or the conversation directs it. For example, a fictional AGENTS.md could say: “Read SOUL.md for companion identity and USER.md for relevant preferences when needed; resolve changes against the current conversation.” Saving materials does not load a model or invoke inference. Model-backed normal extraction and actual compaction retain their existing model usage. An organizing assistant is paid Phase 2 and has no scaffolding or paywall in this feature.

| Feature error code | HTTP status | Meaning |
| --- | --- | --- |
| invalid-data | 400 / 415 | Invalid path/schema/UTF-8/empty compaction/memory content; 415 for non-JSON mutation |
| resource-limit | 413 | File/request/list/memory context bound exceeded |
| not-found | 404 | Missing file/memory or unknown route |
| conflict | 409 | Existing create target or stale expected version/timestamp |
| busy | 409 | Existing session exclusive operation is active |
| unconfigured | 409 | Selfhost companion session absent or not ready |
| forbidden | 403 | Foreign Origin mutation |
| method-not-allowed | 405 | Unsupported method, including memory creation |
| internal-error | 500 | Controlled unexpected storage/RPC failure |

Feature errors are exactly `{"error":{"code":"..."}}`; no documents, memory, provider messages, stacks, or credentials are included.

## Isolated local integration

Run `npm ci`, then `npx vitest run src/server/companion-compaction.test.ts` and `npm run test:worker -- src/server/companion-materials.worker.test.ts`. The existing Worker test config disables .env loading, uses fictional credentials, and owns all DO/R2 state. The API harness imports the real server and storage; the compaction harness captures actual OpenAI-compatible requests through a fake fetch provider at `fictional.invalid`, with no live inference. These files are the executable local integration harness and can be used to build frontend mocks from the fixture/contract. Do not start local dev against a private .env, export, workspace, or paid model to verify this feature. Owner starts platform integration after backend contract review; shared phone long-text/keyboard/safe-area/four-nav acceptance remains the two-PR merge gate.

## Attribution

The builtin eight-heading continuity prompt is adapted from [LamplitIsles/codex-for-love](http://forgejo.localhost:17480/LamplitIsles/codex-for-love), `apps/partner/runtime/prompts.ts`, pinned at `a4d51f02ccdf1cf9e0b9b839da398412739e0290`, under Apache-2.0. The previous-summary tag and historical-data wording are adapted to Pi's input wrapper. No Codex-specific tool routing or private persona is copied. See [Apache-2.0 license](../LICENSE) and [NOTICE](../NOTICE).

# Collapsed thinking (#3523; App counterpart #3522)

`ChatMessage.thinking?: string` carries only actual assistant thinking block
strings, joined with newline in original block order. `text` still comes only
from ordinary text blocks. No prose inference, signatures, private prompts or
tool arguments enter the field. Original native records remain unchanged. The
optional field retains chat protocol v2, ChatView v2 and transport v1; clients
without thinking, including CFL, continue to omit it.

The approved Framework7 App renders「不许你看的小想法」above answers, initially
collapsed on mount/reload/history. Its existing safe Markdown, keyboard focus,
touch target and native arrow apply. Answer copying and search stay text-only.
Failed/aborted replies keep their notices without thinking. A thinking-only
successful stop still produces `回复失败`; tool-call-only entries remain omitted.
No model configuration, streaming, submission or receipt behavior changes.

## Isolated native acceptance

Use the approved archive and `vendor/app-identity.json` with the existing build
and artifact verifier. Extract into Chat-owned scratch, verify every manifested
byte, and install the archived contracts/package then acceptance using their
frozen Bun locks and a test-owned cache. Never build the adjacent App checkout or
edit frozen browser/contracts/runners. `npm run build` copies verified browser
bytes to `.scratch/native-durable-submissions/app-browser`, the existing asset
location used by both Wrangler configs.

`node scripts/native-submissions-local.mjs thinking` starts loopback 8991 with
fresh fixture-owned SQLite/R2/config/cache/log state and a fake SSE provider.
Unmatched outbound fetches fail. The frozen runner has no login step: the
Orc-approved fixture-only gateway supplies fictional Basic authentication to
actual `worker.fetch`; production authentication and socket handlers still run.
An initial invocation without the gateway correctly failed authentication. This
is test setup evidence, not a product authentication defect.

From extracted acceptance run the immutable `thinking-browser.mjs`:

```sh
APP_ACCEPTANCE_URL=http://127.0.0.1:8991/ \
APP_ACCEPTANCE_CONTROL_URL=http://127.0.0.1:8991/__test/collapsed-thinking \
APP_ACCEPTANCE_ASSETS=../browser \
APP_ACCEPTANCE_EVIDENCE=/absolute/chat-owned/evidence \
bun thinking-browser.mjs
```

Controls translate runner expectations exclusively into actual `submitChat`
inputs and fake upstream SSE. The provider parser/native engine owns completed
records; controls never inject public DTOs or native storage. History replays
fixture inputs in history-first order with native filler turns for real pagination
before the browser opens. Disconnect closes actual fixture sockets. All six
320/390/1280px × light/dark combinations use the same native host and App bytes.

The native grouped control omits unsupported assistant image associations. It
proves one disclosure for a native thinking/text answer, **not native assistant
grouped-image coverage**. App #3522 fixtures own grouped assistant image+text UI
coverage. Existing user image upload/submission coverage uses
`src/server/image-send-recovery.worker.test.ts`; no media capability is expanded.

Projection tests cover original order, non-string/empty/absent thinking, role
filtering, independent text, metadata exclusion and preserved failure/stop/tool
handling. The separate hosted native test exercises trusted-host authentication
refusal/success, actual provider blocks, native persistence, socket read/history
and reopening the harness without replay. Test fixtures use no live state,
credentials, paid models or tool calls.

README, default frontend and native integration guidance are updated. No local
AGENTS.md/CLAUDE.md exists. Search/import/provider/media/voice/panels guidance needs
no behavioral edit because their semantics and stored records are unchanged.
App UI work and design evidence belong to #3522; no Chat UI source is edited.
Local success awaits Orc joint identity reconciliation; merge/deploy are separate.

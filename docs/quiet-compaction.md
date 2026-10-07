# Quiet native compaction

Exact bare `/compact` without images invokes `compact({sessionId})`, returning
`{sessionId,accepted}`. Ordinary submit rejects that command. Busy/refused/offline
feedback keeps the draft. Native summaries stay out of the timeline and completion
is silent. Compaction uses public Pi Durable 1.0.4; there is no SDK export patch.

Native CompactionTask chooses the cut, owns cancellation and persists the checkpoint.
Chat's hook supplies the companion continuity policy, previous summary, split-turn
prefix, file hints and private Keet projection. Failure, abort or empty summary
explicitly declines and leaves prior context intact; it does not run a coding default.
Manual admission revalidates the captured socket after asynchronous preparation and
refuses active/queued native work. Actual native task records expose running,
complete or failed state for manual and automatic operations. An accepted command
acknowledges scheduling; it does not promise a useful summary when no cut exists.
Reconnect and lost replies never resubmit the command.

`ChatView.contextUsage` is `{tokens,capacity}` with nullable contract fields. Chat
projects active public native ContextView, uses valid fresh assistant request usage
and estimates only later text at four characters/token. This is a host approximation,
not a provider tokenizer. It excludes pre-checkpoint usage, summary-call spend and
cumulative billing. After compaction or unknown usage, tokens are zero; selected
native model capacity is retained when known. Fresh valid completion usage can be
present in the first complete snapshot. No private engine estimator is imported.

Run `npm run test:worker -- src/server/quiet-compaction.worker.test.ts` and the
companion-compaction/context-usage tests for actual native range, quiet socket,
manual/automatic/failure and active usage checks. The approved affected browser
runner, immutable artifact checks and isolated native host are documented in
[native acceptance](native-durable-submissions.md). Fake providers and test-owned
SQLite establish local behavior; Orc joint native acceptance remains separate.

# Native Keet source restoration

Current Free and Hosted Keet intake follows the independent inbound contract in
[inbound integrations](inbound-integrations.md). It reuses public Pi Durable 1.0.4
and Agents 0.26.0 PiHarness submissions, source associations and queue settlement.
Tools come exclusively from Chat's generic [MCP_CONFIG](injected-remote-mcp.md).

Keet's current factual envelope includes UUID eventId, diagnostic sequence, native
message ID, authored timestamp, destination, sender, text, required addressing and
optional replies/images/reactions. The receiver decides whether to trigger or
buffer. DM text triggers; Group native mention/identity label/verified own reply/
alias triggers; ordinary Group text buffers; Broadcast and image-only do not wake.
Captioned images retain the existing unavailable-image explanation; no media is
fetched. See the parser for current code-point bounds and the inbound guide for
HTTP limits, immutable receipts, shared cap, policy and restart uncertainties.

Persisted Keet conversation provenance remains readable. The approved public
source is `{kind:'keet', channel:'dm'|'group', senderLabel, destination}`. Original
author time and visible text stay separate from private room/reaction attribution.
Generation, compaction and memory project that attribution without replacing
browser-owner authority or exposing private excerpts in views/search/history.

Run `npm run lint`, `npm run typecheck`, `npm test`, then the pinned build and
[native acceptance](native-durable-submissions.md). The actual Worker/native/socket
regressions cover receipt conflicts, sequence gaps admitted, bounded context,
lost acknowledgement and private source projection. The unchanged approved
`keet-browser.mjs` runs against `scripts/native-submissions-local.mjs keet` with
`APP_ACCEPTANCE_KEET_IMAGE_PROFILE=text-only`. Its host uses current KFA facts;
App archive/contracts/runner bytes stay frozen. All providers and state are
fixture-owned. This does not prove live Keet interoperability or remote-send
exactly-once. Orc owns independent review and merge; deployment is separate.

# Native Pi Keet text ingress

Spec #3410 restores the bounded text feed, durable queue, source association and
four native tools from `lamplit-cloudflare`. It uses the public Pi Durable 1.0.4 and Agents 0.26.0 PiHarness
submission/storage APIs. It adds
feature-local SQLite tables; domain data survives the native format conversion in #3436.

## Optional self-host setup

Ordinary chat requires no Keet settings. For a new self-host instance, initialize
a session through the authenticated chat first. Set `COMPANION_SESSION_ID` in the
private Worker configuration to that ready session's UUID. Set an independent
`KEET_INGEST_TOKEN` secret for event intake. Tools additionally require
`KEET_MCP_TOKEN` and an operator-selected `KEET_MCP_URL`: HTTPS, exact `/mcp`, with
no embedded credentials, query or fragment. No personal session, domain or secret
is supplied by this repository. Ingest and tool tokens never fall back to model
credentials or `AUTH_PASSWORD`.

`POST /api/keet/events` uses `Authorization: Bearer <KEET_INGEST_TOKEN>` instead of
browser Basic/cookie auth. Missing/wrong token returns 401. Missing, malformed or
uninitialized configured session returns 503 without creating that session. Other
methods return 405 after authorization. Requests are limited to 112 KiB while
streaming, including requests without Content-Length. Invalid frames return 400;
oversized bodies return 413; sequence gaps/conflicts return 409. A scheduling
failure returns retryable 503 after persistence; replay the identical event, never
renumber it to bypass reconciliation.

Hosted Keet ingress and tools are **not provisioned**. Existing internal-secret,
instance and personal-session isolation remains enforced. A trusted hosted event
request returns 503, and an untrusted request returns 403. There is no public
hosted webhook, global companion mapping, credential onboarding or Platform UI.

## Event and durable behavior

The authoritative bounded envelope is `KeetFrame` in
[`keet-feed.ts`](../src/server/keet-feed.ts). It contains a UUID `eventId`, positive
sequential `sequence`, native `{deviceId, seq}` message identity, integer timestamp,
`destination: {kind: 'dm'|'group'|'broadcast', groupName}`, `senderLabel`, original
`text`, and optional trigger/reply/image/reaction metadata. Labels are nonblank,
single-line and at most 512 Unicode code points; text is at most 16,000. Up to 16
image descriptors and 16 bounded reaction-context items are accepted. DMs require
`trigger: 'dm'`; groups may trigger on mention, label or reply. Broadcasts never
trigger conversational turns.

An exact replay at a stored sequence returns the current checkpoint without a
second admission. Changed data at that sequence, a reused event identity at a
new sequence, and a sequence gap are rejected. Ordinary group messages retain the
last eight context snippets (500 UTF-16 units each) per destination. The next
trigger consumes that context; broadcast events only advance the checkpoint.

Triggers queue FIFO behind active web/native work. Queue operation identities are
durable. Restart repairs entry association from native request identity and resumes
accepted native work; a terminal result settles without re-admission. Source
association and queue acknowledgement are one SQLite transaction. Native input
and reminder inbox work retain the existing lane behavior.

Pi does not materialize Keet images. Incoming image descriptors retain the original
text plus `[Keet image unavailable in this Pi companion.]`, including image-only
triggered input. No Keet image bytes are downloaded, attached from web photo storage,
or served. Existing ordinary web images keep their current behavior.

## Public display and model attribution

Native user entries store visible text. Backend source tables store attribution,
message identity, group/reaction context and private provider prompt separately.
The provider projection restores the prior Keet DM/Group attribution and authority
rules; neither source inherits the web Human's administrative authority. A native
message's admission timestamp still receives existing host-turn-time projection.
Compaction (including split-turn prefixes), memory extraction
also restore the persisted attribution before provider requests. Memory uses exact
entry IDs; maintenance leaves original stored display text unchanged.

The shared adapter emits only `{kind:'keet', channel:'dm'|'group', senderLabel,
destination}` and original visible text. Private context never enters chat views,
reconnect reads, paginated history, search records or submission DTOs. Ordinary
web input and agent replies retain their existing roles; reminder sources remain
unchanged. Shared contracts/rendering are owned by `lamplit-app`.

## Four optional native tools

Configured self-host harnesses expose `keet_list_destinations`,
`keet_list_members`, `keet_read_recent_messages` and `keet_send_message`. They use
the existing MCP Streamable HTTP client already selected by the project dependency
graph, registered through the current native tool seam. Before any named operation,
the client checks the exact destination against the remote admitted list. Reads
accept 1–50 recent messages. Send requires text (up to 16,000), with the existing
reply, exact-member mention and single reaction fields. Tools are sequential and
never automatically reply to an incoming destination. A lost send response reports
an uncertain outcome and disables automatic transport reconnection/retry; it may
already have delivered. Explicit remote tool errors remain errors. Tokens stay in
server-side headers; redirects are refused.

## Isolated verification and frozen App gate

Run `npm run lint`, `npm run typecheck`, `npm test`. Workerd tests cover ingress
auth/session/hosted boundaries, conflicts/gaps/duplicates, group/broadcast context,
held native work, source persistence/reconstruction and lost-ack/start recovery,
actual shared sockets, private provider projection, unavailable images, configured
native tool execution and disabled tools. Unit tests use owned fake MCP HTTP.
No live chat/gallery, credentials, provider or Keet service is used.

The approved App #3439 artifact replaces previous handoffs. See
[native durable submissions](native-durable-submissions.md) for exact immutable
identity, preparation and local/native acceptance. Generation, native compaction
and memory tests retain private DM/Group attribution while visible entries and
search retain original text. Historical summaries remain readable; there is no
branch navigation or new summary-generation product interface.

No live model/Keet service, credentials or external messages are involved. Local
fake-MCP/native/browser evidence does not establish remote send exactly-once or
production behavior. Orc owns joint native acceptance and later deployment.

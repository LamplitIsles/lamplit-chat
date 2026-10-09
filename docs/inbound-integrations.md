# Independent inbound integrations

Inbound integration settings authorize external events and supply receiver policy.
They grant no tools. Chat's existing [MCP_CONFIG](injected-remote-mcp.md) independently
provides discovered tools; either capability can be enabled alone. Invalid or
unavailable MCP configuration does not block webhook admission. No identity probe
or MCP discovery occurs during admission.

## Configuration and ownership

Free Chat accepts optional `CHAT_INTEGRATIONS` JSON containing only `keet` and/or
`matrix`. Initialize the Companion through authenticated web chat, then set
`COMPANION_SESSION_ID` to its ready UUIDv4. Intake never creates a Free session.
This illustrative JSON contains synthetic values, not real credentials:

```json
{
  "keet": { "webhookToken": "synthetic-keet-receiver-token", "aliases": ["Companion"] },
  "matrix": { "webhookToken": "synthetic-matrix-receiver-token", "aliases": ["Companion"], "selfUserId": "@companion:example.invalid" }
}
```

Tokens are distinct, unchanged visible ASCII U+0021–U+007E, 16–512 characters.
Aliases default to `[]`; at most 16 nonblank strings of 128 UTF-16 units match
literally and case-sensitively. Matrix requires the exact receiving account ID:
`@localpart:server`, no whitespace, at most 255 UTF-16 units. Keet forbids that field.
Unknown and obsolete fields are rejected, including MCP URLs/tokens/references.

Hosted Platform stores a map of existing instance UUIDs to these inbound-only
objects. It also enforces token uniqueness across owners/channels and inequality
with its internal secret. Public delivery uses
`POST /api/integrations/{instanceId}/{keet|matrix}/events` on Platform's APP_ORIGIN.
Platform authenticates, bounds the stream and forwards original bytes with trusted
instance/internal-secret headers, stripping browser credentials and authority.
Chat privately fetches only that owner's settings through the PLATFORM binding at
`GET /internal/chat-integrations/{instanceId}`, with a five-second deadline,
32 KiB response limit and manual redirects. It uses only that registry's existing
ready default Companion. Missing configuration/target returns a sanitized failure;
there is no Free fallback or request-selected session. Chat retains ownership of
`MCP_CONFIG`; Platform stores no MCP connection data. Both PRs must pass paired
acceptance before merge; deployment is a separate operator action.

## HTTP receipts

Chat accepts `POST /api/keet/events` and `POST /api/matrix/events`. Free verifies
`Authorization: Bearer <webhookToken>` before consuming a body or accessing a DO.
Hosted uses its existing trusted Platform guard before resolving selected config.
The actual consumed UTF-8 body is limited to 112 KiB; overflow cancels the stream.
No redirect/retry to another receiver or automatic external reply is implied.

| Status | Meaning |
| --- | --- |
| 200 | Immutable receipt and context or pending input durably stored |
| 400 | Invalid current channel envelope |
| 401 | Wrong Free receiver bearer (or public Platform bearer) |
| 403 | Untrusted Hosted instance/internal-secret request |
| 404 | Channel disabled |
| 405 | Unsupported method after authentication |
| 409 | Same event key with changed content |
| 413 | Actual streamed body exceeds 112 KiB |
| 503 | Config/ready target unavailable, 64 pending cap, or scheduling unavailable |

An identical replay succeeds without another turn. A 503 after persistence may
be ambiguous: retry the same immutable event. Keet deduplicates by eventId;
sequence is a diagnostic high-water mark, not a contiguous cursor or prerequisite.
Matrix deduplicates by room_id plus event_id. Receipt identity includes all original
facts, including non-triggering metadata. Changed content is never silently repaired.

## Receiver policy and native durability

The parsers in `src/server/channel-events.ts` accept unchanged current producers.
Keet requires factual addressing, never the obsolete producer `trigger`. Nonblank
DM text triggers. A Group triggers on native mention, literal identity label,
verified own reply, or configured alias; non-own/unknown replies alone buffer.
Broadcast never wakes and cannot carry reaction snapshots. Image-only events are
acknowledged without a model turn or media download; a nonblank caption counts.
Captioned Keet display retains the existing text-only image explanation.

Matrix rooms all behave as groups. Native mentions of configured selfUserId,
verified replies to that exact identity, or aliases trigger; other nonblank authored
text buffers. Self echoes and blank bodies do neither. Display names, reply pointers
alone and room type never independently trigger.
Original UTF-16 bounds, blank display name/body, mentions, reply pointer, timestamp
and truncated flag remain accepted as produced.

MFA's optional `reply_to_sender_id` is the verified original reply-target author's
full Matrix ID: `/^@[^\s:]+:[^\s]+$/u`, at most 255 UTF-16 units. It requires a
nonblank `reply_to_event_id`; malformed or orphan author fields return 400 before
admission. IDs are never trimmed or clipped. An absent author means unknown target,
so mention/alias rules still apply; another author alone only buffers. The receiver
uses configured `selfUserId` and the existing boolean classifier, with mention,
reply, then alias evaluation. No history/MCP lookup, implicit DM wake or new trigger
configuration is added. The author stays in private immutable original receipts
and source snapshots; public Matrix source fields are unchanged. Changed author
facts on the same room/event key conflict (409), and identical retries never wake
again. See producer #3609 and consumers #3610/#3611 for the linked wire contract.

Context is scoped by owner/channel/room: up to eight recent authored excerpts of
500 UTF-16 units, carried into the next admitted room turn. Reaction snapshots are
private context, deduplicated only when consumed by an admitted turn. Buffering
alone never consumes a reaction receipt. Private excerpts are never public authored
text, search text, or owner instructions.

Both channels share a 64 pending cap checked before receipts/context change. Queue
identities are source-prefixed native request IDs and arrival order is durable.
Busy external work uses public PiHarness `followUp`. Native request lookup repairs
ambiguous placement; settled work is not repeated after restart. Existing archive,
source, media, memory, wake and native conversion associations remain intact. The
receipt confirms admission, not model success or exactly-once remote delivery.

Keet retains the approved Keet source presentation. Matrix public messages show the
original display name (exact sender ID when empty), sender ID and exact room ID in
a separate source header. Body and authored time come from the durable original
event; the full webhook, provider/compaction/memory attribution and buffered context
remain private. No room-name or
sender lookup is added. Initial, reconnect and older reads retain the same source.
See [Matrix source UI and native acceptance](matrix-source-ui.md).

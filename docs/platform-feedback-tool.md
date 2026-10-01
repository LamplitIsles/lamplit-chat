# Hosted platform feedback tool

Hosted companions can autonomously use `submit_platform_feedback` to report
Lamplit product problems and improvement suggestions. The Human has authorized
this tool without confirmation for each submission. Only this tool receives the
standing authorization; the system prompt retains the authorization requirement
for other sending, publishing and credential use. Feedback must exclude secrets
and private conversation transcripts. Humans read machine submissions in the
management app’s **My feedback / 我的反馈**. There is no dedicated chat receipt UI.

## Availability and trusted identity

`PiSession.getHarness` assembles the tool only for `HOSTED_MODE === 'true'`, a
valid instance UUID from the hosted DO identity, and the persisted session UUID.
Rebuilding a harness updates the session’s existing active-tool list. Personal
self-hosted deployments do not expose or execute this tool. The limited prompt
exception is included only when the assembled tool is available, including when
a custom base prompt is configured.

The tool uses the existing `PLATFORM` Service Binding, `CHAT_INTERNAL_SECRET`,
and `PLATFORM_ORIGIN` (default `https://app.lamplit.run`). Missing binding or
secret returns `service_unavailable`; there is no external HTTP fallback.
No new binding, secret, database, browser API or configuration is required.

## Input and internal POST

The model can provide only `problem` (required, nonblank), `circumstances`
(optional), and `expected_improvement` (optional). Each is text of at most 4000
Unicode code points before trimming. Unknown fields and nonstring values are
rejected. Omitted optional fields are sent as empty strings. Serialized JSON
must fit in 64KiB UTF-8, including escaped characters and the generated key.

The internal request is `POST /internal/chat-feedback/:instanceId`, with JSON
content type and `x-lamplit-internal-secret`. Redirects are not followed and no
browser cookies are forwarded. The body contains the three trimmed descriptions
and `submission_key`. Account, source, timestamp and state come from Platform.
The model cannot set identity, status or a submission key.

The key hashes a fixed namespace plus the trusted instance UUID, session UUID
and tool call ID with SHA-256, taking 16 bytes and setting UUID version/variant
bits. Same identities reproduce the same key without a persistent cache;
different calls or sessions produce different keys. An absent call ID prevents
sending. Platform returns the existing record for same-key/same-content replay;
changed content under the same key returns 409. Use a new call for changed content.
There is no automatic retry loop.

## Results and uncertainty

Only HTTP 201 or 200 with a valid machine receipt is success. The tool checks
UUID `id`, UTC `created_at` and status `received`, `processing` or `completed`.
It returns `{ok:true,id,source,status,created_at,message}` with the management app
viewing hint. It omits account and descriptions from Platform’s full record.

Failures return `{ok:false,code,outcome,message}`. `not_sent` covers validation,
missing configuration/call ID and cancellation before transport. `rejected`
covers 401/403 (`forbidden`), 404 (`instance_not_found`), 400/413 (`invalid_input`)
and 409 (`submission_conflict`). Other HTTP responses, network failures,
timeout, cancellation after sending and invalid receipts are `unconfirmed`:
feedback may have been saved. Retry using the same call identity, not a new
submission key. No upstream error body, account, secret or description is echoed.
The request and streamed response share a 10-second bound and caller abort;
response decoding is capped at 64KiB.

## Isolated local acceptance

Use npm for this repository’s dependencies and tests:

```bash
npm run typecheck
npm run lint
npm exec vitest run src/server/platform-feedback-tool.test.ts src/server/create-pi-harness.test.ts src/server/companion-contract.test.ts src/server/turn-time.test.ts
npm run test:worker -- src/server/platform-feedback.worker.test.ts src/server/web-search.worker.test.ts
```

Chat tests use a lightweight fake `PLATFORM` binding to execute the real tool
and verify its internal request and sanitized success/failure results. The actual
PiSession harness and a fake model provider verify registration, session tool
updates and the limited authorization prompt. These tests use chat-owned fixtures.

Platform owns database attribution, idempotent storage, personal list/detail
permissions and management UI tests, including owner visibility and other-account
isolation. Chat contract tests require no Platform checkout or schema files.
No `.env`, installed credentials, live D1, paid provider or deployment is used.

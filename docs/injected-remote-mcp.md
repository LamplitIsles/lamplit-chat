# Deployment-injected remote MCP

Chat accepts an optional backend-only `MCP_CONFIG` JSON secret. It maps trusted
instance IDs to server arrays; each server accepts only `name`, `url`, and optional
`bearerToken`:

```json
{
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": [
    { "name": "notes", "url": "https://operator-selected.example/mcp" },
    { "name": "private", "url": "https://another.example/mcp", "bearerToken": "REPLACE_PRIVATELY" }
  ]
}
```

Use the existing trusted Platform instance mapping to obtain the actual ID;
never infer it from a personal chat hostname. Self-hosted Chat uses the key
`singleton`. Omitted secrets or missing instance entries leave ordinary chat
and existing tools available. No config is read from workspace files or the UI.

Only HTTPS StreamableHTTP with no auth or a fixed Bearer token is supported.
URLs must have no embedded credentials or fragments. Redirects are refused.
Server names must be nonempty. Exposed tool names are `mcp__` plus the configured
server name, `_`, and the original tool name: server `matrix` and tool
`matrix_whoami` become `mcp__matrix_matrix_whoami`. Names are preserved without
hashing or truncation; configure names that fit the native provider constraints
and do not conflict. Calls still use the original remote tool name.
Remote input schemas enter the native Pi registry; text/image/resource results
use Pi's content conversion, with structured results and `isError` preserved.

Discovery runs during existing harness preparation (15 seconds total per server,
in parallel). Failed discovery logs a credential-free error and leaves existing
tools available. A later idle chat submission retries only failed servers before
preparing its native request; successful discoveries stay available without being
queried again. Busy submissions and reads do not retry, and each submission makes
at most one discovery attempt per failed server. Invalid config
also logs an error and disables remote tools. Each operation closes its own
client. Calls have a 30-second deadline and follow native cancellation. External
operations use unsafe replay and are never automatically retried by this adapter;
a failure or cancellation can occur after delivery.

When the real URL and instance mapping are confirmed, prepare the JSON privately
and run `npx wrangler secret put MCP_CONFIG --config wrangler.hosted.jsonc` through
the separately authorized deployment workflow. Secret/deployment updates take
effect through the existing harness lifecycle. Do not commit the JSON/token,
put it in AGENTS.md, or send it to the model. Local workerd regressions verify
discovery recovery and native model-request schemas. Authorized real initialize/list evidence is separate from these
fixtures; it does not establish a production session's current tool selection.

Inbound events are configured separately in [CHAT_INTEGRATIONS](inbound-integrations.md).
Free MCP_CONFIG uses `singleton`; Hosted MCP_CONFIG uses the trusted instance UUID.
MCP-only setup exposes discovered upstream names/schemas without a webhook. Inbound-only
setup admits events without tools, malformed MCP config or reachable peers. There is
no dedicated Keet/Matrix tool wrapper or receiver identity probe; upstream tool names
and capabilities come from discovery. External send outcomes can remain uncertain.

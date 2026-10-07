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
Names must be nonempty and unique within an instance. Tool names use a server
prefix, sanitized names and a deterministic digest within the 64-character limit.
Remote input schemas enter the native Pi registry; text/image/resource results
use Pi's content conversion, with structured results and `isError` preserved.

Discovery runs during existing harness preparation (five seconds per server,
in parallel). Failed discovery logs a credential-free error and leaves existing
tools available; it is retried on the next harness preparation. Invalid config
also logs an error and disables remote tools. Each operation closes its own
client. Calls have a 30-second deadline and follow native cancellation. External
operations use unsafe replay and are never automatically retried by this adapter;
a failure or cancellation can occur after delivery.

When the real URL and instance mapping are confirmed, prepare the JSON privately
and run `npx wrangler secret put MCP_CONFIG --config wrangler.hosted.jsonc` through
the separately authorized deployment workflow. Secret/deployment updates take
effect through the existing harness lifecycle. Do not commit the JSON/token,
put it in AGENTS.md, or send it to the model. This implementation has only local
fake-service evidence; the target's real config and deployment remain pending.

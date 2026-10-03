# Native provider/model selection

Chat is the model catalog authority for Platform and personal deployments. The
catalog and runtime use installed `@earendil-works/pi-ai` 0.99.1 factories. There
is no remote catalog refresh or custom endpoint editor.

## Supported scope

| Provider ID | API-key chat protocol |
| --- | --- |
| `deepseek` | OpenAI completions with native DeepSeek compatibility |
| `openai` | OpenAI Responses |
| `anthropic` | Anthropic Messages |
| `google` | Google Generative AI |
| `openrouter` | Native OpenAI completions or Anthropic Messages, as catalogued |

These five factories are enabled and bundle/run in the isolated workerd tests.
Only their chat models are exposed; OpenRouter image-generation and classifier
models are excluded. This is an audited API-key scope, not support for every Pi
provider or every authentication method. OAuth/subscription login is not enabled,
including the OAuth methods attached to OpenAI, Anthropic and OpenRouter factories.

All other built-in providers are excluded in this release. Account/deployment or
non-key auth paths include Amazon Bedrock, Azure OpenAI, Google Vertex, GitHub
Copilot, OpenAI Codex, Cloudflare Workers AI and Cloudflare AI Gateway. The other
factories (Ant Ling, Baseten, Cerebras, Fireworks, Groq, Hugging Face, Kimi Coding,
Meta, MiniMax/CN, Mistral, Moonshot AI/CN, NVIDIA, OpenCode/Go, Qwen token-plan
variants, Radius, Together, TypeSafe, Vercel AI Gateway, xAI, Xiaomi and its
token-plan variants, Z.AI and Z.AI Coding CN) are outside the audited scope;
exclusion does not assert that all require OAuth or cannot run in workerd.

Each selected model retains native API, endpoint, context window, maximum output,
input support, reasoning, thinking-level map and compatibility metadata. Catalog
capacity is the model's capacity, not the number of tokens billed across a session.
The model ID and capabilities are never synthesized from a user endpoint.

## Selection and options

Platform saves one active provider/model and a separate encrypted key/last settings
for each configured provider. Returning A → B → A reuses A's saved key. Chat reads
the active account selection before a safe subsequent task. An in-flight reply
keeps its running harness, provider and key. No provider fallback occurs on invalid
or missing configuration. Replies, memory extraction and companion compaction all
use the selected native provider/model; there is no independent memory selector.

`thinkingLevel: null` uses Pi's native harness/adapter behavior. Explicit levels
must be in the SDK's supported level list, including `off`; the SDK maps them to
the provider's actual thinking protocol. `maxOutputTokens: null` omits a user cap.
An explicit cap is a positive integer no greater than native `maxTokens`. It is a
request option, not a replacement model capability. The SDK may fit output to
remaining context and account for a provider's thinking budget. Neither native
defaults nor these options promise that a model will produce a nonempty reply.
Existing empty-reply failure notices remain in place and private thinking stays
out of shared chat.

Pi harness 0.99.1 does not forward `maxTokens` in its harness stream options. Chat
uses the public native Provider `streamSimple` seam to inject that option, then
calls the original factory implementation. No protocol payload is handwritten.
Each harness/maintenance request owns a fresh `InMemoryCredentialStore`, with
only its active provider's API key. Its injected `AuthContext` returns no ambient
environment values and no files. Hosted model keys never fall back to Worker
secrets, user credential files, or another account/provider.

New images require the selected model's native image input support as well as R2.
Existing photos/album records remain readable after switching to text-only. Pi's
native transcript projection replaces historical model images with truthful
omission placeholders; persisted history is untouched.

## Internal integration contract (#3246 / #3247)

`GET /internal/model-catalog` returns:

```json
{"providers":[{"id":"provider-id","name":"Provider name","models":[{"id":"model-id","name":"Model name","baseUrl":"native endpoint","contextWindow":128000,"maxTokens":16384,"input":["text","image"],"thinkingLevels":["off"]}]}]}
```

The numbers/levels above illustrate the shape only. Actual data always comes from
native factories and `getSupportedThinkingLevels`. `baseUrl` is read-only metadata
for exact existing-config conversion, not a selectable endpoint. Responses,
including rejection/method errors, use `Cache-Control: no-store`. Catalog lookup
makes no upstream provider call or Platform credential lookup.

Hosted access uses the current trusted `x-lamplit-internal-secret`, valid
`x-lamplit-instance` and same-Origin guard. Personal deployments use current owner
Basic/cookie authentication. Platform's authenticated personal-host
`GET /api/model-catalog` forwards this route using its trusted CHAT binding headers.

Chat resolves Platform's authenticated
`GET /internal/chat-model/{instanceId}` response exactly as:

```json
{"provider":"provider-id","model":"model-id","apiKey":"account-provider-key","thinkingLevel":null,"maxOutputTokens":null}
```

No `baseUrl` or capability overrides are accepted as authority. Unknown models,
missing keys, unsupported thinking or invalid caps fail locally without an
upstream request. Platform's `PUT /api/model-settings` accepts the same selection
without requiring `apiKey` on every save; omission retains only that provider's
stored key. Platform account responses expose `apiKeyConfigured`, never the key.

## Personal deployment configuration

Set `MODEL_PROVIDER` and `AI_MODEL` to exact enabled catalog IDs in
`wrangler.jsonc`. Set the server-only `MODEL_API_KEY` secret and independent owner
`AUTH_PASSWORD`. Example: `openrouter` / `openai/gpt-4o`. Optional
`MODEL_THINKING_LEVEL` and `MODEL_MAX_OUTPUT_TOKENS` are empty for native defaults;
otherwise use a supported level and positive integer within the model limit.
The personal resolver uses the same local validation and factory as hosted mode.

`MODEL_BASE_URL`, `MODEL_CONTEXT_WINDOW`, `MODEL_MAX_TOKENS` and `AI_MEMORY_MODEL`
are removed. Operators must select a native provider/model; custom URLs and
handwritten capacities are no longer supported. Search/voice credentials remain
independent.

## Coordinated release and verification

This change requires the Platform selection/schema change from spec #3246. Before
release, jointly test the actual isolated Platform handler with test-owned SQL and
this actual Chat handler/Pi DO: catalog → save A → save B → switch A without a key
→ completed native chat, capacity and advanced options. Include wrong Origin and
cross-account rejection, and record both final commits. Both merges wait for this
joint acceptance; local Chat completion alone is insufficient.

Existing deployed encrypted keys/model selections must be preserved. Use Platform's
fixture-verified conversion against the exact catalog `baseUrl` and model IDs.
Before a separately authorized deployment, inspect its unmatched-row report and
provide explicit operator mapping for any unmatched endpoint/model. Never silently
reassign or discard an old key. Preserve an authorized backup, apply the documented
Platform schema/conversion steps, and release the matching pair of internal DTOs
as one coordinated cutover. Chat adds no storage migration or old/new read path.
This implementation run performs no live conversion, deployment or production read.

`npm test`, `npm run lint`, `npm run typecheck`, shared-App build and hosted Wrangler
dry-run are the local gates. `model-catalog.worker.test.ts` exercises native
protocols/tools, account selection/options, catalog auth/no-network behavior,
image history and native maintenance with test-only upstream responses. Existing
chat, image recovery, empty-reply and quiet-compaction suites remain relevant.
`fixtures/native-api-setup.ts` preloads public adapters only in Vitest so dynamic
module loading cannot retain a test Durable Object's I/O context.

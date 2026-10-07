# Native provider/model selection

Chat is the model catalog authority for Platform and personal deployments. The
catalog and runtime use installed `@earendil-works/pi-ai` 1.0.4 factories. There
is no remote catalog refresh or custom endpoint editor.

## Supported scope

The public built-in factories in installed Pi 1.0.4 are audited. These
37 providers (32 added by #3255) expose native chat models, accept one stored
key/token without extra fields, and completed isolated workerd fixture replies
through the actual hosted Wrangler bundle. Each listed protocol is exercised;
these fixtures establish runtime/protocol compatibility, not paid-service access
or the validity/entitlements of a real key. Native regional/token-plan IDs and
credential namespaces stay distinct even when auth environment names coincide.

| Enabled provider ID | Key-only authentication and native protocol |
| --- | --- |
| `amazon-bedrock` | Bearer token; Bedrock ConverseStream |
| `ant-ling` | Stored API key; OpenAI completions |
| `anthropic` | Stored API key; Anthropic Messages |
| `baseten` | Stored API key; OpenAI completions |
| `cerebras` | Stored API key; OpenAI completions |
| `deepseek` | Stored API key; OpenAI completions |
| `fireworks` | Stored API key; Anthropic Messages, OpenAI completions |
| `github-copilot` | Stored token; Anthropic Messages, OpenAI completions, OpenAI Responses |
| `google` | Stored API key; Google Generative AI |
| `google-vertex` | Stored API key; Vertex express |
| `groq` | Stored API key; OpenAI completions |
| `huggingface` | Stored token; OpenAI completions |
| `kimi-coding` | Stored API key; Anthropic Messages |
| `meta` | Stored API key; OpenAI Responses |
| `minimax` | Stored API key; Anthropic Messages |
| `minimax-cn` | Stored API key; Anthropic Messages |
| `mistral` | Stored API key; Mistral native chat |
| `moonshotai` | Stored API key; OpenAI completions |
| `moonshotai-cn` | Stored API key; OpenAI completions |
| `nvidia` | Stored API key; OpenAI completions |
| `openai` | Stored API key; OpenAI Responses |
| `opencode` | Stored API key; Anthropic Messages, Google Generative AI, OpenAI completions, OpenAI Responses |
| `opencode-go` | Stored API key; Anthropic Messages, OpenAI completions, OpenAI Responses |
| `openrouter` | Stored API key; Anthropic Messages, OpenAI completions |
| `qwen-token-plan` | Stored API key; OpenAI completions |
| `qwen-token-plan-cn` | Stored API key; OpenAI completions |
| `qwen-token-plan-individual` | Stored API key; OpenAI completions |
| `radius` | Stored API key; Pi Messages |
| `together` | Stored API key; OpenAI completions |
| `vercel-ai-gateway` | Stored API key; Anthropic Messages |
| `xai` | Stored API key; OpenAI Responses |
| `xiaomi` | Stored API key; OpenAI completions |
| `xiaomi-token-plan-ams` | Stored API key; OpenAI completions |
| `xiaomi-token-plan-cn` | Stored API key; OpenAI completions |
| `xiaomi-token-plan-sgp` | Stored API key; OpenAI completions |
| `zai` | Stored API key; OpenAI completions |
| `zai-coding-cn` | Stored API key; OpenAI completions |

Bedrock uses Pi's public `bedrockProviderModule` and
`setBedrockProviderModule` static-registration exports: its default Node-only
variable-specifier lazy import cannot execute in a bundled workerd module.
The native adapter resolves region from the catalog endpoint and uses the stored
bearer token without IAM profiles or extra region/account fields. No AWS protocol
or model metadata is reimplemented. Vertex's native express API-key branch
resolves `aiplatform.googleapis.com` without ADC/project/location fields, while
retaining the native catalog's read-only endpoint metadata. Copilot uses its
native stored token path and headers; this interface does not obtain, refresh or
exchange GitHub tokens. Radius uses its built-in baseline models and Pi Messages;
Chat does not invoke remote catalog refresh or persist a dynamic catalog.

The complete excluded inventory is:

| Excluded provider ID | Installed native evidence / reason |
| --- | --- |
| `azure` | Native chat models have empty baseUrl; adapter requires resource name or deployment endpoint. |
| `cloudflare-ai-gateway` | Native auth requires account ID and gateway ID in addition to key. |
| `cloudflare-workers-ai` | Native auth requires account ID in addition to key. |
| `openai-codex` | Legacy ChatGPT path exposes only OAuth; no API-key auth method. |
| `typesafe` | API-key method exists, but getModels() is empty; only classifier models. |

Exclusion does not assert these services cannot run in Cloudflare with additional
configuration. Azure's adapter explicitly rejects a missing resource endpoint;
Cloudflare auth returns no resolution with a lone key. No extra settings fields
or credential environment are introduced. The enabled factories' classifier and
image-generation models remain excluded by native `getModels()` chat filtering.
OAuth/subscription alternatives on enabled factories are not exclusion reasons;
Chat enables their independent key-only paths, not OAuth login, IAM or ADC.

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

Chat uses the public native Provider `streamSimple` seam to apply the account's
output cap, then calls the original factory implementation. No provider protocol
payload is handwritten. Native model counts come from the current compiled catalog.
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

## Verification and release boundary (#3255)

Platform already dynamically forwards the exact catalog DTO and validates/stores
arbitrary catalog provider IDs. No Platform/App/schema change or key conversion
is required for this expansion. The unchanged authenticated catalog/save/internal
model handler is exercised with its existing test-owned SQL fixture against the
actual Chat Wrangler bundle: save a newly enabled provider, read it, complete
native replies and maintenance, then return to the previous provider without
supplying its key again. Wrong Origin, account and internal-secret requests reject
without native calls. This joint consumer check gates merge; deployment requires
separate authorization and the documented repository deploy step.

`npm test`, `npm run lint`, `npm run typecheck`, shared-App build and hosted Wrangler
dry-run are the local gates. `model-catalog.worker.test.ts` verifies the complete
installed factory inventory, native model/options consistency, account key
isolation, catalog auth/no-network behavior, native tools and maintenance. Existing
image history, empty-reply, quiet-compaction, held-reply and navigation regressions
remain gates. `fixtures/native-api-setup.ts` preloads public adapters only in
Vitest so dynamic module loading cannot retain a test Durable Object's I/O context.

The actual production-bundle smoke uses isolated Miniflare/workerd SQLite DOs,
real shared sockets, only synthetic credentials and an intercepted outbound
service; every enabled provider/protocol completes a native reply without Vitest
preloading. Record the exact bundle hash, gzip size and startup measurement along
with catalog bytes (below Platform's existing 4MiB limit). No live account,
provider request, credential file, production migration or deployment is part of
these checks. Installed SDK/dependency versions and the explicit factory list stay
pinned; expanding or upgrading this list requires the same native audit.

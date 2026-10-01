# Voice input

Tap the empty-text microphone to switch modes; then hold the center button, release to recognize, or slide up at least 60 CSS pixels to cancel. Space and Enter work as hold keys; release recognizes and Escape cancels. The keyboard icon returns to text. Results are plain editable text, with existing attachments retained. Recognition never sends a chat message. Edit and explicitly Send when ready.

Capture requires HTTPS or localhost, microphone permission and MediaRecorder with an allowlisted audio format. Denial/unsupported capture leaves text available. Retry records a new take. Five minutes stops capture and recognizes with a limit notice. Size failures retain the draft and permit retry. Capture ends on cancellation, pointercancel, tab hide, keyboard blur, browser back, session change or unmount. Release while permission is pending discards the late stream without starting a recorder. Session and draft guards discard stale transcription results.

## Self-host setup

Voice has its own **Beijing-region Alibaba Model Studio key**, separate from `MODEL_API_KEY`. Add the optional Worker secret using the same Wrangler configuration as your self-host deployment:

```sh
npx wrangler secret put VOICE_API_KEY
```

The fixed provider is Alibaba Model Studio, model `qwen3-asr-flash`, at `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` (Beijing). There is no provider/region/URL variable or SDK. Unset the secret to disable voice. Use the normal documented build/deploy procedure for installation. Model Studio usage may incur charges. Real paid provider/codec recognition has not been verified by the isolated fixture tests.

Hosted chat obtains only the actual instance's current config from the authenticated `PLATFORM` binding at `GET /internal/chat-voice/<instanceId>`. The contract returns `{enabled:false}` or `{enabled:true,apiKey:string}`. An unavailable/malformed/redirecting config fails closed, including when a self-host key exists. The browser receives availability only. Instance owners configure voice at hosted `/settings#voice`; the platform stores the key encrypted and relays recognition through the authenticated chat proxy. Enable, key replacement and disable changes apply to the next recognition request.

## HTTP and limits

Existing password auth protects self-host endpoints; trusted instance/internal-secret headers protect hosted endpoints. Cross-origin POST is rejected. Responses use `Cache-Control: no-store`.

- `GET /api/voice/capability` → `{available:boolean}`. No ASR call. The browser refreshes on load, window focus and pageshow.
- `POST /api/voice/transcribe` accepts `{audioBase64:string,mediaType:string,durationMs:number}` and returns `{text:string}`. Every invocation resolves the current config again.
- Base64 must be canonical, nonempty RFC 4648, including padding bits. MIME is allowlisted by `voice-contract.ts`; parameters such as `codecs=opus` are retained. Duration must be finite and positive, at most 300,000ms.
- The complete ASCII data URL, including MIME/prefix/padding, is at most **10,000,000 bytes**. JSON is streamed and bounded to **10,001,024 bytes**, independently of Content-Length. Malformed audio returns `invalid_audio` (400), oversize 413.
- Provider JSON is bounded to **128KiB**, with nonempty trimmed text up to **20,000 Unicode characters**. Configuration has a 5s deadline within the 60s recognition deadline. Redirects are rejected.
- Safe errors are `{code,error}`: `voice_disabled` (409), `config_unavailable` (503), `invalid_key`, `rate_limited`, `upstream_error`, `transcript_invalid` (502), `timeout` (504), `cancelled` (499). Authentication remains 401/403. Raw provider payloads and keys are never relayed.

## Privacy and cancellation

Recording stays in browser memory and is sent only for recognition. The Worker forwards a complete Base64 data URL to the fixed provider; it does not persist or log audio, keys or recognized text. A transcript enters normal chat persistence only after explicit Send. Consult the provider's data/retention policy for its processing.

Cancellation before submission makes no recognition request. After submission, cancellation releases local capture and discards the result; it cannot guarantee avoidance of provider processing or billing. The cancelled state distinguishes an unsubmitted recording from a cancelled recognition. Configuration/capability checks do not incur ASR calls.

## Isolated verification and joint fixture

Install the existing root/frontend npm dependencies, then run these in the checkout:

```sh
node scripts/voice-input-local.mjs
node frontend/node_modules/vite/bin/vite.js --config frontend/fixtures/voice/vite.config.mjs
node scripts/voice-input-ui-check.mjs
```

The local Worker at `127.0.0.1:8898` runs the actual Worker fetch path with test-owned temporary storage, fictional secrets, isolated Wrangler config/cache/log directories, a child environment without inherited Cloudflare credentials, and a fake provider; no repository `.env`/`.dev.vars` or external network is used. The real Companion renders at `127.0.0.1:5198`, with synthetic media and the actual Worker transcription endpoint through a local proxy. The browser check requires `agent-browser`; it uses one isolated browser session and records checks/screenshots under untracked `.scratch/voice-input/`. It does not access a user's browser, microphone, account or connected phone.

Fixture owner A is `11111111-1111-4111-8111-111111111111` (enabled); B is `22222222-2222-4222-8222-222222222222` (disabled). Use `x-lamplit-instance` and `x-lamplit-internal-secret: fixture-voice-internal-secret`. Local-only `GET/POST /__fixture/state` inspects/changes `{enabled,apiKey,text,status,delayMs,calls}`; `calls` counts fake paid-provider submissions. This control endpoint is only in the temporary fixture entry, never in the production Worker.

For the joint fixture start `node scripts/voice-input-local.mjs --platform-service=<test-owned-local-platform-worker-name>`. Its `PLATFORM` binding then uses that real local service rather than the fake internal config. Configure the platform's actual chatProxy to service `lamplit-chat-voice-fixture` with the fictional shared internal secret. The fake provider remains mandatory and all non-provider external fetches are rejected. The platform worker must use fresh temporary D1/encryption fixtures with two owners. Verify save/skip/capability make zero provider calls; key replacement/disable affects the next call; owner isolation, safe relay/bounds/auth/deadline/cancel work; and chat result still requires explicit Send.

Runtime tests: `src/server/voice.worker.test.ts` exercises authenticated Worker fetch; `src/companion/composer-voice.test.ts` exercises capture/composer admission and cleanup. UI checks exercise pointer/keyboard holds, cancellation, permission races, stale session/draft guards, draft-only recognition, explicit send, responsive/dark rendering and browser back. Physical Android touch/software-keyboard behavior remains unverified when no test-owned device is available.

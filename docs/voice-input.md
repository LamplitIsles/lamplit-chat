# Voice input

Tap the microphone to start, then tap Stop to finish. Audio is recognized while you speak; only the final text enters the editable draft, at the selection captured on start. The microphone remains alongside Send with existing text. Surrounding text and attachments remain intact; another take inserts after the restored cursor. Recognition never sends a message. During setup, capture and finishing the draft is read-only and Send/command completion are locked. Cancel/Escape returns silently. Failures leave text available for retry. Space/Enter activate the focused button normally.

Capture requires HTTPS or localhost, microphone permission, AudioWorklet and an actual 16kHz AudioContext. Unsupported sample rates fail back to text without codec/resampling fallbacks. Five minutes flushes the last frame and finishes. Cancel, tab hide, pagehide, browser navigation, session change and unmount close capture/socket; late permission grants release their tracks. Captured session, draft revision and string snapshot reject results after draft recovery or change. There is no partial transcript, success/cancel banner, voice mode switch or artificial delay after Stop.

## Configuration and installation

Self-host voice uses the existing optional **`VOICE_API_KEY` Worker secret**, a Beijing Alibaba Model Studio key separate from `MODEL_API_KEY`:

```sh
npx wrangler secret put VOICE_API_KEY
npm run build
npx wrangler deploy
```

The fixed model is `qwen-audio-3.1-asr-flash-streaming`, upstream `https://dashscope.aliyuncs.com/api-ws/v1/inference` upgraded to WebSocket with server-side Bearer authorization. This uses run-task/binary PCM/finish-task; it is different from `qwen3-asr-flash-realtime`. No SDK, model selector, new secret or configuration schema is needed. Unset the secret to disable self-host voice. The bundled worklet is emitted as a local Vite asset in the normal build.

Hosted chat resolves fresh owner-instance settings for each connection through `PLATFORM GET /internal/chat-voice/<instanceId>`, authenticated with `x-lamplit-internal-secret`. Its unchanged response is `{enabled:false}` or `{enabled:true,apiKey:string}`. Missing/malformed/redirecting settings fail closed, without self-host fallback. Hosted owners configure the encrypted independent key at `/settings#voice`. Key replacement/enable/disable applies to the next connection. Hosted installation uses the repository's normal `npm run build` then `npx wrangler deploy --config wrangler.hosted.jsonc`; merging does not deploy. This implementation run does not deploy or merge.

## Pinned normalized wire contract (spec #3008)

Existing self-host password auth and hosted instance/internal-secret auth protect the routes. The platform proxy must preserve 101 and inject the authorized instance/internal secret. WebSocket **Origin must exactly equal the request URL origin**, including on hosted routes; missing Origin is rejected. Proxy implementations that rewrite the request URL must preserve this same-origin check correctly. Authentication/Origin errors are HTTP 401/403, missing upgrade 426. Capability and HTTP errors use `Cache-Control: no-store`.

- `GET /api/voice/capability` → `{available:boolean}`; no provider call. Browser refreshes on load/focus/pageshow.
- `GET /api/voice/stream` with WebSocket upgrade. Browser sends binary **PCM16 little-endian, mono, actual 16000Hz**. Normal frames are 100ms/3200 bytes; every frame is nonempty, even, at most 16KiB. No whole-take audio buffer.
- Browser text commands are exactly `{"type":"finish"}` or `{"type":"cancel"}`, with no other fields and at most 128 UTF-8 bytes. Flush all PCM before finish. Send PCM only after ready.
- Server sends `{"type":"ready"}`, then exactly one `{"type":"result","text":"…"}` after successful task-finished, or terminal `{"type":"error","code":"…"}`. Codes: `voice_disabled`, `config_unavailable`, `invalid_key`, `rate_limited`, `upstream_error`, `timeout`, `cancelled`, `invalid_audio`, `transcript_invalid`. No result follows cancel/error. Raw provider frames, keys, usage and intermediate text never reach the browser.
- Raw PCM cap **9,600,000 bytes**, five-minute browser capture. Worklet caps sample count too. Browser aborts at a **256KiB** send queue. Startup deadline 15s including a 5s config deadline; finish deadline 20s; server absolute lifetime **320s from ready**, including idle/no-finish connections. Every terminal path closes sockets/capture/timers.
- Provider frames are bounded to 128KiB; finalized nonempty text to 20,000 Unicode characters. Validate task ID/event shape. Deduplicate finalized `sentence_end:true` text by positive integer `sentence_id`, sort by ID, ignore intermediate/heartbeat text, and reject missing/invalid final or abnormal close.

Chat emits run-task with a unique task_id, streaming:duplex, task_group:audio/task:asr/function:recognition, model above, parameters `{format:"pcm",sample_rate:16000,semantic_punctuation_enabled:false,max_sentence_silence:400}`, input `{}`. Matching task-started gates ready/audio. Finish emits finish-task with the same task_id, streaming:duplex, payload input `{}`. The obsolete whole-file `/api/voice/transcribe` and `/api/voice-test` contracts are removed.

## Privacy and cancellation

While recording, PCM streams through the Worker to Alibaba for processing. Cancellation closes an already streaming call and discards its result; **it cannot undo processing or guarantee avoided billing**. Permission/worklet setup occurs before opening the provider stream. Capability/settings save/skip make no recognition calls. The Worker does not persist or log audio, keys or recognized text. Recognized text enters normal chat persistence only after explicit Send. Consult Alibaba's retention/data policies; usage may incur charges. Fixture timings are pipeline evidence, not vendor latency guarantees.

## Committed local fixture and platform handoff

Install the existing npm dependencies in root and frontend. Run in separate shells, using free test-only ports (defaults 8898/5198):

```sh
VOICE_FIXTURE_PORT=8896 node scripts/voice-input-local.mjs
VOICE_FIXTURE_PORT=8896 VOICE_UI_PORT=5196 node frontend/node_modules/vite/bin/vite.js --config frontend/fixtures/voice/vite.config.mjs
VOICE_FIXTURE_PORT=8896 VOICE_UI_PORT=5196 node scripts/voice-input-ui-check.mjs
npx vitest run --config vitest.worker.config.ts src/server/voice.worker.test.ts
```

The actual workerd Worker fetch uses fixture-owned temporary storage, config/cache/logs, fictional credentials and a fake WebSocket upstream, with inherited Cloudflare credentials and repository env loading excluded. The actual Companion/browser uses a test-owned oscillator, real AudioContext/AudioWorklet and actual normalized WebSocket through the Vite proxy. It does not use a user tab, physical microphone, live account or paid provider. Browser checks require `agent-browser`, use an isolated session, and save checks/screenshots under untracked `.scratch/voice-streaming/`.

Stable ownership: `frontend/src/lib/companion/voice-contract.ts` owns normalized limits/types; `client/voice-input.ts` owns local streaming capture/transport; `client/voice-worklet.js` owns PCM framing/flush; `src/server/voice.ts` owns config/3.1 upstream normalization. Platform can import the contract/controller/worklet with its own bundler and same-origin URL, or implement the same wire; ensure `?url&no-inline` worklet asset is emitted by its normal build. `CompanionActions.voiceStreamUrl()` supplies the authenticated same-origin endpoint. No shared package/provider abstraction is required.

Fixture owner A `11111111-1111-4111-8111-111111111111` is enabled; B `22222222-2222-4222-8222-222222222222` disabled. Internal secret: `fixture-voice-internal-secret`. Local-only `GET/POST /__fixture/state` reads/updates `{enabled,apiKey,text,status,delayMs,startDelayMs,calls,frames,bytes,events,closes}`. Status controls fake upgrade failure; delayMs holds final; startDelayMs holds task-started; calls counts provider upgrades; events records PCM byte counts and run-task/finish-task timestamps. Only synthetic fixture keys/text appear there. This control route exists only in the temporary fixture entry.

Joint gate: start chat with `--platform-service=<test-owned-local-platform-worker-name>` and optional `VOICE_FIXTURE_NAME`, `VOICE_REGISTRY_PATH`, `VOICE_INSPECTOR_PORT`. PLATFORM then targets the real local platform service. Configure platform chatProxy to service `lamplit-chat-voice-fixture` with the fictional shared secret. Use fresh temporary D1/encryption fixtures and two owners; demonstrate auth/101/owner isolation, immediate settings changes, zero paid calls on save/skip/capability, no key in browser, normal PCM→finish→draft/test result, cancel/failure/stale behavior. Both PR merges wait for Owner to run and accept this cross-repository gate. Chat local verification alone does not satisfy it.

Native Android microphone/software-keyboard behavior and real 3.1 vendor latency are unverified in this isolated run. Tests cover actual workerd protocol and actual browser/worklet behavior with synthetic audio.

Primary references: [3.1 client events](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events), [server events](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events), [guide](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide), [Cloudflare WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/).

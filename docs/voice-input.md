> Current default build/native acceptance: [default-shared-frontend.md](default-shared-frontend.md).
> Earlier artifact commands below are historical evidence, not the current delivery gate.

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

## Public normalized wire contract (spec #3044)

Existing self-host password auth and hosted instance/internal-secret auth protect the routes. The platform proxy must preserve 101 and inject the authorized instance/internal secret. WebSocket **Origin must exactly equal the request URL origin**, including on hosted routes; missing Origin is rejected. Proxy implementations that rewrite the request URL must preserve this same-origin check correctly. Authentication/Origin errors are HTTP 401/403, missing upgrade 426. Capability and HTTP errors use `Cache-Control: no-store`.

- `GET /api/voice/capability` → `{available:boolean}`; no provider call. Browser refreshes on load/focus/pageshow.
- `GET /api/voice/stream` with WebSocket upgrade. Browser sends binary **PCM16 little-endian, mono, actual 16000Hz**. Normal frames are 100ms/3200 bytes; every frame is nonempty, even, at most 16KiB. No whole-take audio buffer.
- Browser text commands are exactly `{"type":"finish"}` or `{"type":"cancel"}`, with no other fields and at most 128 UTF-8 bytes. Flush all PCM before finish. Send PCM only after ready.
- Server sends `{"type":"ready"}`, then exactly one `{"type":"result","text":"…"}` after successful task-finished, or terminal `{"type":"error","code":"…"}`. Codes: `voice_disabled`, `config_unavailable`, `invalid_key`, `rate_limited`, `upstream_error`, `timeout`, `cancelled`, `invalid_audio`, `transcript_invalid`. No result follows cancel/error. Raw provider frames, keys, usage and intermediate text never reach the browser.
- Raw PCM cap **9,600,000 bytes**, five-minute browser capture. Worklet caps sample count too. Browser aborts at a **256KiB** send queue. Startup deadline 15s including a 5s config deadline; finish deadline 20s; server absolute lifetime **320s from ready**, including idle/no-finish connections. Every terminal path closes sockets/capture/timers.
- Provider frames are bounded to 128KiB; finalized nonempty text to 20,000 Unicode code points. Validate task ID/event shape. Deduplicate finalized `sentence_end:true` text by positive integer `sentence_id`, sort by ID, replace duplicate finals, ignore intermediate/heartbeat text, and reject unresolved unfinished sentences, missing/invalid final or abnormal close. Late intermediate updates cannot reopen finalized IDs.

Chat emits run-task with a unique task_id, streaming:duplex, task_group:audio/task:asr/function:recognition, model above, parameters `{format:"pcm",sample_rate:16000,semantic_punctuation_enabled:false,max_sentence_silence:400}`, input `{}`. Matching task-started gates ready/audio. Finish emits finish-task with the same task_id, streaming:duplex, payload input `{}`. The obsolete whole-file `/api/voice/transcribe` and `/api/voice-test` contracts are removed.

## Privacy and cancellation

While recording, PCM streams through the Worker to Alibaba for processing. Cancellation closes an already streaming call and discards its result; **it cannot undo processing or guarantee avoided billing**. Permission/worklet setup occurs before opening the provider stream. Capability/settings save/skip make no recognition calls. The Worker does not persist or log audio, keys or recognized text. Recognized text enters normal chat persistence only after explicit Send. Consult Alibaba's retention/data policies; usage may incur charges. Fixture timings are pipeline evidence, not vendor latency guarantees.

## Committed local fixture and platform handoff

Use the root npm lockfile and the adjacent compiled contracts package. The current
six-suite native host and exact frozen voice runner commands are in
[default-shared-frontend.md](default-shared-frontend.md). The retained protocol
fixture can also be run independently:

```sh
VOICE_FIXTURE_PORT=8896 node scripts/voice-input-local.mjs
npx vitest run --config vitest.worker.config.ts src/server/voice.worker.test.ts
```

Its actual workerd Worker uses test-owned storage, synthetic keys and a fake
WebSocket upstream. The removed frontend fixture/Vite build is no longer a test
entry. Current browser acceptance uses the approved production App, real
AudioContext/AudioWorklet and actual native relay, with synthetic microphone input.

Stable ownership: the compiled public `@lamplit/contracts/voice` export from adjacent `lamplit-app/packages/contracts` owns browser-boundary constants, types and runtime validation. The relay uses `parseVoiceControl`, `validateVoiceFrameBytes`, and `validateVoiceServerEvent`; ready/finish lifecycle and bounded Qwen parsing stay in `src/server/voice.ts`. Install root dependencies with npm after the app worker has built the package; the existing file dependency resolves its compiled exports. Chat snapshots use the common package capabilities without a fixed voice flag; capability GET is authoritative. The shared App owns capture/controller/worklet and public wire definitions. Retained local modules support existing behavior checks; no old UI serving/build entry remains. No provider framework is introduced.

Fixture owner A `11111111-1111-4111-8111-111111111111` is enabled; B `22222222-2222-4222-8222-222222222222` disabled. Internal secret: `fixture-voice-internal-secret`. Local-only `GET/POST /__fixture/state` reads/updates `{enabled,apiKey,text,status,delayMs,startDelayMs,calls,frames,bytes,events,closes}`. Status controls fake upgrade failure; delayMs holds final; startDelayMs holds task-started; calls counts provider upgrades; events records PCM byte counts and run-task/finish-task timestamps. Only synthetic fixture keys/text appear there. This control route exists only in the temporary fixture entry.

## Shared frozen browser acceptance

The current Owner-approved parent archive and separately reviewed voice runner
are documented in [default-shared-frontend.md](default-shared-frontend.md).
Actual Pi/workerd voice acceptance passes at 390/1280 with native image intake
enabled. Actual read-only Platform-handler hosted voice acceptance also passes
at those widths on test-owned D1/DO/R2. Parent browser/contracts/runners remain
unchanged; the corrected runner is copied beside the original and hashed before
and after acceptance.

Earlier #3044 acceptance used browser SHA256
`0525f67e3d9d0c142425fb3db26a65727b9049536a203434cf8099aca844439e`
and build manifest SHA256
`381a3ad65c64275b673f4215190914a6a8abad305e7f713d7d42e72b32f6cf70`.
Those historical artifacts are not the current delivery gate. Owner joint
App/Pi/CFL/Platform review remains required before merge; no live restart,
deployment or paid provider call was performed by this implementation.

Native Android microphone/software-keyboard behavior and real 3.1 vendor latency are unverified in this isolated run. Tests cover actual workerd protocol and actual browser/worklet behavior with synthetic audio.

Primary references: [3.1 client events](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events), [server events](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events), [guide](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide), [Cloudflare WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/).

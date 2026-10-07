# Public native runtime gate

This fixture verifies ticket #3440 of spec #3436 independently of the App contract and the product Chat DO. It uses the public `agents/harness/pi` and `@earendil-works/pi-durable` exports, a Pi AI faux provider, and Worker-native tools. It has no Loader, container, Pi Node CLI, SDK patch, private import, or engine fork.

From the Chat checkout:

```sh
npm ci --prefix scripts/fixtures/native-durable --legacy-peer-deps --ignore-scripts
node scripts/native-durable-local.mjs
```

The separate lockfile pins Agents 0.26.0, Pi Durable / Pi AI 1.0.4, Wrangler 4.143.0, and their dependencies. Agents imports the declared MCP peers from its base class; they are installed to bundle that class, with no MCP server or network connection used by this fixture. Optional unrelated SDK peers are omitted. The runtime uses compatibility date 2026-10-03, the newest date supported by this locked workerd binary.

The runner generates Worker binding types, typechecks the fixture, bundles through Wrangler's local dry run, then loads that bundle in actual workerd through Wrangler's Miniflare. All persistent state, CLI configuration/logs, bundles, and run evidence are test-owned under `.scratch/native-durable-submissions/`. Binding types are generated beside the fixture and ignored by Git. All Worker outbound calls are intercepted: only an in-process fake-provider event is accepted, and every other destination is rejected. There are no remote bindings, provider credentials, production resources, or App dependencies.

The gate covers:

- Durable submission acknowledgment before a blocked model/tool finishes, and native lookup of the accepted request.
- Native `requestId` deduplication: the wrapper maps `operationId` to it and returns the original submission on retry.
- **Host content identity guard**: same immutable text, ordered image references, and replacement IDs reuse the native submission; changing any of these rejects before a new execution. The fixture keeps one immutable domain input association because native withdrawn queued records can lose input content and native model input has no domain image/replacement references. It stores no engine status.
- Explicit ingress rejection versus a currently absent native lookup. An absent lookup itself makes no claim about rejection.
- Workerd shutdown and fresh runtime creation on the same test-owned SQLite persistence, with one user entry after retry.
- An autonomous lifecycle alarm that resumes the interrupted model before any new ingress request, observed by the in-process fake-provider event.
- Safe tool replay: the execution reruns, while its call-ID effect receipt prevents a second effect. Unsafe tool interruption: execution does not rerun, and the model sees the native interrupted tool result.

The `/native-submit` route exists only to demonstrate that native deduplication **does not reject changed content**. It bypasses the fixture guard deliberately and is not a product endpoint. The gate's synthetic input and evidence routes are test infrastructure, not an App DTO or a second public protocol.

The emitted `NATIVE_GATE_PASS` contains the exact runtime versions and bundle SHA-256. Full native entries, counters, pre-restart submission records, and outcomes are saved to `.scratch/native-durable-submissions/gate-evidence.json`.

Passing this gate does not establish product migration, existing-data conversion, or joint App/native acceptance. Those belong to tickets #3441/#3442 and require Orc's approved App contract/build/runner identity.

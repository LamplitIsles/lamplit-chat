import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const repository = fileURLToPath(new URL('..', import.meta.url))
const fixture = resolve(repository, 'scripts/fixtures/native-durable')
const fixtureRequire = createRequire(resolve(fixture, 'package.json'))
const wranglerRequire = createRequire(fixtureRequire.resolve('wrangler/package.json'))
const { Miniflare } = wranglerRequire('miniflare')
const root = resolve(repository, '.scratch/native-durable-submissions')
await mkdir(root, { recursive: true })
const state = await mkdtemp(`${root}/replay-state-`)
const evidence = []
const bundle = resolve(state, 'bundle')
const toolEnvironment = Object.fromEntries(['PATH', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
const environment = { ...toolEnvironment, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: resolve(state, 'config'), WRANGLER_LOG_PATH: resolve(state, 'wrangler.log') }
for (const args of [ ['types', resolve(fixture, 'env.d.ts')], ['deploy', '--dry-run', '--outdir', bundle] ]) {
  const result = spawnSync(process.execPath, [resolve(dirname(fixtureRequire.resolve('wrangler/package.json')), fixtureRequire('wrangler/package.json').bin.wrangler), ...args, '--config', resolve(fixture, 'wrangler.jsonc')], { cwd: fixture, env: environment, encoding: 'utf8' })
  await writeFile(resolve(state, args[0] + '.log'), result.stdout + result.stderr)
  assert.equal(result.status, 0, result.stdout + result.stderr)
}
const typecheck = spawnSync(process.execPath, [fixtureRequire.resolve('typescript/bin/tsc'), '--project', resolve(fixture, 'tsconfig.json')], { cwd: fixture, encoding: 'utf8' })
assert.equal(typecheck.status, 0, typecheck.stdout + typecheck.stderr)
const bundleBytes = await readFile(resolve(bundle, 'index.js'))
const identity = { agents: JSON.parse(await readFile(resolve(fixture, 'node_modules/agents/package.json'))).version, piDurable: fixtureRequire('@earendil-works/pi-durable/package.json').version, piAI: JSON.parse(await readFile(resolve(fixture, 'node_modules/@earendil-works/pi-ai/package.json'))).version, wrangler: wranglerRequire('./package.json').version, miniflare: wranglerRequire('miniflare/package.json').version, workerd: wranglerRequire('workerd/package.json').version, compatibilityDate: '2026-10-03', bundleSha256: createHash('sha256').update(bundleBytes).digest('hex') }
let runtime
let resumed = false
let modelEvents = 0
async function start() {
  runtime = new Miniflare({ resourcePersistencePath: state, telemetry: { enabled: false }, workers: [{
    config: { name: 'native-durable-gate', compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundleBytes.toString('utf8') } } },
      env: { RESUME: { type: 'text', value: String(resumed) }, NativeGate: { type: 'durable-object', worker: 'native-durable-gate', exportName: 'NativeGate' } },
      exports: { NativeGate: { type: 'durable-object', storage: 'sqlite' } },
    },
    dev: { outboundService: { type: 'fetcher', handler: request => { if (request.url === 'https://native-gate.invalid/model') { modelEvents++; return new Response('fixture event') } return new Response('external network prohibited', { status: 503 }) } } },
  }] })
  await runtime.ready
}
async function request(name, path, body, status = 200) {
  const response = await runtime.dispatchFetch(`http://gate${path}${path.includes('?') ? '&' : '?'}name=${name}`, { signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  const value = await response.json()
  assert.equal(response.status, status, JSON.stringify(value))
  return value
}
async function until(name, predicate) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await request(name, '/evidence')
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out awaiting ${name}`)
}
const input = text => ({ text, images: ['image-a', 'image-b'], replacementIds: ['replace-a'] })
try {
  await start()
  assert.equal(await request('normal', '/lookup?id=missing'), null)
  await request('normal', '/submit?id=rejected', input('reject'), 409)
  assert.equal(await request('normal', '/lookup?id=rejected'), null)
  const first = await request('normal', '/submit?id=normal', input('normal'))
  assert.equal(first.accepted, true)
  assert.equal((await request('normal', '/submit?id=normal', input('normal'))).accepted, false)
  for (const altered of [input('changed'), { ...input('normal'), images: ['image-b', 'image-a'] }, { ...input('normal'), replacementIds: ['replace-b'] }]) {
    await request('normal', '/submit?id=normal', altered, 409)
  }
  const settled = await request('normal', '/wait?id=normal')
  assert.equal(settled.status, 'done')
  assert.equal(settled.text, 'native completed')
  const native = await request('normal', '/native-submit?id=normal', 'native DOES NOT compare content')
  assert.equal(native.accepted, false)
  const normal = await request('normal', '/evidence')
  assert.equal(normal.native.filter(entry => entry.kind === 'pi.user').length, 1)
  assert.equal(normal.effects, 1)
  evidence.push({ case: 'normal, guard, native dedup distinction, explicit rejection, missing lookup', first, settled, normal })
  await request('withdrawal', '/submit?id=active', input('model-hold'))
  await until('withdrawal', value => value.modelStarted)
  await request('withdrawal', '/submit?id=queued', input('queued'))
  assert.equal((await request('withdrawal', '/lookup?id=queued')).status, 'queued')
  assert.equal((await request('withdrawal', '/abort?id=queued')).aborted, true)
  const withdrawn = await request('withdrawal', '/lookup?id=queued')
  assert.equal(withdrawn.status, 'unanswered')
  assert.equal(withdrawn.entry, undefined)
  assert.equal((await request('withdrawal', '/submit?id=queued', input('queued'))).accepted, false)
  await request('withdrawal', '/submit?id=queued', input('changed'), 409)
  await request('withdrawal', '/release')
  await request('withdrawal', '/wait?id=active')
  evidence.push({ case: 'withdrawn queued content identity', withdrawn })
  for (const name of ['model-hold', 'tool-safe', 'tool-unsafe']) {
    const accepted = await request(name, `/submit?id=${name}`, input(name))
    assert.equal(accepted.accepted, true)
    const before = await until(name, value => name === 'model-hold' ? value.modelStarted : value.toolStarted)
    const durableBefore = await request(name, `/lookup?id=${name}`)
    assert.ok(durableBefore && ['placed', 'queued'].includes(durableBefore.status))
    await runtime.dispose()
    const eventsBeforeRestart = modelEvents
    resumed = true
    await start()
    if (name === 'model-hold') {
      const deadline = Date.now() + 45000
      while (modelEvents === eventsBeforeRestart && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(modelEvents > eventsBeforeRestart, 'Lifecycle alarm must reopen Pi without any ingress request')
    }
    await request(name, '/release')
    assert.equal((await request(name, `/submit?id=${name}`, input(name))).accepted, false)
    const result = await request(name, `/wait?id=${name}`)
    assert.equal(result.status, 'done')
    assert.equal(result.text, name === 'tool-unsafe' ? 'interrupted tool observed' : 'native completed')
    const after = await request(name, '/evidence')
    assert.equal(after.native.filter(entry => entry.kind === 'pi.user').length, 1)
    assert.equal(after.effects, 1)
    if (name === 'model-hold') assert.ok(after.modelCalls > before.modelCalls)
    if (name === 'tool-safe') assert.equal(after.safeInvocations, 2)
    if (name === 'tool-unsafe') assert.equal(after.unsafeInvocations, 1)
    evidence.push({ case: name, autonomousModelEvents: modelEvents - eventsBeforeRestart, accepted, durableBefore, before, result, after })
    resumed = false
    await runtime.dispose()
    await start()
  }
  await writeFile(`${root}/gate-evidence.json`, JSON.stringify({ identity, state, evidence }, null, 2))
  console.log('NATIVE_GATE_PASS', JSON.stringify(identity), JSON.stringify(evidence.map(x => ({ case: x.case, status: x.result?.status ?? x.settled?.status }))))
} finally { await runtime?.dispose() }

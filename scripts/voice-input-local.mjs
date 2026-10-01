// Test-owned local Worker; never loads repository credentials or calls an external provider.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = mkdtempSync(join(tmpdir(), 'lamplit-voice-'))
const platformService = process.argv.find(arg => arg.startsWith('--platform-service='))?.split('=')[1]
const config = JSON.parse(readFileSync(join(repo, 'wrangler.test.jsonc'), 'utf8'))
const port = process.env.VOICE_FIXTURE_PORT || '8898'
config.name = process.env.VOICE_FIXTURE_NAME || 'lamplit-chat-voice-fixture'
config.vars = { ...config.vars, MODEL_API_KEY: 'fixture-key', AUTH_PASSWORD: 'fixture-password-long-enough', HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-voice-internal-secret' }
if (platformService) config.services = [{ binding: 'PLATFORM', service: platformService }]
config.main = join(directory, 'entry.ts')
writeFileSync(config.main, `
import worker from ${JSON.stringify(join(repo, 'src/server.ts'))};
export { PiSession, PiRegistry } from ${JSON.stringify(join(repo, 'src/server-test-entry.ts'))};
let state = { enabled: true, apiKey: 'fixture-voice-key', text: '明天我们一起去散步吧。', status: 200, delayMs: 0, calls: 0, lastAuthorization: '', lastRequest: null };
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions') throw new Error('Fixture forbids external network');
  state.calls++;
  state.lastAuthorization = new Headers(init?.headers).get("authorization");
  const data = JSON.parse(init?.body);
  state.lastRequest = { model: data.model, stream: data.stream, dataUrlChars: data.messages?.[0]?.content?.[0]?.input_audio?.data?.length };
  if (state.delayMs) await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, state.delayMs);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  return state.status === 200 ? Response.json({ choices: [{ message: { content: state.text } }] }) : new Response('Synthetic provider error', { status: state.status });
};
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/__fixture/state') {
    if (request.method === 'POST') Object.assign(state, await request.json());
    return Response.json(state);
  }
  const platform = { fetch: async (url, init) => {
    if (new Headers(init?.headers).get('x-lamplit-internal-secret') !== env.CHAT_INTERNAL_SECRET) return new Response(null, { status: 403 });
    const id = new URL(url).pathname.split('/').pop();
    return id === '11111111-1111-4111-8111-111111111111' ? Response.json({ enabled: state.enabled, apiKey: state.apiKey }) : id === '22222222-2222-4222-8222-222222222222' ? Response.json({ enabled: false }) : new Response(null, { status: 404 });
  } };
  return worker.fetch(request, { ...env, PLATFORM: env.PLATFORM ?? platform });
} };
`)
const configPath = join(directory, 'wrangler.jsonc')
writeFileSync(configPath, JSON.stringify(config))
writeFileSync(join(directory, '.dev.vars'), '')
console.log(`Voice fixture: http://127.0.0.1:${port}; temporary state: ${directory}`)
const child = spawn(join(repo, 'node_modules/.bin/wrangler'), ['dev', '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', port, '--inspector-port', process.env.VOICE_INSPECTOR_PORT || '0', '--persist-to', join(directory, 'state'), '--show-interactive-dev-session=false'], { cwd: directory, stdio: 'inherit', env: { ...(process.env.VOICE_REGISTRY_PATH ? { WRANGLER_REGISTRY_PATH: process.env.VOICE_REGISTRY_PATH } : {}), PATH: process.env.PATH, TMPDIR: directory, XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'data'), WRANGLER_LOG_PATH: join(directory, 'logs'), WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' } })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { rmSync(directory, { recursive: true, force: true }); process.exitCode = code ?? 0 })
child.on('error', error => { console.error(error.message); rmSync(directory, { recursive: true, force: true }); process.exitCode = 1 })

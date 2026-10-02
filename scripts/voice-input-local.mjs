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
let state = { enabled: true, apiKey: 'fixture-voice-key', text: '明天我们一起去散步吧。', status: 200, delayMs: 0, startDelayMs: 0, calls: 0, frames: 0, bytes: 0, events: [], closes: 0, lastAuthorization: '', lastRequest: null };
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://dashscope.aliyuncs.com/api-ws/v1/inference') throw new Error('Fixture forbids external network');
  state.calls++;
  state.lastAuthorization = new Headers(init?.headers).get('authorization');
  if (state.status !== 200) return new Response('Synthetic provider error', { status: state.status });
  const pair = new WebSocketPair(); const socket = pair[1]; socket.binaryType = 'arraybuffer'; socket.accept();
  let taskId;
  socket.addEventListener('close', () => state.closes++);
  const send = (event, payload = {}) => { try { socket.send(JSON.stringify({ header: { event, task_id: taskId }, payload })); } catch {} };
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') { state.frames++; state.bytes += event.data.byteLength; state.events.push({ type: 'pcm', bytes: event.data.byteLength, at: Date.now() }); return; }
    const data = JSON.parse(event.data);
    state.events.push({ type: data.header.action, at: Date.now() });
    taskId = data.header.task_id;
    if (data.header.action === 'run-task') {
      state.lastRequest = data;
      if (state.startDelayMs) setTimeout(() => send('task-started'), state.startDelayMs); else send('task-started');
    } else if (data.header.action === 'finish-task') {
      const finish = () => { send('result-generated', { output: { sentence: { sentence_id: 1, sentence_end: true, text: state.text } } }); send('task-finished'); };
      if (state.delayMs) setTimeout(finish, state.delayMs); else finish();
    }
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
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

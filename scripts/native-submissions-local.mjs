import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { verifyDefaultArtifacts } from './default-shared-artifacts.mjs'
verifyDefaultArtifacts()
const repo = resolve(import.meta.dirname, '..')
const scratch = join(repo, '.scratch/native-durable-submissions')
mkdirSync(scratch, { recursive: true })
const root = mkdtempSync(join(scratch, 'native-browser-'))
const config = JSON.parse(readFileSync(join(repo, 'wrangler.test.jsonc')))
config.name = 'lamplit-native-submissions-fixture'
config.compatibility_date = '2026-10-03'
const suite = process.argv[2] ?? 'submissions'
if (!['submissions', 'images', 'voice', 'compact', 'search', 'keet', 'thinking'].includes(suite)) throw new Error('Unknown native suite')
config.main = join(repo, `scripts/fixtures/${{submissions:'native-submissions',images:'image-send-recovery',voice:'text-voice',compact:'quiet-compaction',search:'conversation-search',keet:'keet-source-restoration',thinking:'collapsed-thinking'}[suite]}.ts`)
config.assets = { directory: join(scratch, 'app-browser'), binding: 'ASSETS', not_found_handling: 'none', html_handling: 'none', run_worker_first: true }
config.vars = { ...config.vars, MODEL_API_KEY: 'fixture-key', AUTH_PASSWORD: 'fixture-password-long-enough', VOICE_API_KEY: 'fixture-voice-key', CHAT_INTEGRATIONS: JSON.stringify({keet:{webhookToken:'fixture-ingest-token'}}) }
const path = join(root, 'wrangler.jsonc')
writeFileSync(path, JSON.stringify(config, null, 2)); writeFileSync(join(root, '.dev.vars'), '')
console.log(JSON.stringify({ root, port: process.env.NATIVE_FIXTURE_PORT ?? '8991' }))
const child = spawn(join(repo, 'node_modules/.bin/wrangler'), ['dev', '--config', path, '--local', '--ip', '127.0.0.1', '--port', process.env.NATIVE_FIXTURE_PORT ?? '8991', '--inspector-port', '0', '--persist-to', join(root, 'state'), '--show-interactive-dev-session=false'], { cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), WRANGLER_REGISTRY_PATH: join(root, 'registry'), WRANGLER_LOG_PATH: join(root, 'logs'), WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' } })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { verifyDefaultArtifacts(); process.exitCode = code ?? 0 })

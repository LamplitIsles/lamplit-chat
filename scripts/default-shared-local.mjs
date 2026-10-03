// Isolated native acceptance: approved bytes, real adapters and test-owned workerd state.
import { verifyDefaultArtifacts, artifactRoot } from './default-shared-artifacts.mjs'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
verifyDefaultArtifacts()
const repo = resolve(import.meta.dirname, '..')
const suite = process.argv[2]
const entries = { text: 'text-voice', voice: 'text-voice', images: 'image-send-recovery', compact: 'quiet-compaction', search: 'conversation-search' }
if (!entries[suite]) throw new Error('Choose text, voice, images, compact or search')
const root = join(repo, '.scratch/default-shared-frontend/native', `${suite}-${Date.now()}`)
if (existsSync(root)) throw new Error('Fixture root exists')
mkdirSync(root, { recursive: true })
const config = JSON.parse(readFileSync(join(repo, 'wrangler.test.jsonc')))
config.name = `lamplit-default-${suite}-fixture`
config.main = join(repo, `scripts/fixtures/${entries[suite]}.ts`)
config.assets = { directory: join(artifactRoot, 'browser'), binding: 'ASSETS', not_found_handling: 'none', html_handling: 'none', run_worker_first: true }
config.vars = { ...config.vars, MODEL_API_KEY: 'fixture-key', AUTH_PASSWORD: 'fixture-password-long-enough', VOICE_API_KEY: 'fixture-voice-key' }
const path = join(root, 'wrangler.jsonc')
writeFileSync(path, JSON.stringify(config, null, 2)); writeFileSync(join(root, '.dev.vars'), '')
const port = process.env.DEFAULT_FIXTURE_PORT || '8980'
console.log(`Native ${suite} fixture http://127.0.0.1:${port}/; storage ${root}`)
const child = spawn(join(repo, 'node_modules/.bin/wrangler'), ['dev', '--config', path, '--local', '--ip', '127.0.0.1', '--port', port, '--inspector-port', '0', '--persist-to', join(root, 'state'), '--show-interactive-dev-session=false'], {
  cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), WRANGLER_REGISTRY_PATH: join(root, 'registry'), WRANGLER_LOG_PATH: join(root, 'logs'), WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { verifyDefaultArtifacts(); process.exitCode = code ?? 0 })

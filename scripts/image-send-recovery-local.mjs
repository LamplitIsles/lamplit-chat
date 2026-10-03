// Launch the native Worker with test-owned storage and the reviewed, extracted browser.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
const repo = resolve(import.meta.dirname, '..')
const quiet = process.env.QUIET_COMPACTION_ACCEPTANCE === 'true'
if (quiet) (await import('./quiet-compaction-artifacts.mjs')).verifyQuietArtifacts()
const root = resolve(process.argv[2] ?? '.scratch/image-send-recovery/native')
if (!root.startsWith(join(repo, quiet ? '.scratch/quiet-compaction' : '.scratch/image-send-recovery') + '/')) throw new Error('Use a test-owned image-send-recovery scratch root')
mkdirSync(root, { recursive: true })
const config = JSON.parse(readFileSync(join(repo, 'wrangler.test.jsonc')))
config.name = 'lamplit-image-recovery-fixture'
config.main = join(repo, 'scripts/fixtures/image-send-recovery.ts')
config.assets = { directory: join(repo, quiet ? '.scratch/quiet-compaction/frozen/web' : '.scratch/image-send-recovery/browser'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true }
config.vars = { ...config.vars, MODEL_API_KEY: 'fixture-key', AUTH_PASSWORD: 'fixture-password-long-enough', VOICE_API_KEY: 'fixture-voice-key' }
const path = join(root, 'wrangler.jsonc'); writeFileSync(path, JSON.stringify(config, null, 2)); writeFileSync(join(root, '.dev.vars'), '')
const port = process.env.IMAGE_FIXTURE_PORT || '8973'
console.log(`Native image fixture http://127.0.0.1:${port}/; control /__test/image-send-recovery; storage ${root}`)
const child = spawn(join(repo, 'node_modules/.bin/wrangler'), ['dev', '--config', path, '--local', '--ip', '127.0.0.1', '--port', port, '--inspector-port', '0', '--persist-to', join(root, 'state'), '--show-interactive-dev-session=false'], {
  cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), WRANGLER_REGISTRY_PATH: join(root, 'registry'), WRANGLER_LOG_PATH: join(root, 'logs'), WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { process.exitCode = code ?? 0 })

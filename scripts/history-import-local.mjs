// Isolated history API service for platform integration. Uses only fictional secrets and temporary state.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = mkdtempSync(join(tmpdir(), 'lamplit-history-import-'))
const config = JSON.parse(readFileSync(join(repo, 'wrangler.test.jsonc'), 'utf8'))
config.main = join(repo, 'src/server-test-entry.ts')
config.vars = { ...config.vars, MODEL_API_KEY: 'fixture-key', AUTH_PASSWORD: 'fixture-password-long-enough' }
if (process.argv.includes('--hosted')) Object.assign(config.vars, { HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-history-internal-secret' })
const configPath = join(directory, 'wrangler.jsonc')
writeFileSync(configPath, JSON.stringify(config))
writeFileSync(join(directory, '.dev.vars'), '')
console.log(`Isolated history service: http://127.0.0.1:8899; test-owned state: ${directory}`)
const child = spawn(join(repo, 'node_modules/.bin/wrangler'), ['dev', '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', '8899', '--persist-to', join(directory, 'state'), '--show-interactive-dev-session=false'], {
  cwd: directory, stdio: 'inherit', env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { rmSync(directory, { recursive: true, force: true }); process.exitCode = code ?? 0 })
child.on('error', error => { console.error(error.message); rmSync(directory, { recursive: true, force: true }); process.exitCode = 1 })

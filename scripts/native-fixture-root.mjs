import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const marker = '.native-submissions-owner'
const owner = 'lamplit-chat/native-submissions-local/v1'
export function nativeFixtureRoot(scratch, resume) {
  if (!resume) {
    mkdirSync(scratch, { recursive: true })
    const root = mkdtempSync(join(realpathSync(scratch), 'native-browser-'))
    writeFileSync(join(root, marker), JSON.stringify({ owner, root }), { flag: 'wx' })
    return root
  }
  // Validate ownership and canonical containment before the launcher writes anything.
  const base = realpathSync(scratch), requested = resolve(resume), root = realpathSync(requested)
  const segment = relative(base, root)
  if (root !== requested || segment.includes(sep) || !segment.startsWith('native-browser-') || segment === 'native-browser-') throw new Error('Resume requires a canonical test-owned fixture root')
  if (!lstatSync(join(root, marker)).isFile()) throw new Error('Resume requires launcher ownership')
  const owned = JSON.parse(readFileSync(join(root, marker), 'utf8'))
  if (owned.owner !== owner || owned.root !== root) throw new Error('Resume requires launcher ownership')
  for (const file of ['wrangler.jsonc', '.dev.vars']) {
    if (!lstatSync(join(root, file)).isFile()) throw new Error('Resume requires owned regular configuration files')
  }
  return root
}

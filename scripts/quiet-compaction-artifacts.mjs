import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const repo = resolve(import.meta.dirname, '..')
const handoff = join(repo, '../lamplit-app/.scratch/quiet-compaction/frozen-95f0f06')
const extracted = join(repo, '.scratch/quiet-compaction/frozen')
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
export function verifyQuietArtifacts() {
  const identity = JSON.parse(readFileSync(join(handoff, 'identity.json')))
  const approval = JSON.parse(readFileSync(join(handoff, 'owner-approval.json')))
  if (identity.appHead !== '95f0f06fc00fd4e7fa3e664ca2b1fe12fe8d10b8' || approval.reviewedHead !== identity.appHead) throw new Error('Unexpected frozen App identity')
  for (const [kind, archive, directory] of [['browser', 'lamplit-web', 'web'], ['contracts', 'lamplit-contracts', 'contracts/package'], ['acceptance', 'lamplit-acceptance', 'acceptance']]) {
    if (digest(join(handoff, `${archive}-compact.tgz`)) !== identity[`${kind}ArchiveSHA256`] || digest(join(handoff, `${kind}.sha256`)) !== identity[`${kind}ManifestSHA256`]) throw new Error(`${kind} archive/manifest mismatch`)
    for (const line of readFileSync(join(handoff, `${kind}.sha256`), 'utf8').trim().split('\n')) {
      const [, hash, path] = /^(\w+)\s+\*?(.+)$/.exec(line)
      if (digest(join(extracted, directory, path)) !== hash) throw new Error(`${kind} file mismatch: ${path}`)
      if (kind === 'contracts' && digest(join(repo, 'node_modules/@lamplit/contracts', path)) !== hash) throw new Error(`Installed contract mismatch: ${path}`)
    }
  }
  console.log(`Verified unchanged frozen browser/contracts/runner: ${identity.appHead}`)
  return identity
}

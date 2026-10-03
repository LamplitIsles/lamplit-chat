import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const repo = resolve(import.meta.dirname, '..')
const handoff = join(repo, '../lamplit-app/.scratch/conversation-search/frozen-512ed66')
const extracted = join(repo, '.scratch/conversation-search/artifacts')
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
export function verifySearchArtifacts() {
  const identity = JSON.parse(readFileSync(join(handoff, 'identity.json')))
  const approval = JSON.parse(readFileSync(join(handoff, 'owner-approval.json')))
  if (identity.appHead !== '512ed6656c0564426838b7a82245453e6dd34114' || approval.reviewedHead !== identity.appHead) throw new Error('Unexpected frozen App identity')
  if (digest(join(handoff, 'identity.json')) !== approval.identitySHA256 || approval.remainingFindings !== 0) throw new Error('Frozen Owner approval mismatch')
  for (const [kind, archive, directory] of [['browser', 'lamplit-web', 'browser'], ['contracts', 'lamplit-contracts', 'contracts/package'], ['acceptance', 'lamplit-acceptance', 'acceptance']]) {
    if (digest(join(handoff, `${archive}-search.tgz`)) !== identity[`${kind}ArchiveSHA256`] || digest(join(handoff, `${kind}.sha256`)) !== identity[`${kind}ManifestSHA256`]) throw new Error(`${kind} archive/manifest mismatch`)
    for (const line of readFileSync(join(handoff, `${kind}.sha256`), 'utf8').trim().split('\n')) {
      const [, hash, path] = /^(\w+)\s+\*?(.+)$/.exec(line)
      if (digest(join(extracted, directory, path)) !== hash) throw new Error(`${kind} file mismatch: ${path}`)
      if (kind === 'contracts' && digest(join(repo, 'node_modules/@lamplit/contracts', path)) !== hash) throw new Error(`Installed contract mismatch: ${path}`)
    }
  }
  console.log(`Verified unchanged frozen browser/contracts/runner: ${identity.appHead}`)
  return identity
}

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const repo = resolve(import.meta.dirname, '..')
const handoff = join(repo, '../lamplit-app/.scratch/keet-source-restoration/candidate')
const extracted = join(repo, '.scratch/keet-source-restoration/artifact')
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
export function verifyKeetArtifacts() {
  const identity = JSON.parse(readFileSync(join(handoff, 'identity.json')))
  if (identity.appHead !== '09bf71009ff931cfdc75c675d9b16037bbb1d881' || identity.archiveSHA256 !== 'c7219de5bf1596af8b27de3da38e3e75d375c7b8e7a9a975d822690a1aef31c2') throw new Error('Unexpected approved App identity')
  if (digest(join(handoff, identity.archive)) !== identity.archiveSHA256) throw new Error('Approved archive changed')
  let files = 0
  for (const [kind, directory] of [['browser', 'browser'], ['contracts', 'contracts/package'], ['acceptance', 'acceptance']]) {
    const manifest = join(extracted, `${kind}.sha256`)
    if (digest(manifest) !== identity.manifests[kind].sha256) throw new Error(`${kind} manifest changed`)
    for (const line of readFileSync(manifest, 'utf8').trim().split('\n')) {
      const [, hash, path] = /^(\w+)\s+\*?(.+)$/.exec(line)
      if (digest(join(extracted, directory, path)) !== hash) throw new Error(`${kind} file changed: ${path}`)
      if (kind === 'contracts' && digest(join(repo, 'node_modules/@lamplit/contracts', path)) !== hash) throw new Error(`Installed contract changed: ${path}`)
      files++
    }
  }
  if (files !== 307 || digest(join(extracted, 'acceptance/keet-browser.mjs')) !== '79bd97454db6d18e1651a5b7ec90063f8ae22b0f42c2dd10d30aed78f9e5a920') throw new Error('Approved file count/runner changed')
  console.log(`Verified ${files} approved files; original runner remains archived unchanged`)
  return identity
}

export function verifyCorrectedKeetRunner() {
  verifyKeetArtifacts()
  const handoff = join(repo, '../lamplit-app/.scratch/keet-source-restoration/runner-correction')
  const identity = JSON.parse(readFileSync(join(handoff, 'identity.json')))
  if (identity.runnerHead !== '7061b0972266ef1a525ff9430278cde2384ea1e1' || identity.archiveSHA256 !== 'effb16db242eaa7686623bf07cb1469919c91d79340528ba9fe44422078e3c42') throw new Error('Unexpected approved runner identity')
  if (digest(join(handoff, identity.archive)) !== identity.archiveSHA256) throw new Error('Corrected runner archive changed')
  const manifest = join(repo, '.scratch/keet-source-restoration/runner-correction/runner.sha256')
  if (digest(manifest) !== '87adc869dfe70d4d5e41b1967f07dd51e21d947cd74256c6d7fb0ef62a31dacd') throw new Error('Corrected runner manifest changed')
  let files = 0
  for (const line of readFileSync(manifest, 'utf8').trim().split('\n')) {
    const [, hash, path] = /^(\w+)\s+\*?(.+)$/.exec(line)
    if (digest(join(extracted, 'runner', path)) !== hash) throw new Error(`Corrected runner file changed: ${path}`)
    files++
  }
  if (files !== 11 || digest(join(extracted, 'runner/keet-browser.mjs')) !== 'd9d2f05eb051dcda9a5334ab706f5edae0c7dbb2035753d62f7f0fe0a800a7eb') throw new Error('Corrected runner count/hash changed')
  if (digest(join(extracted, 'runner/bun.lock')) !== digest(join(extracted, 'acceptance/bun.lock'))) throw new Error('Inherited frozen runner lock changed')
  console.log(`Verified ${files} approved corrected runner files: ${identity.runnerHead}`)
  return identity
}

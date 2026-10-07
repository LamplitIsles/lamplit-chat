import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
const repo = resolve(import.meta.dirname, '..')
export const artifactRoot = resolve(process.env.LAMPLIT_APP_EXTRACTION ?? join(repo, '.scratch/native-durable-submissions/approved-app-3aaa48a'))
export function verifyDefaultArtifacts(extractionRoot = artifactRoot, archive = process.env.LAMPLIT_APP_ARTIFACT ?? join(repo, '.scratch/native-durable-submissions/lamplit-native-durable-submissions.tgz')) {
  const identity = JSON.parse(readFileSync(join(repo, 'vendor/app-identity.json')))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  if (hash(readFileSync(archive)) !== identity.archive) throw new Error('Approved archive identity changed')
  if (readFileSync(join(extractionRoot, 'SOURCE_HEAD'), 'utf8').trim() !== identity.head) throw new Error('Approved App source changed')
  let files = 0
  for (const [folder, expected] of Object.entries(identity.manifests)) {
    const manifest = readFileSync(join(extractionRoot, `${folder}.sha256`))
    if (hash(manifest) !== expected) throw new Error(`${folder} manifest changed`)
    const base = join(extractionRoot, folder, folder === 'contracts' ? 'package' : '')
    for (const line of manifest.toString().trim().split('\n')) {
      const [digest, path] = line.split('  ')
      if (hash(readFileSync(join(base, path))) !== digest) throw new Error(`${folder}/${path} changed`)
      files++
    }
  }
  return { sourceHead: identity.head, archive: identity.archive, files }
}
if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(verifyDefaultArtifacts()))

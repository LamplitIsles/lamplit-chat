import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
export const artifactRoot = resolve('.scratch/default-shared-frontend/artifact')
export function verifyDefaultArtifacts() {
  if (readFileSync(join(artifactRoot, 'SOURCE_HEAD'), 'utf8').trim() !== 'd1e800e72807d52ea14eed59d13a3cef6a43fd09') throw new Error('Unapproved App source')
  const handoff = resolve('../lamplit-app/.scratch/default-shared-frontend/frozen-d1e800e')
  if (!execFileSync('shasum', ['-a', '256', join(handoff, 'lamplit-default-shared-frontend.tgz')], { encoding: 'utf8' }).startsWith('eef50394bba2452f6daf1a8a052db3a35e68ed049bab480616602496aaca227e ')) throw new Error('Archive identity changed')
  for (const [folder, manifest, hash] of [
    ['browser', 'browser.sha256', '8e83a3f3f69e79b9a8e169432190863b7f890270ac580a200cbb1c9ac8571d68'],
    ['contracts/package', 'contracts.sha256', '5964aecc3c1caa3a0d4c8dd5532fe287ce08d564199796be81563b46d9d9a022'],
    ['acceptance', 'acceptance.sha256', '25f667fd6def71c2cb7f788dc02350027dc9b6a404fbc1fbe826b2555b673bb3'],
  ]) {
    if (!execFileSync('shasum', ['-a', '256', join(artifactRoot, manifest)], { encoding: 'utf8' }).startsWith(hash + ' ')) throw new Error('Manifest identity changed')
    execFileSync('shasum', ['-a', '256', '-c', join(artifactRoot, manifest)], { cwd: join(artifactRoot, folder) })
    if (folder === 'contracts/package') execFileSync('shasum', ['-a', '256', '-c', join(artifactRoot, manifest)], { cwd: resolve('node_modules/@lamplit/contracts') })
  }
}
if (process.argv[1] === import.meta.filename) verifyDefaultArtifacts()

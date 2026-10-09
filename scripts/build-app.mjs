import { mkdir, mkdtemp, cp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { verifyDefaultArtifacts } from './default-shared-artifacts.mjs'
const root = resolve(import.meta.dirname,'..')
const archive = resolve(process.env.LAMPLIT_APP_ARTIFACT ?? resolve(root,'.scratch/matrix-source-ui/lamplit-matrix-source-ui.tgz'))
const scratch = resolve(root,'.scratch/native-durable-submissions')
await mkdir(scratch,{recursive:true})
const extraction = await mkdtemp(resolve(scratch,'build-app-'))
const result = spawnSync('tar',['-xzf',archive,'-C',extraction],{encoding:'utf8'})
assert.equal(result.status,0,result.stderr)
const identity = verifyDefaultArtifacts(extraction, archive)
const destination = resolve(scratch,'app-browser')
await rm(destination,{recursive:true,force:true}) // Script-owned generated output only.
await cp(resolve(extraction,'browser'),destination,{recursive:true})
console.log(`Verified App ${identity.sourceHead}; browser assets prepared at ${destination}`)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeFixtureRoot } from './native-fixture-root.mjs'

test('resumes only canonical launcher-owned roots and leaves rejected state untouched', () => {
  const temp = mkdtempSync(join(tmpdir(), 'native-root-test-'))
  try {
    const scratch = join(temp, 'scratch'), root = nativeFixtureRoot(scratch)
    for (const file of ['wrangler.jsonc', '.dev.vars', 'persisted-state']) writeFileSync(join(root, file), 'retained')
    assert.equal(nativeFixtureRoot(scratch, root), root)
    assert.equal(readFileSync(join(root, 'persisted-state'), 'utf8'), 'retained')
    const foreign = join(scratch, 'native-browser-foreign'), outside = join(temp, 'scratch-native-browser-foreign')
    for (const path of [foreign, outside]) { mkdirSync(path); writeFileSync(join(path, 'wrangler.jsonc'), 'foreign') }
    const escaped = join(scratch, 'native-browser-escape'); symlinkSync(outside, escaped)
    for (const path of [foreign, outside, escaped]) assert.throws(() => nativeFixtureRoot(scratch, path))
    for (const path of [foreign, outside]) assert.equal(readFileSync(join(path, 'wrangler.jsonc'), 'utf8'), 'foreign')
    const copied = join(scratch, 'native-browser-copied'); mkdirSync(copied)
    writeFileSync(join(copied, '.native-submissions-owner'), readFileSync(join(root, '.native-submissions-owner')))
    assert.throws(() => nativeFixtureRoot(scratch, copied), /ownership/)
    rmSync(join(root, '.dev.vars')); symlinkSync(join(outside, 'wrangler.jsonc'), join(root, '.dev.vars'))
    assert.throws(() => nativeFixtureRoot(scratch, root), /regular/)
    assert.equal(readFileSync(join(outside, 'wrangler.jsonc'), 'utf8'), 'foreign')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

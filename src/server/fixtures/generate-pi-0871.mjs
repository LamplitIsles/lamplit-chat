// Run with pi-agent-core and pi-ai 0.87.1 installed in an isolated npm project:
// node /path/to/generate-pi-0871.mjs /path/to/node_modules/@earendil-works/pi-agent-core
// Prints synthetic committed writes; never reads session or user data.
import { deepStrictEqual } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const packagePath = resolve(process.argv[2])
const { version } = JSON.parse(await readFile(`${packagePath}/package.json`, 'utf8'))
if (version !== '0.87.1') throw new Error('Fixture generation requires pi-agent-core 0.87.1')
const { prepareStorageCommit, validateCommittedWrites, insertEntry, insertUsage, setValue, appendList, branchTip, laneConfig, laneState, sessionName, list, StorageBackedSession } = await import(pathToFileURL(`${packagePath}/dist/harness/session/index.js`))
const timestamp = Date.parse('2026-09-01T00:00:00Z')
const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const writes = [
  insertEntry({ type: 'message', id: 'old-user', parentId: null, message: { role: 'user', content: 'Synthetic old prompt', timestamp } }),
  insertEntry({ type: 'message', id: 'old-answer', parentId: 'old-user', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic old reply' }], api: 'openai-completions', provider: 'configured-provider', model: 'fixture-model', usage, stopReason: 'stop', timestamp } }),
  insertEntry({ type: 'message', id: 'other-user', parentId: 'old-user', message: { role: 'user', content: 'Alternate branch', timestamp } }),
  setValue(branchTip('main'), 'old-answer'),
  setValue(branchTip('alternate'), 'other-user'),
  setValue(sessionName, 'Synthetic 0.87.1 session'),
  setValue(laneConfig('main'), { model: { provider: 'configured-provider', modelId: 'fixture-model' }, thinkingLevel: 'medium', activeToolNames: ['read'] }),
  appendList(list('fixture', 'events'), { entryId: 'old-answer' }),
  setValue(laneState('main'), { currentOperationId: null, lastOperationId: null, inbox: [] }),
  insertUsage({ id: 'old-usage', entryId: 'old-answer', usage, adjustment: false }),
]
const committed = prepareStorageCommit(writes, 1, timestamp).writes
validateCommittedWrites(committed, 1, { hasEntryId: () => false, hasEntryOrUsageId: () => false })
const { MemoryStorage } = await import(pathToFileURL(`${packagePath}/dist/harness/session/memory.js`))
const { restoreSession } = await import(pathToFileURL(`${packagePath}/dist/harness/runtime/restore.js`))
const storage = new MemoryStorage({ now: () => timestamp })
await storage.commit(writes, {})
const restored = await restoreSession(new StorageBackedSession({ id: 'fixture', createdAt: timestamp, storageVersion: 4 }, storage), {})
deepStrictEqual(restored.get('main'), { tipId: 'old-answer', configuration: writes[6].value, inbox: [], lastOperationId: null, operation: null })
console.log(`{
  "sourceVersion": "${version}",
  "timestamp": ${timestamp},
  "writes": [
${committed.map(write => '    ' + JSON.stringify(write)).join(',\n')}
  ]
}`)

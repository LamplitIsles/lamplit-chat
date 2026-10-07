import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { ensureNativeRoot, migrationPreflight } from './native-data-migration'
import { PiSessionStorage } from './pi-session-storage'
import type { PiSession } from './pi-session'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai'
import { openPiSessionStore } from 'agents/harness/pi'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import fixture from './fixtures/pi-0871-writes.json'

it('converts a test-owned deployed-format replica atomically, preserves source bytes/IDs/branches/domain rows and makes native context readable',async()=>{
  const stub=env.PiSession.getByName('native-conversion-replica') as DurableObjectStub<PiSession>
  await runInDurableObject(stub,async(instance,state)=>{
    const domain=new PiSessionStorage(state.storage)
    domain.initialize({id:'native-conversion-replica',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',lineage:{type:'new'}})
    const workspace = Reflect.get(instance,'workspace') as import('./computer-workspace').ComputerWorkspace
    await workspace.mkdir('/workspace/memory',{recursive:true})
    await workspace.writeFile('/workspace/AGENTS.md','Replica companion instructions\n')
    await workspace.writeFile('/workspace/memory/2026-09-01.md','Replica diary bytes 🕯\n')
    state.storage.sql.exec('CREATE TABLE pi_v4_writes(seq INTEGER PRIMARY KEY,data TEXT NOT NULL)')
    for(const write of fixture.writes)state.storage.sql.exec('INSERT INTO pi_v4_writes VALUES (?,?)',write.seq,JSON.stringify(write))
    const operationId = crypto.randomUUID(), photoId = crypto.randomUUID()
    const variants = ['original','preview','model'].map(variant=>`conversation-photos/native-conversion-replica/${photoId}/${variant}`)
    const bytes = new Uint8Array([137,80,78,71,13,10,26,10])
    for(const key of variants) await env.COMPUTER_R2!.put(key,bytes)
    domain.reservePhoto({id:photoId,operationId,name:'replica.png',mediaType:'image/png',created:123,order:0}, 'replica-image-bytes', 7)
    domain.completePhoto(photoId,'replica-image-bytes')
    domain.freezePhotos(operationId,[photoId])
    domain.saveInput(operationId,'Synthetic old prompt',[photoId],'prompt')
    domain.recordChat(operationId,{operationId,text:'Synthetic old prompt',images:[{attachmentId:photoId,name:'replica.png',mediaType:'image/png',availability:'available'}],turnId:operationId})
    state.storage.sql.exec('INSERT INTO pi_prompt_submissions VALUES (?,?,?,?,?)',operationId,'original-identity','accepted','old-user','2026-09-01T00:00:00Z')
    const domainTables=['conversation_photos','conversation_photo_groups','chat_inputs','chat_submissions','pi_prompt_submissions']
    const before = domainTables.map(table => state.storage.sql.exec('SELECT * FROM '+table).toArray())
    domain.setSetting('timedWakes',[{fixture:'retained'}]);domain.setSetting('memoryExtractionRevision',2)
    const sql=await openPiSessionStore(state.storage,{prefix:'replica_native_'})
    const harness=await Harness.open(sql,{models:createModels(),registry:createRegistry()},context)
    try{
      const root=await ensureNativeRoot(harness,domain,context)
      expect((await root.context(context)).messages.map(message=>message.role)).toEqual(['user','assistant'])
      expect(JSON.stringify((await root.context(context)).messages)).toContain('Synthetic old reply')
      expect(domain.entriesInOrder().map(entry=>entry.id)).toEqual(['old-user','old-answer','other-user'])
      expect(domain.legacyWrites()).toEqual(fixture.writes)
      expect(domain.sourceId((await root.context(context)).entries[0].id)).toBe('old-user')
      expect(domain.getSetting('timedWakes')).toEqual([{fixture:'retained'}])
      expect(domain.getSetting('memoryExtractionRevision')).toBe(2)
      expect(await workspace.readFile('/workspace/AGENTS.md')).toBe('Replica companion instructions\n')
      expect(await workspace.readFile('/workspace/memory/2026-09-01.md')).toBe('Replica diary bytes 🕯\n')
      for(const key of variants) expect(new Uint8Array(await (await env.COMPUTER_R2!.get(key))!.arrayBuffer())).toEqual(bytes)
      expect(domain.inputEntry(operationId)).toBe('old-user')
      expect(domain.photosForEntry('old-user').map(photo=>photo.id)).toEqual([photoId])
      expect(domain.nativeInputs()[0]?.photoIds).toEqual([photoId])
      expect(domainTables.map(table=>state.storage.sql.exec('SELECT * FROM '+table).toArray()).map((rows,index)=>index===0 ? rows.map(row=>({...row,entry_id:null})) : rows)).toEqual(before)

      await ensureNativeRoot(harness,domain,context)
      expect((await root.entries({},100,undefined,context)).items).toHaveLength(2)
      expect(domain.getSetting('nativeConversion')).toMatchObject({records:3,writes:10,activeTip:'old-answer'})
    }finally{await harness.close(context)}
  })
})
it('refuses conversion of an interrupted old run before changing any source/domain data',async()=>{
 const stub=env.PiSession.getByName('native-conversion-busy-replica') as DurableObjectStub<PiSession>
 await runInDurableObject(stub,async(_instance,state)=>{
  const domain=new PiSessionStorage(state.storage)
  state.storage.sql.exec('CREATE TABLE pi_v4_writes(seq INTEGER PRIMARY KEY,data TEXT NOT NULL)')
  const write={kind:'value',op:'set',seq:1,namespace:'pi.lane.state',key:'main',value:{currentOperationId:'interrupted',inbox:[]}}
  state.storage.sql.exec('INSERT INTO pi_v4_writes VALUES (?,?)',1,JSON.stringify(write))
  expect(()=>migrationPreflight(domain)).toThrow('old session idle')
  expect(domain.legacyWrites()).toEqual([write]);expect(domain.getSetting('nativeConversion')).toBeUndefined()
 })
 vi.restoreAllMocks()
})

it('preserves the deployed 0.99 compaction tail, image bytes and post-summary context without replaying old runs', async () => {
  const stub = env.PiSession.getByName('native-conversion-099-compaction') as DurableObjectStub<PiSession>
  await runInDurableObject(stub, async (_instance, state) => {
    const domain = new PiSessionStorage(state.storage)
    const time = 1788220800000
    const tail = { role: 'user' as const, content: [{ type: 'text' as const, text: 'retained image request' }, { type: 'image' as const, data: 'Zml4dHVyZQ==', mimeType: 'image/jpeg' }], timestamp: time }
    const failed = { ...fixture.writes[1].message!, stopReason: 'error', content: [{ type: 'text', text: 'excluded failed reply' }] }
    const writes = [
      fixture.writes[0],
      { kind: 'entry', type: 'compaction', id: 'checkpoint', parentId: 'old-user', seq: 2, timestamp: time, summary: 'Preserved continuity', tokensBefore: 12345, retainedTail: [tail, failed] },
      { kind: 'entry', type: 'branch_summary', id: 'historic-summary', parentId: 'checkpoint', seq: 3, timestamp: time, fromId: 'old-user', summary: 'Preserved historical summary' },
      { kind: 'entry', type: 'message', id: 'latest', parentId: 'historic-summary', seq: 4, timestamp: time, message: { role: 'user', content: 'latest input', timestamp: time } },
      { kind: 'value', op: 'set', seq: 5, namespace: 'pi.branch.tip', key: 'main', value: 'latest' },
    ]
    state.storage.sql.exec('CREATE TABLE pi_v4_writes(seq INTEGER PRIMARY KEY,data TEXT NOT NULL)')
    for (const write of writes) state.storage.sql.exec('INSERT INTO pi_v4_writes VALUES (?,?)', write.seq, JSON.stringify(write))
    const sql = await openPiSessionStore(state.storage, { prefix: 'replica_native_' })
    const harness = await Harness.open(sql, { models: createModels(), registry: createRegistry() }, context)
    try {
      const root = await ensureNativeRoot(harness, domain, context)
      const view = await root.context(context)
      expect(view.messages).toHaveLength(4)
      expect(view.messages[1]).toEqual(tail)
      expect(JSON.stringify(view.messages)).toContain('Preserved continuity')
      expect(JSON.stringify(view.messages)).toContain('Preserved historical summary')
      expect(JSON.stringify(view.messages)).not.toContain('Synthetic old prompt')
      expect(JSON.stringify(view.messages)).not.toContain('excluded failed reply')
      expect(domain.legacyWrites()).toEqual(writes)
      expect(domain.getEntrySync('checkpoint')).toMatchObject({ retainedTail: [tail, failed], tokensBefore: 12345 })
      expect(domain.sourceId(view.entries.at(-1)!.id)).toBe('latest')
    } finally { await harness.close(context) }
  })
})


it.each([false, true])('settles proven old terminal Keet without replay and preserves pending rows (%s)', async pending => {
  const stub = env.PiSession.getByName('terminal-keet-replica-' + pending) as DurableObjectStub<PiSession>
  const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Historic execution must not replay'))
  try { await runInDurableObject(stub, async (instance, state) => {
    const domain = new PiSessionStorage(state.storage)
    domain.initialize({ id: 'terminal-keet-replica', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', lineage: { type: 'new' } })
    state.storage.sql.exec('CREATE TABLE pi_v4_writes(seq INTEGER PRIMARY KEY,data TEXT NOT NULL)')
    const terminal = { kind: 'value', op: 'set', seq: 11, namespace: 'pi.result', key: 'old-keet', value: { operationId: 'old-keet', kind: 'prompt', status: 'completed', fromTipId: null, tipId: 'old-answer', startedAt: fixture.timestamp, endedAt: fixture.timestamp + 1 } }
    for (const write of [...fixture.writes, terminal]) state.storage.sql.exec('INSERT INTO pi_v4_writes VALUES (?,?)', write.seq, JSON.stringify(write))
    const source = JSON.stringify({ kind: 'dm', sender: 'Fixture sender', destination: 'Fixture room', context: [], text: 'Synthetic old prompt' })
    state.storage.sql.exec('INSERT INTO keet_queue VALUES (?,?,?,?,?,?)', 1, 'old-keet', 'Private attribution', source, 'old-user', 'accepted')
    state.storage.sql.exec('INSERT INTO keet_sources VALUES (?,?,?)', 'old-user', source, 'Private attribution')
    if (pending) state.storage.sql.exec('INSERT INTO keet_queue VALUES (?,?,?,?,?,?)', 2, 'pending-keet', 'Pending private attribution', source, null, 'pending')
    const queues = state.storage.sql.exec('SELECT * FROM keet_queue ORDER BY sequence').toArray()
    const sources = state.storage.sql.exec('SELECT * FROM keet_sources').toArray()
    const harness = await (instance as unknown as import('./fixtures/native-session').NativeFixture).getHarness()
    const root = await harness.root(context)
    expect(state.storage.sql.exec('SELECT * FROM keet_queue ORDER BY sequence').toArray()).toEqual(queues.map(row => row.sequence === 1 ? { ...row, state: 'settled' } : row))
    expect(state.storage.sql.exec('SELECT * FROM keet_sources').toArray()).toEqual(sources)
    expect(domain.legacyWrites()).toEqual([...fixture.writes, terminal])
    expect(domain.keetSource('old-user')).toEqual(JSON.parse(source))
    expect((await root.entries({}, 100, undefined, context)).items).toHaveLength(2)
    expect((await harness.inspect(context)).tasks).toHaveLength(0)
    if (!pending) { await instance.drainPendingWork(); expect(domain.nextKeet()).toBeUndefined() }
    else expect(domain.nextKeet()).toMatchObject({ operationId: 'pending-keet', state: 'pending', entryId: null })
    await ensureNativeRoot(harness, domain, context)
    expect((await root.entries({}, 100, undefined, context)).items).toHaveLength(2)
    expect(upstream).not.toHaveBeenCalled()
    await (instance as unknown as import('./fixtures/native-session').NativeFixture).native.dispose()
  }) } finally { vi.restoreAllMocks() }
})

it('refuses accepted legacy Keet without terminal proof before converting or settling anything', async () => {
  const stub = env.PiSession.getByName('unproven-keet-replica') as DurableObjectStub<PiSession>
  await runInDurableObject(stub, async (_instance, state) => {
    const domain = new PiSessionStorage(state.storage)
    state.storage.sql.exec('CREATE TABLE pi_v4_writes(seq INTEGER PRIMARY KEY,data TEXT NOT NULL)')
    for (const write of fixture.writes) state.storage.sql.exec('INSERT INTO pi_v4_writes VALUES (?,?)', write.seq, JSON.stringify(write))
    state.storage.sql.exec('INSERT INTO keet_queue VALUES (?,?,?,?,?,?)', 1, 'unproven-keet', 'Private attribution', '{}', 'old-user', 'accepted')
    const before = state.storage.sql.exec('SELECT * FROM keet_queue').toArray()
    expect(() => migrationPreflight(domain)).toThrow('explicitly drain it on the old version')
    expect(state.storage.sql.exec('SELECT * FROM keet_queue').toArray()).toEqual(before)
    expect(domain.legacyWrites()).toEqual(fixture.writes)
    expect(domain.getSetting('nativeConversion')).toBeUndefined()
  })
})

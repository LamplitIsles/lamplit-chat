import { expect, it, vi } from 'vitest'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { Conversation } from '@earendil-works/pi-durable'
import { nativeOptions } from './fixtures/native-harness-options'
import { createPiHarness } from './create-pi-harness'
import { nativeReply } from './fixtures/native-provider'
import { DEFAULT_COMPANION_COMPACTION_PROMPT } from './companion-compaction-prompt'

async function history(root: Conversation, prefix: string, turns=6) {
  await root.commit(async tx => {
    for (let i=0;i<turns;i++) {
      await tx.appendEntry(root.id,{kind:'pi.user',model:[{role:'user',content:`${prefix} ${i} `+'x'.repeat(1200),timestamp:i}]})
      await tx.appendEntry(root.id,{kind:'pi.assistant',model:[fauxAssistantMessage('Fixture answer '+i)]})
    }
  },context)
}
it('native manual summary uses companion default/custom policy, persists silently and preserves original history/previous summary', async () => {
  const requests: Record<string,unknown>[]=[]
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{requests.push(JSON.parse(init!.body as string));return nativeReply('openrouter','Fixture continuity '+requests.length)})
  let prompt=DEFAULT_COMPANION_COMPACTION_PROMPT
  const options=nativeOptions(),harness=await createPiHarness({...options,loadCompactionPrompt:async()=>prompt})
  try {
    const root=await harness.root(context,{agent:{model:{provider:'openrouter',modelId:'openai/gpt-4o'}}})
    await root.commit(async tx => {
      await tx.appendEntry(root.id, { kind: 'pi.user', model: [{ role: 'user', content: '<read-files>\n/workspace/notes.md\n</read-files>\n<modified-files>\n/workspace/soul.md\n</modified-files>', timestamp: 10 }] })
    }, context)
    await history(root,'Ordinary fixture')
    const first=await harness.waitForTask(await root.compact(undefined,context),context)
    expect(first.state.outcome.status).toBe('completed')
    await root.waitForIdle(context)
    const view=await root.context(context)
    expect(view.head?.kind).toBe('pi.compaction')
    expect(JSON.stringify(view.messages)).toContain('Fixture continuity 1')
    expect(JSON.stringify(view.messages)).toContain('/workspace/notes.md')
    expect(JSON.stringify(view.messages)).toContain('/workspace/soul.md')
    expect(JSON.stringify(requests[0].messages)).toContain('Our Relationship')
    expect(JSON.stringify(requests[0].messages)).not.toContain('coding assistant')
    prompt='Fixture custom companion checkpoint'
    await history(root,'Recent fixture')
    await harness.waitForTask(await root.compact('keep the promise',context),context);await root.waitForIdle(context)
    expect(JSON.stringify(requests[1].messages)).toContain(prompt)
    expect(JSON.stringify(requests[1].messages)).toContain('previous-summary')
    expect(JSON.stringify(requests[1].messages)).toContain('Fixture continuity 1')
    const stored=await root.entries({},100,undefined,context)
    expect(stored.items.filter(entry=>entry.kind==='pi.user')).toHaveLength(13)
    expect(stored.items.filter(entry=>entry.kind==='pi.compaction')).toHaveLength(2)
  } finally {await harness.close(context);fetch.mockRestore()}
})
it.each(['DM','Group'])('native %s maintenance retains frozen private Keet attribution in summary and split prefix without mutating transcript',async kind=>{
  const requests:Record<string,unknown>[]=[]
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{requests.push(JSON.parse(init!.body as string));return nativeReply('openrouter','Keet continuity')})
  const options=nativeOptions()
  const harness=await createPiHarness({...options,compaction:{enabled:true,reserveTokens:1024,keepRecentTokens:4}})
  try{
    const root=await harness.root(context,{agent:{model:{provider:'openrouter',modelId:'openai/gpt-4o'}}})
    await history(root,`[Keet ${kind}; sender Alice; private contextual attribution] Visible Keet`)
    await harness.waitForTask(await root.compact(undefined,context),context);await root.waitForIdle(context)
    expect(JSON.stringify(requests[0].messages)).toContain(`Keet ${kind}`)
    expect(JSON.stringify(requests[0].messages)).toContain('private contextual attribution')
    const originals=await root.entries({},100,undefined,context)
    expect(JSON.stringify(originals.items.filter(entry=>entry.kind==='pi.user'))).toContain('private contextual attribution')
  }finally{await harness.close(context);fetch.mockRestore()}
})
it('native failed companion summarization declines without applying another policy or replacing active context',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({error:{message:'fixture rejection'}},{status:400}))
  const harness=await createPiHarness(nativeOptions())
  try{
    const root=await harness.root(context,{agent:{model:{provider:'openrouter',modelId:'openai/gpt-4o'}}});await history(root,'Original fixture')
    const before=await root.context(context)
    await harness.waitForTask(await root.compact(undefined,context),context);await root.waitForIdle(context)
    expect(await root.context(context)).toEqual(before)
    expect(fetch).toHaveBeenCalledTimes(1)
  }finally{await harness.close(context);fetch.mockRestore()}
})

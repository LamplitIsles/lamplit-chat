import { nativeOptions } from './fixtures/native-harness-options'
import { expect, it, vi } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createPiHarness } from './create-pi-harness'
import { nativeReply } from './fixtures/native-provider'

it('persists a public native submission and projects tools, companion policy, time, image and account output cap', async () => {
  const requests: Record<string, unknown>[] = []
  const fetch = vi.spyOn(globalThis,'fetch').mockImplementation(async (_url, init) => { requests.push(JSON.parse(init!.body as string)); return nativeReply('openrouter', 'Offline native answer') })
  const options = nativeOptions()
  const harness = await createPiHarness(options)
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'openrouter', modelId: 'openai/gpt-4o' } } })
    const submission = await root.submit({ type: 'input', requestId: 'one', content: [{ type: 'text', text: 'Describe fixture' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }, BACKGROUND_CONTEXT)
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done')
    expect(requests).toHaveLength(1)
    expect(requests[0].max_completion_tokens).toBe(64)
    expect(requests[0].tools).toMatchObject([{ function: { name: 'read' } }])
    const body = JSON.stringify(requests[0].messages)
    for (const value of ['Learned fixture memory','Fixture relationship','Workspace fixture instructions','Host turn time','image/png']) expect(body).toContain(value)
    const duplicate = await root.submit({ type: 'input', requestId: 'one', content: 'native requestId does not compare' }, BACKGROUND_CONTEXT)
    expect(duplicate.id).toBe(submission.id)
    expect(requests).toHaveLength(1)
    expect((await root.context(BACKGROUND_CONTEXT)).messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Offline native answer' }] })
  } finally { await harness.close(BACKGROUND_CONTEXT); fetch.mockRestore() }
})
it('reopening the native registry offers newly deployed domain tools without old lane configuration', async () => {
  const options = nativeOptions()
  const keepOpen = vi.spyOn(options.storage, 'close').mockResolvedValue()
  const first = await createPiHarness(options)
  const root = await first.root(BACKGROUND_CONTEXT)
  expect((await root.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).toEqual(['read'])
  await first.close(BACKGROUND_CONTEXT)
  const second = await createPiHarness({ ...options, tools: [...options.tools,{ ...options.tools[0], name: 'read_relationship_history' }] })
  try { expect((await (await second.root(BACKGROUND_CONTEXT)).agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name)).toEqual(['read','read_relationship_history']) }
  finally { await second.close(BACKGROUND_CONTEXT); keepOpen.mockRestore(); await options.storage.close(BACKGROUND_CONTEXT) }
})

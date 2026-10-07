import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'
import { nativeReply } from './fixtures/native-provider'
import worker from '../server'

it('uses the actual native DO/socket to admit once, reject changed content and preserve submitted after failed reply/reconnect', async () => {
  const fetch = vi.spyOn(globalThis,'fetch').mockImplementation(async () => nativeReply('openrouter','Complete native reply'))
  let socket: WebSocket | undefined, client: Awaited<ReturnType<typeof openChat>> | undefined
  try {
    const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
    const created = await registry.createSession({ name:'Native chat fixture' })
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, instance => vi.spyOn(instance as unknown as { scheduleMemoryExtraction():void },'scheduleMemoryExtraction').mockImplementation(()=>{}))
    let view: ChatView | undefined
    const connect = async () => {
      const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket',{ headers:{ upgrade:'websocket',origin:'https://chat.fixture',authorization:`Basic ${btoa('owner:fixture-password-long-enough')}` } }),{ ...env,COMPANION_SESSION_ID:created.id } as Env)
      expect(response.status).toBe(101); socket = response.webSocket!; socket.accept()
      client = await openChat(socket,next=>{view=next},()=>{})
    }
    await connect()
    const input = { operationId:crypto.randomUUID(),text:'Native durable input' }
    expect(await client!.lookup(input.operationId)).toBeNull()
    expect(await client!.submit(input)).toMatchObject({ state:'submitted',operationId:input.operationId })
    expect(await client!.submit(input)).toMatchObject({ state:'submitted' })
    await expect(client!.submit({ ...input,text:'changed' })).rejects.toThrow('Request could not be completed')
    await vi.waitFor(()=>expect(view?.messages.some(message=>message.text==='Complete native reply')).toBe(true),{ timeout:10000 })
    expect(view!.version).toBe(2)
    expect(view!.messages.filter(message=>message.operationId===input.operationId&&message.role==='user')).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    client!.close(); socket!.close(); await connect()
    expect(await client!.lookup(input.operationId)).toMatchObject({ state:'submitted' })
    fetch.mockImplementation(async()=>Response.json({ error:{ message:'fixture reply refused' } },{ status:400 }))
    const failed = { operationId:crypto.randomUUID(),text:'Fail only this reply' }
    expect(await client!.submit(failed)).toMatchObject({ state:'submitted' })
    await vi.waitFor(()=>expect(view?.messages.some(message=>message.text==='回复失败')).toBe(true),{ timeout:10000 })
    expect(await client!.lookup(failed.operationId)).toMatchObject({ state:'submitted' })
    expect(view!.recovery).toEqual([])
  } finally { client?.close();socket?.close();fetch.mockRestore() }
})

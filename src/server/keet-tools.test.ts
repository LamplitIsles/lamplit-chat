import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'
import { callKeetTool, createKeetTools } from './keet-tools'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())) })

async function fakeMcp() {
  const calls: Array<{ name: string; args: unknown; headers: Record<string, string | string[] | undefined> }> = []
  let deleted = 0
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') { deleted++; response.writeHead(200).end(); return }
    if (request.method === 'GET') { response.writeHead(405).end(); return }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const message = JSON.parse(raw) as { id?: number; method: string; params?: { name: string; arguments: unknown } }
    if (message.id === undefined) { response.writeHead(202).end(); return }
    response.setHeader('content-type', 'application/json')
    response.setHeader('mcp-session-id', 'fake-session')
    if (message.method === 'initialize') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }))
      return
    }
    calls.push({ name: message.params!.name, args: message.params!.arguments, headers: request.headers })
    if (!['list_destinations', 'list_members', 'read_recent_messages', 'send_message'].includes(message.params!.name)) {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Unknown KFA tool' }] } }))
      return
    }
    const value = message.params!.name === 'list_destinations' ? { destinations: [{ destinationName: 'Peer', kind: 'dm' }, { destinationName: 'Room', kind: 'group' }] } : { sent: true, reacted: true }
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const env = { KEET_MCP_URL: 'https://keet.fixture.invalid/mcp', KEET_MCP_TOKEN: 'kfa-token' } as Env
  const fetcher: typeof fetch = (_input, init) => fetch(base, init)
  return { calls, env, fetcher, get deleted() { return deleted } }
}

describe('Keet text MCP tools', () => {
  it('maps fixed tools, sends MCP bearer authentication, validates destinations, and closes sessions', async () => {
    const fake = await fakeMcp()
    expect(await callKeetTool(fake.env, 'send_message', { destinationName: 'Peer', text: 'hello' }, undefined, fake.fetcher)).toContain('sent')
    expect(fake.calls.map((call) => call.name)).toEqual(['list_destinations', 'send_message'])
    expect(fake.calls[0]?.headers).toMatchObject({ authorization: 'Bearer kfa-token' })
    expect(fake.calls[0]?.headers).not.toHaveProperty('cf-access-client-id')
    expect(fake.calls[0]?.headers).not.toHaveProperty('cf-access-client-secret')
    expect(fake.deleted).toBeGreaterThanOrEqual(1)
    await expect(callKeetTool(fake.env, 'send_message', { destinationName: 'Unlisted', text: 'hello' }, undefined, fake.fetcher)).rejects.toThrow('not an admitted')
    expect(fake.calls.map((call) => call.name)).toEqual(['list_destinations', 'send_message', 'list_destinations'])
    await expect(callKeetTool({ ...fake.env, KEET_MCP_TOKEN: '' }, 'list_destinations', {}, undefined, fake.fetcher)).rejects.toThrow('KEET_MCP_TOKEN')
  })

  it('bounds actual read/send arguments and refuses unsafe endpoints before any transport request', async () => {
    const fake = await fakeMcp()
    expect(await callKeetTool(fake.env, 'list_members', { destinationName: 'Room' }, undefined, fake.fetcher)).toContain('sent')
    expect(await callKeetTool(fake.env, 'read_recent_messages', { destinationName: 'Peer', last: 50 }, undefined, fake.fetcher)).toContain('sent')
    const count = fake.calls.length
    for (const args of [{ destinationName: 'Peer', last: 0 }, { destinationName: 'Peer', last: 51 }, { destinationName: 'Peer', last: 1, source: 'forged' }]) {
      await expect(callKeetTool(fake.env, 'read_recent_messages', args, undefined, fake.fetcher)).rejects.toThrow('Invalid Keet tool arguments')
    }
    await expect(callKeetTool(fake.env, 'send_message', { destinationName: 'Peer', text: 'x'.repeat(16001) }, undefined, fake.fetcher)).rejects.toThrow('Invalid Keet tool arguments')
    for (const url of ['http://keet.fixture.invalid/mcp', 'https://user:secret@keet.fixture.invalid/mcp', 'https://keet.fixture.invalid/mcp?token=bad', 'https://keet.fixture.invalid/other']) {
      await expect(callKeetTool({ ...fake.env, KEET_MCP_URL: url }, 'list_destinations', {}, undefined, fake.fetcher)).rejects.toThrow('HTTPS /mcp endpoint')
    }
    expect(fake.calls).toHaveLength(count)
  })

  it('reports a lost send response as uncertain and does not retry', async () => {
    const fake = await fakeMcp()
    let sends = 0
    const fetcher: typeof fetch = async (input, init) => {
      const body = init?.body
      if (typeof body === 'string' && body.includes('send_message')) { sends++; throw new Error('connection lost') }
      return fake.fetcher(input, init)
    }
    await expect(callKeetTool(fake.env, 'send_message', { destinationName: 'Peer', text: 'hello' }, undefined, fetcher)).rejects.toThrow('outcome is uncertain')
    expect(sends).toBe(1)
  })

  it('exposes the KFA text send fields to Pi and forwards them through MCP', async () => {
    const reaction = { targetMessageId: { deviceId: 'peer', seq: 42 }, emoji: '❤️' }
    const args = { destinationName: 'Room', text: 'hello', replyTo: { deviceId: 'peer', seq: 40 }, mentions: ['Alice'], reaction }
    const tools = createKeetTools({} as Env)
    expect(tools.map((tool) => tool.name)).toEqual(['keet_list_destinations', 'keet_list_members', 'keet_read_recent_messages', 'keet_send_message'])
    const send = tools.find((tool) => tool.name === 'keet_send_message')!
    expect(Value.Check(send.parameters, args)).toBe(true)
    const fake = await fakeMcp()
    expect(await callKeetTool(fake.env, 'send_message', args, undefined, fake.fetcher)).toContain('"reacted":true')
    expect(fake.calls.at(-1)).toMatchObject({ name: 'send_message', args })
  })
})

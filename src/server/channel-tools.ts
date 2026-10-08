import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { Channel, ChannelConfig, Channels } from './channel-config'

// Fixed upstream short names; native Pi's flat namespace is channel-prefixed.
const keetId = Type.Object({ deviceId: Type.String({ minLength: 1, maxLength: 512 }), seq: Type.Integer({ minimum: 0 }) })
const destination = Type.String({ minLength: 1, maxLength: 512 })
const room = Type.String({ minLength: 1, maxLength: 255 })
const definitions = {
  keet: {
    list_destinations: Type.Object({}),
    list_members: Type.Object({ destinationName: destination }),
    read_recent_messages: Type.Object({ destinationName: destination, last: Type.Integer({ minimum: 1, maximum: 50 }) }),
    send_message: Type.Object({ destinationName: destination, text: Type.String({ minLength: 1, maxLength: 16000 }), replyTo: Type.Optional(keetId), mentions: Type.Optional(Type.Array(destination, { minItems: 1, maxItems: 128 })), reaction: Type.Optional(Type.Object({ targetMessageId: keetId, emoji: Type.String({ minLength: 1 }) })) }),
  },
  matrix: {
    whoami: Type.Object({}),
    list_rooms: Type.Object({}),
    list_room_members: Type.Object({ room_id: room }),
    read_messages: Type.Object({ room_id: room, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })), before: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }),
    send_message: Type.Object({ room_id: room, body: Type.String({ minLength: 1, maxLength: 16000 }), reply_to_event_id: Type.Optional(room), mentions: Type.Optional(Type.Array(Type.String({ maxLength: 255, pattern: '^@[^\\s:]+:[^\\s]+$' }), { maxItems: 100 })) }),
  },
}
export async function callChannelTool(config: ChannelConfig, channel: Channel, name: string, args: Record<string, unknown>, signal?: AbortSignal, fetcher: typeof fetch = fetch, timeout = 10000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const client = new Client({ name: 'lamplit-chat', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${config.mcpToken}` }, redirect: 'manual' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      if (new URL(String(url)).href !== new URL(config.mcpUrl).href) throw new Error('MCP endpoint changed')
      const response = await fetcher(url, { ...init, redirect: 'manual', signal: init?.signal ? AbortSignal.any([init.signal, abortSignal]) : abortSignal })
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('MCP redirect refused') }
      return response
    },
  })
  let sending = false
  try {
    await client.connect(transport, { signal: abortSignal, timeout })
    sending = name === 'send_message'
    const result = await client.callTool({ name, arguments: args }, undefined, { signal: abortSignal, timeout })
    if (result.isError) throw new Error('Upstream tool failed')
    if (!Array.isArray(result.content)) throw new Error('Invalid MCP result')
    const text = result.content.filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
    return text.slice(0, 32000)
  } catch {
    throw new Error(sending ? `${channel} send outcome is uncertain; message may have been sent. Do not retry automatically.` : `${channel} ${name} unavailable.`)
  } finally {
    controller.abort()
    clearTimeout(timer)
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}
export async function discoverMatrixSelf(config: ChannelConfig): Promise<string> {
  try {
    const result = JSON.parse(await callChannelTool(config, 'matrix', 'whoami', {})) as { user_id?: unknown }
    if (typeof result.user_id !== 'string' || !/^@[^\s:]+:[^\s]+$/.test(result.user_id) || result.user_id.length > 255) throw new Error('Invalid identity')
    return result.user_id
  } catch { throw new Error('Matrix identity unavailable') }
}
export function createChannelTools(configs: Channels): AgentHarnessTool<undefined>[] {
  return (['keet', 'matrix'] as const).flatMap(channel => {
    const config = configs[channel]
    if (!config) return []
    return Object.entries(definitions[channel]).map(([name, parameters]): AgentHarnessTool<undefined> => ({
      name: `${channel}_${name}`, label: `${channel} ${name}`, parameters, executionMode: 'sequential',
      description: name === 'send_message' ? `Send text through ${channel}. An uncertain outcome may have sent; never automatically retry. Reply and mention fields refer to this channel only.` : `Use the original ${channel} ${name} text capability.`,
      execute: async (_id, input, _update, _context, _invocation, context) => {
        const text = await callChannelTool(config, channel, name, input as Record<string, unknown>, context.abortSignal)
        return { content: [{ type: 'text', text }], details: {} }
      },
    }))
  })
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

const destination = Type.String({ minLength: 1, maxLength: 512 })
const noArgs = Type.Object({}, { additionalProperties: false })
const named = Type.Object({ destinationName: destination }, { additionalProperties: false })
const recent = Type.Object({ destinationName: destination, last: Type.Integer({ minimum: 1, maximum: 50 }) }, { additionalProperties: false })
const messageId = Type.Object({ deviceId: Type.String({ minLength: 1, maxLength: 512 }), seq: Type.Integer({ minimum: 0 }) })
const send = Type.Object({
  destinationName: destination,
  text: Type.String({ minLength: 1, maxLength: 16_000 }),
  replyTo: Type.Optional(messageId),
  mentions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 128 })),
  reaction: Type.Optional(Type.Object({ targetMessageId: messageId, emoji: Type.String({ minLength: 1 }) })),
}, { additionalProperties: false })

function configuration(env: Env): URL {
  if (!env.KEET_MCP_URL || !env.KEET_MCP_TOKEN) {
    throw new Error('Keet MCP needs KEET_MCP_URL and KEET_MCP_TOKEN.')
  }
  const url = new URL(env.KEET_MCP_URL)
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.hash || url.search) throw new Error('KEET_MCP_URL must be an HTTPS /mcp endpoint.')
  return url
}

export async function callKeetTool(env: Env, name: 'list_destinations' | 'list_members' | 'read_recent_messages' | 'send_message', args: Record<string, unknown>, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  const schema = { list_destinations: noArgs, list_members: named, read_recent_messages: recent, send_message: send }[name]
  if (!Value.Check(schema, args) || ('destinationName' in args && (typeof args.destinationName !== 'string' || !args.destinationName.trim() || /[\r\n\u2028\u2029]/.test(args.destinationName)))) throw new Error('Invalid Keet tool arguments.')
  const url = configuration(env)
  const client = new Client({ name: 'lamplit-chat', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const response = await fetcher(input, init)
      let bytes = 0
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength
          if (bytes > 112 * 1024) throw new Error('Keet MCP response exceeds byte limit.')
          controller.enqueue(chunk)
        },
      }))
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    },
    reconnectionOptions: { maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
    requestInit: { redirect: 'error', headers: {
      Authorization: `Bearer ${env.KEET_MCP_TOKEN}`,
    } },
  })
  try {
    await client.connect(transport, { signal, timeout: 10_000 })
    if (name !== 'list_destinations') {
      const listed = await client.callTool({ name: 'list_destinations', arguments: {} }, undefined, { signal, timeout: 10_000 })
      const parsed = readResult(listed)
      const list = JSON.parse(parsed) as { destinations?: Array<{ destinationName?: string }> }
      if (!list.destinations?.some((item) => item.destinationName === args.destinationName)) throw new Error('destinationName is not an admitted Keet destination.')
    }
    let result: Awaited<ReturnType<typeof client.callTool>>
    try {
      result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 15_000 })
    } catch (error) {
      if (name === 'send_message') {
        const message = error instanceof Error ? error.message.slice(0, 250) : 'connection lost'
        throw new UncertainKeetSend(`Keet send outcome is uncertain; do not retry automatically. ${message}`)
      }
      throw error
    }
    return readResult(result)
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 250) : 'Keet MCP request failed.'
    if (error instanceof UncertainKeetSend) throw error
    throw new Error(`Keet ${name} failed: ${message}`)
  } finally {
    await transport.terminateSession().catch(() => undefined)
    await client.close().catch(() => undefined)
  }
}

class UncertainKeetSend extends Error {}

function readResult(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) throw new Error('Unexpected Keet MCP result.')
  const response = result as { content: Array<{ type: string; text?: string }>; isError?: boolean }
  const text = response.content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n').slice(0, 16_000)
  if (response.isError) throw new Error(text || 'Remote Keet tool failed.')
  return text
}

function toolResult(text: string) { return { content: [{ type: 'text' as const, text }], details: {} } }
function argumentsObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Keet tool arguments.')
  return input as Record<string, unknown>
}

export function createKeetTools(env: Env): ToolRegistration[] {
  return [
    { name: 'keet_list_destinations', replay: 'safe', description: 'List destinations admitted by Keet.', parameters: noArgs, executionMode: 'sequential',
      execute: async (_input, _api, context) => toolResult(await callKeetTool(env, 'list_destinations', {}, context.abortSignal)) },
    { name: 'keet_list_members', replay: 'safe', description: 'List members in one admitted Keet destination.', parameters: named, executionMode: 'sequential',
      execute: async (input, _api, context) => toolResult(await callKeetTool(env, 'list_members', argumentsObject(input), context.abortSignal)) },
    { name: 'keet_read_recent_messages', replay: 'safe', description: 'Read 1–50 recent text messages from an admitted Keet destination without changing read state.', parameters: recent, executionMode: 'sequential',
      execute: async (input, _api, context) => toolResult(await callKeetTool(env, 'read_recent_messages', argumentsObject(input), context.abortSignal)) },
    { name: 'keet_send_message', description: 'Send required text to an admitted Keet destination. A regular Group may include a replyTo message ID and exact member-name mentions. A Group or DM may also include one emoji reaction to an exact message. For a DM, react only to the current Keet turn\'s triggering message. A reaction failure after a successful send does not undo the text. A timed out send may have succeeded; never retry it automatically.', parameters: send, executionMode: 'sequential',
      execute: async (input, _api, context) => toolResult(await callKeetTool(env, 'send_message', argumentsObject(input), context.abortSignal)) },
  ]
}

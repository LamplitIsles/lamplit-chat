import { EventStreamCodec } from '@smithy/core/event-streams'

// Test-only upstream responses; no network or provider credentials are required.
export function nativeReply(provider: string, text = 'Native fixture reply', tool: boolean | { name: string; arguments: Record<string, unknown> } = false): Response {
  provider = ({ 'openai-responses': 'openai', 'anthropic-messages': 'anthropic', 'google-generative-ai': 'google', 'google-vertex': 'google', 'openai-completions': 'openrouter', 'mistral-conversations': 'openrouter' } as Record<string, string>)[provider] ?? provider
  const call = typeof tool === 'object' ? tool : { name: 'read', arguments: { path: '/workspace/fixture-missing.txt' } }
  let events: object[]
  if (provider === 'bedrock-converse-stream') {
    const encoder = new TextEncoder(), decoder = new TextDecoder()
    const codec = new EventStreamCodec(bytes => decoder.decode(bytes), value => encoder.encode(value))
    const chunks = [
      { messageStart: { role: 'assistant' } },
      ...(tool ? [
        { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'call_fixture', name: call.name } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: JSON.stringify(call.arguments) } } } },
      ] : [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } }]),
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: tool ? 'tool_use' : 'end_turn' } },
      { metadata: { usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }, metrics: { latencyMs: 1 } } },
    ].map(event => {
      const [type, body] = Object.entries(event)[0]
      return codec.encode({ headers: { ':message-type': { type: 'string', value: 'event' }, ':event-type': { type: 'string', value: type }, ':content-type': { type: 'string', value: 'application/json' } }, body: encoder.encode(JSON.stringify(body)) })
    })
    return new Response(new Blob(chunks.map(chunk => new Uint8Array(chunk))), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
  } else if (provider === 'pi-messages') {
    const usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    events = tool ? [
      { type: 'toolcall_start', contentIndex: 0, id: 'call_fixture', toolName: call.name },
      { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(call.arguments) },
      { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'call_fixture', name: call.name, arguments: call.arguments } },
    ] : [
      { type: 'text_start', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 0, delta: text },
      { type: 'text_end', contentIndex: 0, content: text },
    ]
    events.unshift({ type: 'start' })
    events.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', usage })
  } else if (provider === 'openai') {
    const item = tool ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed' }
      : { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    events = [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }]
  } else if (provider === 'anthropic') {
    events = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call_fixture', name: call.name, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } : { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]
  } else if (provider === 'google') {
    events = [{ candidates: [{ index: 0, content: { role: 'model', parts: tool ? [{ functionCall: { name: call.name, args: call.arguments } }] : [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 } }]
  } else {
    events = [
      { id: 'fixture', choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: 'assistant', content: text, ...(provider === 'deepseek' ? { reasoning_content: 'Private fixture reasoning' } : {}) }, finish_reason: null }] },
      { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ]
  }
  return new Response(events.map(event => `${provider === 'anthropic' ? `event: ${(event as { type: string }).type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (['deepseek', 'openrouter'].includes(provider) ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}

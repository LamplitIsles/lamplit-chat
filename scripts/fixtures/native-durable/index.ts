import { Agent } from 'agents'
import { PiHarness } from 'agents/harness/pi'
import { Harness, createRegistry, defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai'

type Input = { text: string; images: string[]; replacementIds: string[] }
type NativeContext = Parameters<Harness['close']>[0]
export class NativeGate extends Agent<Env> {
  private admission: Promise<unknown> = Promise.resolve()
  private nativeStorage?: SqliteStorage
  private nativeContext?: NativeContext
  harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.nativeStorage = storage
      this.nativeContext = context
      const fake = fauxProvider({ api: 'fixture-api', provider: 'fixture', models: [{ id: 'fixture' }] })
      fake.setResponses(Array.from({ length: 100 }, () => async (input) => {
        const userIndex = input.messages.findLastIndex(message => message.role === 'user')
        const user = input.messages[userIndex]
        const text = user?.role === 'user' && typeof user.content === 'string' ? user.content : ''
        await this.increment('modelCalls')
        await fetch('https://native-gate.invalid/model')
        if (text === 'model-hold') {
          await this.ctx.storage.put('modelStarted', true)
          await this.hold()
        }
        const toolResult = input.messages.slice(userIndex + 1).find(message => message.role === 'toolResult')
        if (toolResult) return fauxAssistantMessage(toolResult.isError ? 'interrupted tool observed' : 'native completed')
        const name = text === 'tool-unsafe' ? 'unsafe_tool' : 'safe_tool'
        return fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: 'toolUse' })
      }))
      const models = createModels()
      models.setProvider(fake.provider)
      const registry = createRegistry()
      registry.install(defineExtension({ name: 'fixture', tools: (['safe', 'unsafe'] as const).map(replay => defineTool({
        name: `${replay}_tool`, description: 'Worker native fixture tool', parameters: Type.Object({}), replay,
        execute: async (_args, api) => {
          await this.increment(`${replay}Invocations`)
          // Domain side-effect receipt: replay-safe execution can rerun, but the effect is deduplicated by callId.
          if (!await this.ctx.storage.get(`effect:${api.callId}`)) {
            await this.ctx.storage.put(`effect:${api.callId}`, true)
            await this.increment('effects')
          }
          const input = await this.harness.messages()
          const user = input.findLast(entry => entry.kind === 'pi.user')?.model?.[0]
          if (user?.role === 'user' && user.content === `tool-${replay}`) {
            await this.ctx.storage.put('toolStarted', replay)
            await this.hold()
          }
          return { content: [{ type: 'text', text: 'worker native tool completed' }] }
        },
      })) }))
      return Harness.open(storage, { models, registry }, context)
    },
    defaults: { model: { provider: 'fixture', id: 'fixture' } },
  })
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.lifecycle.use(this.harness) }
  private async increment(key: string) {
    await this.ctx.storage.put(key, (await this.ctx.storage.get<number>(key) ?? 0) + 1)
  }
  private async hold() {
    while (String(this.env.RESUME) !== 'true' && !await this.ctx.storage.get('release')) await new Promise(resolve => setTimeout(resolve, 20))
  }
  private async submit(operationId: string, input: Input) {
    // This immutable domain association is necessary for ordered image/replacement references and withdrawn inputs.
    // Native requestId deduplication alone does not compare content. No engine state is persisted here.
    const result = this.admission.then(async () => {
      const identity = JSON.stringify([input.text, input.images, input.replacementIds])
      const key = `input:${operationId}`
      const previous = await this.ctx.storage.get<string>(key)
      if (previous !== undefined && previous !== identity) throw new Error('content conflict')
      if (input.text === 'reject') throw new Error('fixture explicit rejection')
      await this.ctx.storage.put(key, identity)
      return this.harness.submit(input.text, { operationId })
    })
    this.admission = result.catch(() => undefined)
    return result
  }
  async onRequest(request: Request) {
    const url = new URL(request.url)
    const operationId = url.searchParams.get('id') ?? 'operation'
    try {
      if (url.pathname === '/submit') return Response.json(await this.submit(operationId, await request.json<Input>()))
      if (url.pathname === '/native-submit') return Response.json(await this.harness.submit(await request.text(), { operationId }))
      if (url.pathname === '/release') { await this.ctx.storage.put('release', true); return Response.json({ released: true }) }
      if (url.pathname === '/abort') return Response.json({ aborted: await this.harness.abort({ operationId }) })
      if (url.pathname === '/wait') return Response.json(await this.harness.wait(operationId))
      if (url.pathname === '/lookup') {
        await this.harness.pi()
        return Response.json(await this.nativeStorage!.submissionByRequest(ROOT_CONVERSATION_ID, operationId, this.nativeContext!) ?? null)
      }
      if (url.pathname === '/evidence') return Response.json({
        native: await this.harness.messages(), pending: await this.harness.pending(),
        modelStarted: await this.ctx.storage.get('modelStarted'), toolStarted: await this.ctx.storage.get('toolStarted'),
        modelCalls: await this.ctx.storage.get('modelCalls') ?? 0,
        safeInvocations: await this.ctx.storage.get('safeInvocations') ?? 0,
        unsafeInvocations: await this.ctx.storage.get('unsafeInvocations') ?? 0,
        effects: await this.ctx.storage.get('effects') ?? 0,
      })
      return Response.json({ ready: true })
    } catch (error) { return Response.json({ error: String(error), stack: error instanceof Error ? error.stack : '' }, { status: 409 }) }
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const name = new URL(request.url).searchParams.get('name') ?? 'isolated-fixture'
    return env.NativeGate.getByName(name).fetch(request)
  },
} satisfies ExportedHandler<Env>

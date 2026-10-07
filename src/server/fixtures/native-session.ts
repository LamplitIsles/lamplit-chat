import type { PiSession } from '../pi-session'
import type { Conversation, Harness } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import type { PiHarness } from 'agents/harness/pi'
import { nativeProviders } from '../model-catalog'
export type NativeFixture = { getLane(): Promise<Conversation>; getHarness(): Promise<Harness>; native: PiHarness; nativeContext: Parameters<Harness['close']>[0] }
export async function runNative(instance: unknown, text: string) {
  const input = { operationId: crypto.randomUUID(), text }
  const receipt = await (instance as PiSession).submitChat(input)
  if (receipt.state === 'failed') throw new Error(receipt.error ?? 'Fixture submission refused')
  return (instance as NativeFixture).native.wait(input.operationId)
}
export async function selectedNativeModel(lane: Conversation, context: Parameters<Harness['close']>[0]) {
  const reference=(await lane.agent(context)).model
  return nativeProviders().find(provider=>provider.id===reference?.provider)?.getModels().find(model=>model.id===reference?.modelId)
}
export async function appendNative(lane: Conversation, message: Message, context: Parameters<Harness['close']>[0]) {
 return lane.commit(async tx=>(await tx.appendEntry(lane.id,{kind:message.role==='user'?'pi.user':message.role==='assistant'?'pi.assistant':'pi.toolResult',model:[message]})).id,context)
}

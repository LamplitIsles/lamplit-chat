// Test-owned public native media/history setup around the production host.
import native, { PiSession as NativeFixture, state } from './native-submissions'
export { PiRegistry } from './native-submissions'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { imageRef } from '../../src/server/chat-images'
const jpeg = btoa(String.fromCharCode(255, 216, 255, 217))
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
export class PiSession extends NativeFixture {
  uploadFailure = false
  bucket
  async uploadPhoto(input) {
    if (this.uploadFailure) throw new Error('Test-owned R2 intake failure')
    return super.uploadPhoto(input)
  }
  async appendFixture(message) {
    const lane = await this.getLane()
    return lane.commit(async tx => (await tx.appendEntry(lane.id, { kind: message.role === 'user' ? 'pi.user' : 'pi.assistant', model: [message] })).id, this.nativeContext)
  }
  async control(input) {
    state.reply = () => state.executions === 1 ? '完整图片回复' : '追加图片回复'
    if (input.action === 'uploadFailure') this.uploadFailure = input.enabled
    if (input.action === 'disabled') { this.bucket ??= this.env.COMPUTER_R2; this.env.COMPUTER_R2 = input.enabled ? undefined : this.bucket }
    if (input.action === 'history') for (let i = 0; i < 32; i++) await this.appendFixture(fauxAssistantMessage(`历史回复 ${i}`))
    if (input.action === 'nativeRecovery') {
      const operationId = crypto.randomUUID(), id = crypto.randomUUID()
      const photo = await this.uploadPhoto({ id, operationId, order: 0, name: 'native.png', mediaType: 'image/png', original: png, preview: jpeg, model: jpeg })
      const holder = crypto.randomUUID()
      await this.native.submit('Test-owned recovery holder', { operationId: holder })
      this.ctx.waitUntil(this.native.wait(holder))
      await this.waitForFixtureGeneration()
      await super.submitChat({ operationId, text: '原生恢复输入', images: [imageRef(photo)] })
      state.browserIds.delete(operationId)
      await this.native.abort({ operationId })
    }
    if (input.action === 'missing') for (const recovery of await this.chatRecovery()) for (const image of recovery.images) await this.env.COMPUTER_R2.delete(this.photoKey(image.attachmentId, 'original'))
    const result = await super.control(input)
    if (input.action === 'complete') {
      const operationId = crypto.randomUUID(), id = crypto.randomUUID()
      await this.uploadPhoto({ id, operationId, order: 0, name: 'generated.png', mediaType: 'image/png', original: png, preview: jpeg, model: jpeg })
      const entry = await this.appendFixture(fauxAssistantMessage('生成的图片'))
      this.sessionStorage.freezePhotos(operationId, [id])
      this.sessionStorage.correlateInput(operationId, this.sessionStorage.sourceId(entry))
      await this.getBranch()
      return super.control({ action: 'state' })
    }
    return result
  }
}
export default native

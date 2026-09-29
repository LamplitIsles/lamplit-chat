export { PiRegistry } from './server/pi-registry'
export { PiSession } from './server/pi-session'
import { handleConversationPhotos } from './server'

export default {
  async fetch(request: Request, env: Env) {
    return await handleConversationPhotos(request, env) ?? new Response('Not found', { status: 404 })
  },
}

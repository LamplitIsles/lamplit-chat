export { PiRegistry } from './server/pi-registry'
export { PiSession } from './server/pi-session'
import server, { handleConversationPhotos } from './server'

export default {
  async fetch(request: Request, env: Env) {
    if (/^\/api\/companion-materials|^\/api\/web-search|^\/api\/history-|^\/api\/agents\//.test(new URL(request.url).pathname)) return server.fetch(request, env)
    return await handleConversationPhotos(request, env) ?? new Response('Not found', { status: 404 })
  },
}

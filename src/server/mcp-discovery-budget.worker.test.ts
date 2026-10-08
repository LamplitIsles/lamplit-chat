import { expect, it, vi } from 'vitest'
import { createInjectedMcpTools } from './injected-remote-mcp'
import { fakeMcp } from './fixtures/remote-mcp'

const config = JSON.stringify({ singleton: [{ name: 'fixture', url: 'https://budget.fixture.invalid/mcp' }] })

it.each([false, true])('allows the captured handshake plus a bounded list reply (stalled: %s)', async stalled => {
  const peer = fakeMcp(), methods: string[] = []
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let aborted = 0, settled = false
  vi.useFakeTimers()
  try {
    const pending = createInjectedMcpTools(config, null, async (url, init) => {
      if (init?.method === 'DELETE') return peer.fetch(url, init)
      const rpc = JSON.parse(init!.body as string)
      methods.push(rpc.method)
      const delay = rpc.method === 'initialize' ? 2165 : rpc.method === 'notifications/initialized' ? 766 : rpc.method === 'tools/list' ? stalled ? 20000 : 3000 : 0
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); if (rpc.method === 'tools/list') aborted++; reject(new DOMException('Aborted', 'AbortError')) }
        const timer = setTimeout(() => { init?.signal?.removeEventListener('abort', abort); resolve() }, delay)
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
      return peer.fetch(url, init)
    }).then(result => { settled = true; return result })
    await vi.waitFor(() => expect(methods).toContain('initialize'))
    await vi.advanceTimersByTimeAsync(6000)
    if (stalled) {
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(9001)
    }
    const discovery = await pending
    expect(discovery.tools).toHaveLength(stalled ? 0 : 1)
    expect(methods.filter(method => method === 'initialize')).toHaveLength(1)
    expect(methods.filter(method => method === 'tools/list')).toHaveLength(1)
    expect(methods).not.toContain('tools/call')
    expect(peer.requests.filter(request => request.method === 'DELETE')).toHaveLength(1)
    expect(aborted).toBe(stalled ? 1 : 0)
    if (!stalled) expect(discovery.retry).toBeUndefined()
  } finally { vi.useRealTimers(); log.mockRestore() }
})

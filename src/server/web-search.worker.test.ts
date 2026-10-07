import { runInDurableObject } from 'cloudflare:test'
import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'
import { runNative, type NativeFixture } from './fixtures/native-session'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../server'
import { executeSearch, searchSettings, createWebTools, type SearchEnvironment } from './web-tools'
import { fetchPage, fetchLinks, PAGE_MAX_BYTES, PAGE_MAX_CHARACTERS, PAGE_MAX_TITLE_CHARACTERS } from './web-fetch'
import { search } from './web-search-providers'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'

const owners = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
function toolValue(value: Awaited<ReturnType<ReturnType<typeof createWebTools>[number]['execute']>>) {
  const text = value.content!.find(item => item.type === 'text')
  if (!text || text.type !== 'text') throw new Error('Expected text tool result')
  return JSON.parse(text.text)
}
const resolver = async () => ['93.184.216.34']
const markdown = (text: string) => new Response(text, { headers: { 'content-type': 'text/markdown' } })
const article = '<!doctype html><html><head><title>Fixture article</title></head><body><nav>Navigation junk</nav><article><h1>Fixture article</h1>' + Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i}: The lighthouse keeper studied the sea and recorded the weather each evening. These observations help sailors choose a safe route across the islands. <a href="../source">Read source</a>.</p>`).join('') + '</article><footer>Footer junk</footer></body></html>'
afterEach(() => vi.restoreAllMocks())

describe('web tools in the Worker executor', () => {
  it('actual PiSession harness advertises current tools and executes model tool calls in Worker runtime', async () => {
    const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
    const created = await registry.createSession({ name: 'Test-owned web tool path' })
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    const requests: Array<{ tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> }> = []
    let modelCalls = 0
    let providerCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      new Request(url, init) // Retain the actual workerd Request boundary in network fixtures.
      const address = url instanceof Request ? url.url : url.toString()
      if (address.includes('exa.ai')) { providerCalls++; return Response.json({ results: [{ title: 'Fixture lighthouse', url: 'https://public.example/source', highlights: ['Fixture excerpt'] }] }) }
      if (address.includes('93.184.216.34')) return markdown('# Fixture public page')
      expect(address).toBe('https://openrouter.ai/api/v1/chat/completions')
      requests.push(JSON.parse(init?.body as string))
      modelCalls++
      const delta = modelCalls === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'search-call', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'lighthouse' }) } }] }
        : modelCalls === 3 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fetch-call', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://93.184.216.34/article' }) } }] }
        : { role: 'assistant', content: 'Fixture response' }
      return new Response([
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: modelCalls === 1 || modelCalls === 3 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    await runInDurableObject(stub, async instance => {
      const localEnv = { ...env, WEB_SEARCH_PROVIDER: 'exa', WEB_SEARCH_API_KEY: 'fixture-search-key' }
      Reflect.set(instance, 'env', localEnv)
      vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
      await (instance as unknown as NativeFixture).native.dispose()
      const native = instance as unknown as NativeFixture
      const getHarness = () => native.getHarness()
      const harness = await getHarness()
      await runNative(instance, 'Search fictional lighthouses')
      expect(requests[0].tools.map(tool => tool.function.name)).toContain('web_search')
      expect(JSON.stringify(requests[1].messages.filter(message => message.role === 'tool'))).toContain('Fixture excerpt')
      localEnv.WEB_SEARCH_API_KEY = ''
      expect(await getHarness()).toBe(harness)
      await runNative(instance, 'Read the fictional public page')
      expect(requests[2].tools.map(tool => tool.function.name)).not.toContain('web_search')
      expect(requests[2].tools.map(tool => tool.function.name)).toContain('web_fetch')
      expect(requests[2].tools.map(tool => tool.function.name)).toContain('web_links')
      expect(JSON.stringify(requests[3].messages.filter(message => message.role === 'tool'))).toContain('Fixture public page')
    })
    expect(providerCalls).toBe(1)
    expect(modelCalls).toBe(4)
  })

  it('selects all three providers, normalizes citations, and accepts zero results', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      new Request(url, init) // Retain the actual workerd Request boundary in network fixtures.
      const address = (url instanceof Request ? url.url : url.toString())
      expect(init?.redirect).toBe('manual')
      if (address.includes('exa.ai')) { expect(new Headers(init?.headers).get('x-api-key')).toBe('exa-only'); return Response.json({ results: [{ title: 'Exa article', url: 'https://public.example/a', highlights: ['Excerpt'] }] }) }
      if (address.includes('brave.com')) { expect(new Headers(init?.headers).get('X-Subscription-Token')).toBe('brave-only'); return Response.json({ web: { results: [] } }) }
      expect(new Headers(init?.headers).get('x-api-key')).toBe('deepseek-only')
      expect(JSON.parse(init?.body as string).tools[0].type).toBe('web_search_20250305')
      return Response.json({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Deep article', url: 'https://public.example/d' }] }, { type: 'text', citations: [{ url: 'https://public.example/d', cited_text: 'Citation excerpt' }] }] })
    })
    for (const provider of ['exa', 'brave', 'deepseek'] as const) {
      const result = await executeSearch({ WEB_SEARCH_PROVIDER: provider, WEB_SEARCH_API_KEY: `${provider}-only` }, null, 'lighthouses')
      expect(result.provider).toBe({ exa: 'Exa', brave: 'Brave', deepseek: 'DeepSeek' }[provider])
      if (provider === 'brave') expect(result.results).toEqual([])
      else expect(result.results[0]).toMatchObject({ position: 1, snippet: provider === 'exa' ? 'Excerpt' : 'Citation excerpt' })
    }
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('re-reads hosted config for old tools, switches keys, disables, isolates owners and uses the same test executor', async () => {
    let current = { enabled: true, provider: 'exa', apiKey: 'first-key' }
    const platformFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      new Request(url, init)
      expect(new Headers(init?.headers).get('x-lamplit-internal-secret')).toBe('fixture-secret')
      return Response.json((url instanceof Request ? url.url : url.toString()).endsWith(owners[0]) ? current : { enabled: false })
    })
    const settings: SearchEnvironment = { HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-secret', PLATFORM: { fetch: platformFetch }, WEB_SEARCH_PROVIDER: 'deepseek', WEB_SEARCH_API_KEY: 'must-not-fallback' }
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((url instanceof Request ? url.url : url.toString()).includes('exa.ai')) { expect(new Headers(init?.headers).get('x-api-key')).toBe(current.apiKey); return Response.json({ results: [] }) }
      expect(new Headers(init?.headers).get('X-Subscription-Token')).toBe('changed-key')
      return Response.json({ web: { results: [] } })
    })
    const tool = createWebTools(settings, owners[0])[0]
    const call = () => tool.execute({ query: 'sea' }, { callId: 'fixture-call' } as never, BACKGROUND_CONTEXT)
    expect(toolValue(await call())).toEqual({ provider: 'Exa', results: [] })
    current = { enabled: true, provider: 'exa', apiKey: 'replacement-key' }
    await call()
    current = { enabled: true, provider: 'brave', apiKey: 'changed-key' }
    expect(toolValue(await call()).provider).toBe('Brave')
    const workerEnv = new Proxy(env, { get: (target, key) => key in settings ? Reflect.get(settings, key) : Reflect.get(target, key) }) as Env
    const request = (instance = owners[0], secret = 'fixture-secret', origin = 'https://chat.example') => new Request('https://chat.example/api/web-search/test', { method: 'POST', headers: { 'x-lamplit-instance': instance, 'x-lamplit-internal-secret': secret, origin }, body: JSON.stringify({ query: 'sea' }) })
    const response = await worker.fetch(request(), workerEnv)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ provider: 'Brave', results: [] })
    expect((await worker.fetch(request(owners[0], 'wrong'), workerEnv)).status).toBe(403)
    expect((await worker.fetch(request(owners[0], 'fixture-secret', 'https://evil.example'), workerEnv)).status).toBe(403)
    expect((await worker.fetch(request('malformed'), workerEnv)).status).toBe(403)
    expect((await worker.fetch(request(owners[1]), workerEnv)).status).toBe(502)
    current.enabled = false
    expect(toolValue(await call()).code).toBe('search_disabled')
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(await searchSettings(settings, owners[1])).toEqual({ enabled: false })
  })

  it('rejects binding/provider redirects at real Request boundaries and protects selfhost test requests', async () => {
    const platform = { fetch: async (url: RequestInfo | URL, init?: RequestInit) => { new Request(url, init); return new Response(null, { status: 302, headers: { location: 'https://evil.example' } }) } }
    await expect(searchSettings({ HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture', PLATFORM: platform }, owners[0])).rejects.toThrow('unavailable')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { new Request(url, init); return new Response(null, { status: 302, headers: { location: 'https://evil.example' } }) })
    for (const provider of ['exa', 'brave', 'deepseek'] as const) await expect(executeSearch({ WEB_SEARCH_PROVIDER: provider, WEB_SEARCH_API_KEY: 'fixture' }, null, 'fixture')).rejects.toThrow('HTTP 302')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect((await worker.fetch(new Request('https://chat.example/api/web-search/test', { method: 'POST', body: '{"query":"fixture"}' }), env)).status).toBe(401)
    const headers = { authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` }
    expect((await worker.fetch(new Request('https://chat.example/api/web-search/test', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{"query":"fixture"}' }), env)).status).toBe(403)
    expect((await worker.fetch(new Request('https://chat.example/api/web-search/test', { method: 'POST', headers, body: '{' }), env)).status).toBe(400)
  })

  it('bounds failures without leaking upstream keys, handles malformed/config failures, cancellation and timeout', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('SECRET-provider-debug', { status: 401 }))
    const tool = createWebTools({ WEB_SEARCH_PROVIDER: 'exa', WEB_SEARCH_API_KEY: 'SECRET-key' }, null)[0]
    const result = await tool.execute({ query: 'sea' }, { callId: 'call' } as never, BACKGROUND_CONTEXT)
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(toolValue(result).code).toBe('upstream_error')
    fetcher.mockResolvedValue(Response.json({ content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error' } }] }))
    await expect(executeSearch({ WEB_SEARCH_PROVIDER: 'deepseek', WEB_SEARCH_API_KEY: 'fixture' }, null, 'sea')).rejects.toThrow('tool failed')
    fetcher.mockResolvedValue(new Response('{'))
    await expect(executeSearch({ WEB_SEARCH_PROVIDER: 'exa', WEB_SEARCH_API_KEY: 'fixture' }, null, 'sea')).rejects.toThrow('invalid JSON')
    await expect(executeSearch({}, null, ' ')).rejects.toThrow('Query')
    const controller = new AbortController(); controller.abort()
    await expect(search({ provider: 'exa', query: 'sea', credentials: { exaApiKey: 'fixture' }, signal: controller.signal })).rejects.toThrow('Operation aborted')
    fetcher.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    await expect(search({ provider: 'exa', query: 'sea', credentials: { exaApiKey: 'fixture' }, timeoutMs: 5 })).rejects.toThrow('timed out')
    await expect(searchSettings({ HOSTED_MODE: 'true' }, owners[0])).rejects.toThrow('unavailable')
  })
})

describe('public page reading in actual Worker runtime', () => {
  it('extracts article Markdown with Defuddle, resolves links, and measures representative input', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('omit')
      expect(new Headers(init?.headers).get('accept')).toContain('text/markdown')
      expect(new Headers(init?.headers).has('cookie')).toBe(false)
      return new Response(article, { headers: { 'content-type': 'text/html' } })
    })
    const result = await fetchPage('https://public.example/posts/story', undefined, { fetch: fetcher, resolve: resolver })
    expect(result.title).toBe('Fixture article')
    expect(result.content).toContain('lighthouse keeper')
    expect(result.content).toContain('[Read source](https://public.example/source)')
    expect(result.content).not.toContain('<p>')
    expect(result.content).not.toContain('Navigation junk')
    expect(result.truncated).toBe(false)
    console.log('Defuddle Worker fixture measurement', { inputBytes: result.inputBytes, parseTimeMs: result.parseTimeMs, outputCharacters: result.content.length })
  })
  it('bounds a huge HTML title and reports its clipping as truncation', async () => {
    const html = article.replaceAll('Fixture article', 'T'.repeat(100000))
    const result = await fetchPage('https://public.example/title', undefined, { resolve: resolver, fetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) })
    expect(result.title).toBe('T'.repeat(PAGE_MAX_TITLE_CHARACTERS))
    expect(result.truncated).toBe(true)
    expect(result.content).toContain('lighthouse keeper')
    expect(JSON.stringify(result).length).toBeLessThan(PAGE_MAX_CHARACTERS + 1000)
  })

  it('reads Markdown, follows bounded redirects, truncates input/output and rejects failures/empty/interstitial bodies', async () => {
    let requests = 0
    const redirected = await fetchPage('https://public.example/start', undefined, { resolve: resolver, fetch: async () => ++requests === 1 ? new Response(null, { status: 302, headers: { location: '/article' } }) : markdown('# Direct Markdown') })
    expect(redirected.url).toBe('https://public.example/article')
    expect(redirected.content).toBe('# Direct Markdown')
    const large = await fetchPage('https://public.example/large', undefined, { resolve: resolver, fetch: async () => markdown('a'.repeat(PAGE_MAX_BYTES + 500)) })
    expect(large.truncated).toBe(true)
    expect(large.content.length).toBe(PAGE_MAX_CHARACTERS)
    for (const response of [new Response('oops', { status: 503 }), markdown(''), new Response('pdf', { headers: { 'content-type': 'application/pdf' } }), new Response('<html><head><title>Access Denied</title></head><body>Blocked</body></html>', { headers: { 'content-type': 'text/html' } })]) {
      await expect(fetchPage('https://public.example/failure', undefined, { resolve: resolver, fetch: async () => response })).rejects.toThrow()
    }
  })
  it('rejects an HTTP 200 Page not found error page as unavailable body', async () => {
    const html = '<html><head><title>Page not found</title></head><body><main><h1>Page not found</h1><p>Sorry, the page you are looking for could not be found. It might have been removed, had its name changed, or is temporarily unavailable. Please check the address or return to the home page.</p></main></body></html>'
    await expect(fetchPage('https://public.example/missing', undefined, {
      resolve: resolver,
      fetch: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    })).rejects.toMatchObject({ code: 'body_unavailable', message: 'Readable webpage body unavailable' })
  })

  it('cancels in-flight reads, times out DNS/body waits and protects the final URL from remote header injection', async () => {
    const controller = new AbortController()
    const started = fetchPage('https://public.example/', controller.signal, { resolve: resolver, fetch: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) })
    await new Promise(resolve => setTimeout(resolve, 1)); controller.abort()
    await expect(started).rejects.toThrow('Operation aborted')
    await expect(fetchPage('https://public.example/', undefined, { timeoutMs: 5, resolve: async () => new Promise(() => {}), fetch: async () => markdown('unexpected') })).rejects.toThrow('timed out')
    await expect(fetchPage('https://public.example/', undefined, { timeoutMs: 5, resolve: resolver, fetch: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('partial')) } }), { headers: { 'content-type': 'text/plain' } }) })).rejects.toThrow('timed out')
    const final = await fetchPage('https://public.example/', undefined, { resolve: resolver, fetch: async () => new Response('safe', { headers: { 'content-type': 'text/plain', 'x-lamplit-final-url': 'http://127.0.0.1/injected' } }) })
    expect(final.url).toBe('https://public.example/')
  })

  it('rejects credentials/private IPv4 and IPv6, private DNS answers and redirects before fetching', async () => {
    const fetcher = vi.fn(async () => markdown('unexpected'))
    for (const url of ['file:///etc/passwd', 'http://user:pass@public.example/', 'http://localhost/', 'http://127.1/', 'http://2130706433/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://192.168.1.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/']) {
      await expect(fetchPage(url, undefined, { fetch: fetcher, resolve: resolver })).rejects.toThrow('public')
    }
    await expect(fetchPage('https://public.example/', undefined, { fetch: fetcher, resolve: async () => ['93.184.216.34', '10.0.0.1'] })).rejects.toThrow('public')
    expect(fetcher).not.toHaveBeenCalled()
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
    await expect(fetchPage('https://public.example/', undefined, { fetch: redirect, resolve: resolver })).rejects.toThrow('public')
    expect(redirect).toHaveBeenCalledTimes(1)
    await expect(fetchPage('https://public.example/', undefined, { resolve: resolver, fetch: async () => new Response(null, { status: 302, headers: { location: '/' } }) })).rejects.toThrow('redirect limit')
  })
})


describe('web_links in Worker runtime', () => {
  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } })
  it('lists original DOM anchors in order, resolves bases, deduplicates and bounds output', async () => {
    const body = '<base href="/docs/"><nav><a href="one"> First  link </a></nav><a href="one">Duplicate</a><a href="two" aria-label="Second"></a><a href="mailto:test@example.com">mail</a><a href="javascript:alert(1)">script</a><a href="https://user:pass@public.example/">secret</a><a href="three">' + 'x'.repeat(600) + '</a>'
    const options = { resolve: resolver, fetch: async () => html(body) }
    const result = await fetchLinks('https://public.example/page', 2, undefined, options)
    expect(result).toEqual({ url: 'https://public.example/page', links: [{ text: 'First link', url: 'https://public.example/docs/one' }, { text: 'Second', url: 'https://public.example/docs/two' }], truncated: true })
    const all = await fetchLinks('https://public.example/page', 100, undefined, options)
    expect(all.links).toHaveLength(3)
    expect(all.links[2].text).toHaveLength(500)
    expect(all.truncated).toBe(false)
    expect(await fetchLinks('https://public.example/', 100, undefined, { ...options, fetch: async () => html('<p>No links</p>') })).toEqual({ url: 'https://public.example/', links: [], truncated: false })
    const large = await fetchLinks('https://public.example/', 100, undefined, { ...options, fetch: async () => html('x'.repeat(PAGE_MAX_BYTES + 20)) })
    expect(large.truncated).toBe(true)
  })
  it('shares private-address rejection, redirect validation, cancellation and timeout', async () => {
    const fetcher = vi.fn(async () => html('unexpected'))
    await expect(fetchLinks('http://127.0.0.1/', 100, undefined, { fetch: fetcher })).rejects.toMatchObject({ code: 'invalid_url' })
    await expect(fetchLinks('https://public.example/', 100, undefined, { resolve: async () => ['10.0.0.1'], fetch: fetcher })).rejects.toMatchObject({ code: 'invalid_url' })
    expect(fetcher).not.toHaveBeenCalled()
    await expect(fetchLinks('https://public.example/', 100, undefined, { resolve: resolver, fetch: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }) })).rejects.toMatchObject({ code: 'invalid_url' })
    await expect(fetchLinks('https://public.example/', 0, undefined, { fetch: fetcher })).rejects.toMatchObject({ code: 'invalid_limit' })
    await expect(fetchLinks('https://public.example/', 100, undefined, { resolve: resolver, fetch: async () => markdown('plain') })).rejects.toMatchObject({ code: 'unsupported_content' })
    const controller = new AbortController(); controller.abort()
    await expect(fetchLinks('https://public.example/', 100, controller.signal, { fetch: fetcher })).rejects.toThrow('aborted')
    await expect(fetchLinks('https://public.example/', 100, undefined, { timeoutMs: 5, resolve: async () => new Promise(() => {}) })).rejects.toThrow('timed out')
  })
  it('executes with search disabled in both hosting modes without reading platform settings', async () => {
    const platform = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      new Request(url, init)
      expect(init?.credentials).toBe('omit')
      expect(new Headers(init?.headers).has('cookie')).toBe(false)
      return html('<a href="/next">Next</a>')
    })
    for (const settings of [{}, { HOSTED_MODE: 'true', PLATFORM: { fetch: platform } }]) {
      const tool = createWebTools(settings, null).find(tool => tool.name === 'web_links')!
      expect(toolValue(await tool.execute({ url: 'https://93.184.216.34/' }, { callId: 'links' } as never, BACKGROUND_CONTEXT))).toEqual({ url: 'https://93.184.216.34/', links: [{ text: 'Next', url: 'https://93.184.216.34/next' }], truncated: false })
    }
    expect(platform).not.toHaveBeenCalled()
  })
})

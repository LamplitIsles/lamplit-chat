import { resolve4, resolve6 } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import { parseHTML } from 'linkedom'
import Defuddle from 'defuddle'
import TurndownService from 'turndown'
import { boundedRequest, readResponseBytes } from './web-request'
import { WebError } from './web-errors'

export const PAGE_MAX_BYTES = 512 * 1024
export const PAGE_MAX_CHARACTERS = 24000
export const PAGE_MAX_TITLE_CHARACTERS = 500
const blocked = () => new WebError('invalid_url', 'Only public HTTP(S) webpage addresses are allowed')
function publicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast' } catch { return false }
}
export type PageNetwork = { fetch?: typeof fetch; resolve?: (hostname: string) => Promise<string[]>; timeoutMs?: number }
async function resolvePublic(hostname: string): Promise<string[]> {
  const records = await Promise.all([resolve4(hostname), resolve6(hostname)].map(async query => {
    try { return await query } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENODATA' || error.code === 'ENOTFOUND')) return []
      throw blocked()
    }
  }))
  return records.flat()
}
async function publicURL(value: string, signal: AbortSignal, resolve: NonNullable<PageNetwork['resolve']>) {
  let url: URL
  try { url = new URL(value) } catch { throw blocked() }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (value.length > 4000 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port) || !hostname.includes('.') && !hostname.includes(':') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname)) throw blocked()
  if (ipaddr.isValid(hostname)) { if (!publicAddress(hostname)) throw blocked() }
  else {
    // DNS is independently checked before every request/redirect. fetch does not expose IP pinning.
    const addresses = await new Promise<string[]>((fulfill, reject) => {
      const abort = () => reject(signal.reason)
      signal.throwIfAborted()
      signal.addEventListener('abort', abort, { once: true })
      resolve(hostname).then(fulfill, reject).finally(() => signal.removeEventListener('abort', abort))
    })
    if (!addresses.length || addresses.some(address => !publicAddress(address))) throw blocked()
  }
  signal.throwIfAborted()
  url.hash = ''
  return url
}
async function readPage<T>(value: string, signal: AbortSignal | undefined, network: PageNetwork, consume: (page: { text: string; url: string; mediaType: string; inputTruncated: boolean; inputBytes: number }, signal: AbortSignal) => T) {
  const resolve = network.resolve ?? resolvePublic
  const fetcher = network.fetch ?? fetch
  return boundedRequest(async (_url, init) => {
    const requestSignal = init?.signal
    if (!requestSignal) throw blocked()
    let url = await publicURL(value, requestSignal, resolve)
    for (let redirects = 0; ; redirects++) {
      const response = await fetcher(url, { ...init, redirect: 'manual', credentials: 'omit', headers: { accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || redirects >= 3) throw new WebError('redirect_limit', 'Webpage redirect limit reached')
        url = await publicURL(new URL(location, url).href, requestSignal, resolve)
        continue
      }
      // Fixture responses lack response.url; preserve the independently validated final URL.
      const headers = new Headers(response.headers)
      headers.set('x-lamplit-final-url', url.href)
      return new Response(response.body, { status: response.status, headers })
    }
  }, value, {}, { callerSignal: signal, timeoutMs: network.timeoutMs ?? 15000, timeoutMessage: 'Webpage timed out' }, async (response, requestSignal) => {
    if (!response.ok) { await response.body?.cancel(); throw new WebError('http_error', `Webpage returned HTTP ${response.status}`) }
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (!mediaType || !['text/html', 'application/xhtml+xml', 'text/markdown', 'text/plain'].includes(mediaType)) {
      await response.body?.cancel()
      throw new WebError('unsupported_content', 'Webpage must return HTML, Markdown or plain text')
    }
    const bytes = await readResponseBytes(response, PAGE_MAX_BYTES + 1, requestSignal, { truncate: true })
    const inputTruncated = bytes.byteLength > PAGE_MAX_BYTES
    const text = new TextDecoder().decode(bytes.subarray(0, PAGE_MAX_BYTES))
    const url = response.headers.get('x-lamplit-final-url')!
    return consume({ text, url, mediaType, inputTruncated, inputBytes: Math.min(bytes.byteLength, PAGE_MAX_BYTES) }, requestSignal)
  })
}
export async function fetchPage(value: string, signal?: AbortSignal, network: PageNetwork = {}) {
  return readPage(value, signal, network, ({ text, url, mediaType, inputTruncated, inputBytes }, requestSignal) => {
    let content = text
    let title = ''
    let parseTimeMs = 0
    if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
      const { document } = parseHTML(text)
      // linkedom has no layout engine. Disable layout-dependent passes; no global DOM shims.
      Object.defineProperty(document, 'styleSheets', { value: [] })
      Object.defineProperty(document, 'URL', { value: url })
      for (const element of document.querySelectorAll('[href], [src]')) {
        for (const attribute of ['href', 'src']) {
          const relative = element.getAttribute(attribute)
          if (relative) {
            try {
              const absolute = new URL(relative, url)
              if (['http:', 'https:'].includes(absolute.protocol)) element.setAttribute(attribute, absolute.href)
              else element.removeAttribute(attribute)
            } catch { element.removeAttribute(attribute) }
          }
        }
      }
      const start = performance.now()
      const article = new Defuddle(document, { url, useAsync: false, profile: true, removeHiddenElements: false, removeSmallImages: false }).parse()
      if (!article.extractorType && (!article.profile || !('resolveRelativeUrls' in article.profile))) throw new WebError('body_unavailable', 'Readable webpage body unavailable')
      parseTimeMs = performance.now() - start
      title = article.title
      const extracted = document.createElement('div')
      extracted.innerHTML = article.content
      content = new TurndownService({ headingStyle: 'atx' }).turndown(extracted)
      // Empty extraction and common access-denied/interstitial pages are failures, not articles.
      if (!content.trim() || /^(?:access denied|just a moment|attention required|captcha|sign in|log in|403 forbidden|404 not found|page not found|500 internal server error|service unavailable)$/i.test(title.trim())) throw new WebError('body_unavailable', 'Readable webpage body unavailable')
    }
    requestSignal.throwIfAborted()
    if (!content.trim()) throw new WebError('body_unavailable', 'Readable webpage body unavailable')
    return { url, title: title.slice(0, PAGE_MAX_TITLE_CHARACTERS), content: content.slice(0, PAGE_MAX_CHARACTERS), truncated: inputTruncated || content.length > PAGE_MAX_CHARACTERS || title.length > PAGE_MAX_TITLE_CHARACTERS, inputBytes, parseTimeMs }
  })
}

// Anchor extraction follows guionai/web (Apache-2.0); transport is shared with web_fetch.
export async function fetchLinks(value: string, limit = 100, signal?: AbortSignal, network: PageNetwork = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new WebError('invalid_limit', 'Link limit must be an integer from 1 through 100')
  return readPage(value, signal, network, ({ text, url, mediaType, inputTruncated }, requestSignal) => {
    if (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') throw new WebError('unsupported_content', 'Listing links requires an HTML page')
    const { document } = parseHTML(text)
    let base = url
    try { base = new URL(document.querySelector('base[href]')?.getAttribute('href') || url, url).href } catch { /* Use the final page URL for malformed bases. */ }
    const links: Array<{ text: string; url: string }> = []
    const seen = new Set<string>()
    let truncated = inputTruncated
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href')?.trim()
      if (!href) continue
      let destination: URL
      try { destination = new URL(href, base) } catch { continue }
      if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password || destination.href.length > 4000 || seen.has(destination.href)) continue
      seen.add(destination.href)
      if (links.length >= limit) { truncated = true; break }
      const label = anchor.textContent?.trim() || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || ''
      links.push({ text: label.replace(/\s+/g, ' ').trim().slice(0, 500), url: destination.href })
    }
    requestSignal.throwIfAborted()
    return { url, links, truncated }
  })
}

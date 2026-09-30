// UI labels only. These names are never read by the agent or prompt builder.
export interface DisplayNames { companionName: string; userName: string }

export async function handleDisplayNames(request: Request, bucket: R2Bucket | undefined, instanceId: string | null): Promise<Response> {
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'private, no-store' } })
  const key = `${instanceId ? `instances/${instanceId}/` : ''}display-names.json`
  if (request.method === 'GET') {
    const object = await bucket?.get(key)
    return json(object ? await object.json<DisplayNames>() : { companionName: '', userName: '' })
  }
  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405)
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Forbidden' }, 403)
  if (!bucket) return json({ error: 'Settings storage is unavailable' }, 503)
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON' }, 415)
  const reader = request.body?.getReader()
  if (!reader) return json({ error: 'Expected names' }, 400)
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 2048) { await reader.cancel(); return json({ error: 'Names payload is too large' }, 413) }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { return json({ error: 'Invalid JSON' }, 400) }
  if (!value || typeof value !== 'object' || !('companionName' in value) || !('userName' in value)) return json({ error: 'Expected both names' }, 400)
  if (typeof value.companionName !== 'string' || typeof value.userName !== 'string') return json({ error: 'Names must be text' }, 400)
  const names = { companionName: value.companionName.trim(), userName: value.userName.trim() }
  if (Object.values(names).some((name) => Array.from(name).length > 32 || /[\p{Cc}]/u.test(name))) return json({ error: 'Names must have at most 32 characters and no control characters' }, 400)
  await bucket.put(key, JSON.stringify(names), { httpMetadata: { contentType: 'application/json' } })
  return json(names)
}

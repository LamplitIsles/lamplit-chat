const cookieName = 'lamplit_session'

async function token(password: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`lamplit-session-v1:${password}`))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

export async function authorize(request: Request, password: string | undefined): Promise<{ authorized: boolean; setCookie?: string }> {
  if (!password || password.length < 24) return { authorized: false }
  const expected = await token(password)
  const cookie = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  if (cookie && equal(cookie, expected)) return { authorized: true }
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Basic ')) return { authorized: false }
  let supplied: string
  try { supplied = atob(header.slice(6)).split(':').slice(1).join(':') }
  catch { return { authorized: false } }
  if (!equal(supplied, password)) return { authorized: false }
  return { authorized: true, setCookie: `${cookieName}=${expected}; HttpOnly; Secure; SameSite=Strict; Path=/` }
}

export function unauthorized(): Response {
  return new Response('Authentication required', { status: 401, headers: { 'www-authenticate': 'Basic realm="Lamplit"', 'cache-control': 'no-store' } })
}

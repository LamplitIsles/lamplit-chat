import { isOperationAborted, isRequestTimeout } from './web-request'
export class WebError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
export function webFailure(error: unknown) {
  if (error instanceof WebError) return { error: error.message, code: error.code }
  if (isOperationAborted(error)) return { error: 'Web operation cancelled', code: 'cancelled' }
  if (isRequestTimeout(error)) return { error: 'Web operation timed out', code: 'timeout' }
  return { error: 'Web operation failed', code: 'upstream_error' }
}

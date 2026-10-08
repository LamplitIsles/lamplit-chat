// This binding is intentionally absent from the default Free deployment.
// Add it to Wrangler only when the operator enables R2 photos.
interface Env { CHAT_INTEGRATIONS?: string; COMPUTER_R2?: R2Bucket; HOSTED_MODE?: string; CHAT_INTERNAL_SECRET?: string; PLATFORM?: Fetcher; PLATFORM_ORIGIN?: string }
declare namespace Cloudflare { interface Env { COMPUTER_R2?: R2Bucket } }

// This binding is intentionally absent from the default Free deployment.
// Add it to Wrangler only when the operator enables R2 photos.
interface Env { COMPUTER_R2?: R2Bucket; HOSTED_MODE?: string; CHAT_INTERNAL_SECRET?: string; PLATFORM?: Fetcher; PLATFORM_ORIGIN?: string; VOICE_API_KEY?: string; WEB_SEARCH_PROVIDER?: string; WEB_SEARCH_API_KEY?: string }
declare namespace Cloudflare { interface Env { COMPUTER_R2?: R2Bucket } }

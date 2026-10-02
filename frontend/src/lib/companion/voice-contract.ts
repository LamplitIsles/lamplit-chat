/** Pinned browser/chat wire contract, spec #3008. PCM16 LE mono, actual 16 kHz. */
export const MAX_VOICE_DURATION_MS = 300_000;
export const MAX_VOICE_PCM_BYTES = 9_600_000;
export const MAX_VOICE_FRAME_BYTES = 16 * 1024;
export const MAX_VOICE_QUEUE_BYTES = 256 * 1024;
export const VOICE_TRANSCRIPT_MAX_CHARS = 20_000;
export const VOICE_ERROR_CODES = ['voice_disabled', 'config_unavailable', 'invalid_key', 'rate_limited', 'upstream_error', 'timeout', 'cancelled', 'invalid_audio', 'transcript_invalid'] as const;
export type VoiceServerEvent = { type: 'ready' } | { type: 'result'; text: string } | { type: 'error'; code: typeof VOICE_ERROR_CODES[number] };

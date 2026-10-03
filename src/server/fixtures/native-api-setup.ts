// Preload native adapters in the test isolate. Vite's dynamic-module fetch must
// not first execute inside a DO and retain that DO's I/O context for later DOs.
import '@earendil-works/pi-ai/api/openai-completions'
import '@earendil-works/pi-ai/api/openai-responses'
import '@earendil-works/pi-ai/api/anthropic-messages'
import '@earendil-works/pi-ai/api/google-generative-ai'

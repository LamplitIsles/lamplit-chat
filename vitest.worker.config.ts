import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import agents from 'agents/vite'
import { defineConfig } from 'vitest/config'
import { mcpOutbound } from './src/server/fixtures/mcp-outbound'

// Wrangler otherwise loads the repository's real .env into the test Worker.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'

export default defineConfig({
  plugins: [
    agents({ stubTurndown: false }),
    cloudflareTest({
      main: './src/server-test-entry.ts',
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: { outboundService: mcpOutbound, bindings: { MODEL_API_KEY: 'fixture-key', AUTH_PASSWORD: 'fixture-password-long-enough' } },
    }),
  ],
  test: {
    include: ['src/server/**/*.worker.test.ts'],
    setupFiles: ['./src/server/fixtures/native-api-setup.ts'],
    testTimeout: 30_000,
  },
})

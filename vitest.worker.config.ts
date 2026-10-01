import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import agents from 'agents/vite'
import { defineConfig } from 'vitest/config'

// Wrangler otherwise loads the repository's real .env into the test Worker.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'

export default defineConfig({
  plugins: [
    agents({ stubTurndown: false }),
    cloudflareTest({
      main: './src/server-test-entry.ts',
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: { bindings: { MODEL_API_KEY: 'fixture-key', AUTH_PASSWORD: 'fixture-password-long-enough' } },
    }),
  ],
  test: {
    include: ['src/server/**/*.worker.test.ts'],
    testTimeout: 30_000,
  },
})

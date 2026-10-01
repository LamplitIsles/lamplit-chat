import { defineConfig } from '../../node_modules/vite/dist/node/index.js'
import { svelte } from '../../node_modules/@sveltejs/vite-plugin-svelte/src/index.js'
import tailwindcss from '../../node_modules/@tailwindcss/vite/dist/index.mjs'
import { fileURLToPath } from 'node:url'
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [tailwindcss(), svelte()], resolve: { alias: { '$app/stores': fileURLToPath(new URL('./stores.ts', import.meta.url)) } }, server: { host: '127.0.0.1', port: 5199, strictPort: true, fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] } } })

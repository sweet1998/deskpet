import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    clearMocks: true,
    restoreMocks: true,
    include: ['src/**/*.test.ts'],
  },
})

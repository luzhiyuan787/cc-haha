import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: true,
    // Render-heavy chat payload tests take ~5.3s solo on slower machines and
    // the full suite roughly doubles that under worker contention; the vitest
    // default of 5s turns them into flaky timeouts in check:desktop. The
    // coverage gate passes a higher CLI override for its instrumented run.
    testTimeout: 20_000,
    setupFiles: ['./src/test/webStorage.ts'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/types/**',
        'src/mocks/**',
        'src/test/**',
        'src/vite-env.d.ts',
      ],
    },
  },
})

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
    // Render-heavy chat payload tests take ~5.3s solo but have needed >20s in
    // the full suite when the box is busy (27.9s observed at a 20s cap); the
    // vitest default of 5s was flaky even sooner. 60s matches the coverage
    // gate's override and still fails a genuinely hung test.
    testTimeout: 60_000,
    // Vitest sizes workers from the logical CPU count (16 here, 8 physical),
    // so the full suite oversubscribes the box — worst under the coverage
    // instrumenter, where unrelated tests were starving into timeouts and
    // assertion races. Six keeps every worker a physical core without them
    // fighting over the last two.
    maxWorkers: 6,
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

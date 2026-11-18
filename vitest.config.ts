import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Three separate test suites with explicit include globs
    include: [
      'test/**/*.test.ts',
      'test/**/*.prop.test.ts',
      'test/**/*.int.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
    // Treat each file as an independent module so fast-check seeds are isolated
    isolate: true,
    // Report style
    reporter: 'verbose',
  },
  resolve: {
    alias: {
      '#core': new URL('./src/core/index.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
      '#net': new URL('./src/net/index.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
    },
  },
});

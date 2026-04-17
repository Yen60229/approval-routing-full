import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment:  'jsdom',          // 提供 window / document
    globals:      true,             // describe / it / expect 不用 import
    setupFiles:   ['./tests/setup.js'],
    coverage: {
      provider: 'v8',
      include:  ['core/**/*.js'],
      exclude:  ['core/05-vendor.js'],
    },
  },
});

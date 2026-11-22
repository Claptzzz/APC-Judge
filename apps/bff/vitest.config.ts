import { defineJuezVitestConfig } from '@juez/config/vitest';

export default defineJuezVitestConfig({
  test: {
    coverage: {
      exclude: ['src/main.ts', 'src/test-utils/**'],
    },
  },
});

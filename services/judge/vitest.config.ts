import { defineJuezVitestConfig } from '@juez/config/vitest';

export default defineJuezVitestConfig({
  test: {
    // Los tests del sandbox compilan y ejecutan programas reales (g++ y python3).
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: { exclude: ['src/main.ts', 'src/test-utils/**'] },
  },
});

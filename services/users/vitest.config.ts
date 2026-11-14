import { defineJuezVitestConfig } from '@juez/config/vitest';

// Solo tests unitarios (el CI no levanta infraestructura). Los entrypoints que solo
// cablean procesos (main, migrate) se cubren con `pnpm test:int`.
export default defineJuezVitestConfig({
  test: {
    exclude: ['test/**/*.int.test.ts', 'node_modules/**'],
    coverage: { exclude: ['src/main.ts', 'src/migrate.ts'] },
  },
});

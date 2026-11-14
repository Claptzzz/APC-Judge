import { defineJuezVitestConfig } from '@juez/config/vitest';

export default defineJuezVitestConfig({
  test: {
    exclude: ['test/**/*.int.test.ts', 'node_modules/**'],
    coverage: {
      exclude: [
        'src/main.ts',
        'src/migrate.ts',
        'src/app.module.ts',
        'src/db/migrate.ts',
        'src/db/client.ts',
      ],
    },
  },
});

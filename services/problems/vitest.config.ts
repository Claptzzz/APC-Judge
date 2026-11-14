import { defineJuezVitestConfig } from '@juez/config/vitest';

// Se excluyen solo los puntos de entrada (cableado de procesos); la lógica que usan está
// en módulos con tests propios.
export default defineJuezVitestConfig({
  test: {
    coverage: {
      exclude: [
        'src/main.ts',
        'src/scripts/migrate.ts',
        'src/scripts/seed.ts',
        'src/test-utils/**',
      ],
    },
  },
});

import { defineJuezVitestConfig } from '@juez/config/vitest';
import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vitest/config';

// El preset de @juez/config apunta a archivos .ts en Node; aquí se agregan los .tsx y jsdom.
export default mergeConfig(
  defineJuezVitestConfig({
    test: {
      include: ['src/**/*.{test,spec}.tsx'],
      environment: 'jsdom',
      setupFiles: ['src/test/setup.ts'],
      restoreMocks: true,
      coverage: {
        include: ['src/**/*.tsx'],
        exclude: ['src/main.tsx', 'src/test/**', 'src/**/*.test.tsx', 'src/vite-env.d.ts'],
      },
    },
  }),
  { plugins: [react()] },
);

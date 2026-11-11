// Preset de Vitest compartido: coverage v8 con umbral de 60% en
// lines/functions/branches/statements. Uso en cada paquete (vitest.config.ts):
//   import { defineJuezVitestConfig } from '@juez/config/vitest';
//   export default defineJuezVitestConfig({ test: { coverage: { exclude: ['src/main.ts'] } } });
import { defineConfig, mergeConfig } from 'vitest/config';

export const COVERAGE_THRESHOLD = 60;

export const vitestPreset = defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts', 'test/**/*.{test,spec}.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/gen/**', 'src/**/*.d.ts', 'src/**/*.{test,spec}.ts', 'test/**'],
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: COVERAGE_THRESHOLD,
        functions: COVERAGE_THRESHOLD,
        branches: COVERAGE_THRESHOLD,
        statements: COVERAGE_THRESHOLD,
      },
    },
  },
});

/**
 * Combina el preset con overrides del paquete. Los arrays (p. ej. coverage.exclude)
 * se concatenan, así que basta con indicar las rutas adicionales.
 */
export function defineJuezVitestConfig(overrides = {}) {
  return mergeConfig(vitestPreset, overrides);
}

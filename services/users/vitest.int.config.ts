import { defineConfig } from 'vitest/config';

// Tests de integración contra la infraestructura local (`pnpm infra:up` + `pnpm db:migrate`).
// Excluidos del CI. Uso: pnpm --filter @juez/users test:int
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    setupFiles: ['test/load-env.ts'],
  },
});

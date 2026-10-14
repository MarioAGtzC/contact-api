import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Solo los .ts: `npm run build` deja copias .js de los tests que no deben correr.
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
  },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // I test girano sul sorgente TypeScript dei pacchetti: nessuna rete,
    // nessun database, nessun token. Se un test ha bisogno di uno di questi
    // tre, è un test di integrazione e va scritto altrove.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      // `fileURLToPath` e non `.pathname`: su Windows quest'ultimo restituisce
      // un percorso con lo slash iniziale (`/E:/…`) che il resolver non trova.
      '@angel/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
});

import { config as loadDotenv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 non carica più le variabili d'ambiente da solo.
// La CLI gira con cwd = packages/db, ma il file .env sta nella radice del
// monorepo: si caricano entrambi i percorsi, il primo trovato vince.
loadDotenv({ path: ['../../.env', '.env'], quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});

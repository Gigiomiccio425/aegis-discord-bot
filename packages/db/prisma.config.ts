import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7 non carica più le variabili d'ambiente da solo.
// La CLI gira con cwd = packages/db, ma il file .env sta nella radice del
// monorepo: si caricano entrambi i percorsi, il primo trovato vince.
loadDotenv({ path: ['../../.env', '.env'], quiet: true });

/**
 * URL di connessione.
 *
 * Non si usa l'helper `env()` di Prisma perché fallisce se la variabile manca,
 * e `prisma generate` non ha alcun bisogno di un database: gli serve solo lo
 * schema. Con `env()` la generazione del client fallisce durante la build
 * dell'immagine Docker e nella pipeline di integrazione, dove `DATABASE_URL`
 * giustamente non esiste.
 *
 * Il segnaposto entra in gioco solo quando la variabile è assente. I comandi
 * che il database lo toccano davvero — `migrate`, `db push`, `studio` — lo
 * ricevono comunque dall'ambiente, e se manca falliscono con un chiaro errore
 * di connessione invece che con un oscuro errore di configurazione.
 */
const url =
  process.env.DATABASE_URL ?? 'postgresql://aegis:aegis@localhost:5432/aegis?schema=public';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: { url },
});

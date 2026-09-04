import { z } from 'zod';

/**
 * Variabili d'ambiente validate all'avvio. Un errore qui ferma il processo
 * subito, invece di produrre un guasto oscuro tre ore dopo il deploy.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  DISCORD_TOKEN: z.string().min(20).optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  // Nessuna DISCORD_PUBLIC_KEY: serve solo a verificare le firme delle
  // interazioni ricevute via HTTP. ANGEL usa il gateway, dove le interazioni
  // arrivano già autenticate dalla connessione.
  DEV_GUILD_ID: z.string().optional(),

  /** ID dei proprietari, separati da virgola. */
  OWNER_IDS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean)),

  /**
   * Se attivo, solo gli ID elencati in OWNER_IDS possono accedere al pannello.
   *
   * Senza, chiunque abbia MANAGE_GUILD su un server dove il bot è presente
   * ottiene l'accesso come amministratore al primo ingresso — comodo per un bot
   * condiviso, sbagliato per un'installazione personale.
   */
  PANEL_OWNERS_ONLY: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  WEB_DEV_ORIGIN: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32).optional(),

  /** Chiave AES-256 in esadecimale (64 caratteri) per i segreti nel database. */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY deve essere 64 caratteri esadecimali')
    .optional(),

  GOOGLE_SAFE_BROWSING_KEY: z.string().optional(),
  THREAT_FEEDS_ENABLED: z
    .string()
    .default('true')
    .transform((s) => s !== 'false'),

  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),
  TWITCH_EVENTSUB_SECRET: z.string().optional(),

  /*
   * L'account Twitch da cui il bot parla in chat.
   *
   * Dichiarate qui anche se le legge un solo file, e non è pedanteria: questo
   * schema è l'elenco su cui si basano il kit di trasloco e il test che lo
   * verifica. Una variabile letta con `process.env` e basta è una variabile
   * che un trasloco non porta con sé — e il sintomo, sulla macchina nuova, è
   * un bot Twitch spento senza che nulla dica perché.
   */
  TWITCH_BOT_USER_ID: z.string().optional(),
  TWITCH_BOT_LOGIN: z.string().optional(),
  TWITCH_BOT_ACCESS_TOKEN: z.string().optional(),
  TWITCH_BOT_REFRESH_TOKEN: z.string().optional(),

  /** Indirizzo pubblico del pannello degli streamer, e la sua porta. */
  TWITCH_PUBLIC_URL: z.string().url().optional(),
  TWITCH_PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(781),

  /**
   * Chiave temporanea che apre la rotta per ottenere i token dell'account bot.
   *
   * Va tolta appena finito, ed è l'unica variabile che un trasloco **non**
   * deve portarsi dietro: copiarla sulla macchina nuova significherebbe
   * lasciare aperta una porta che serviva dieci minuti.
   */
  TWITCH_SETUP_KEY: z.string().optional(),

  /** Chiave facoltativa per le blocklist di abuse.ch. */
  ABUSECH_AUTH_KEY: z.string().optional(),
  /** Quante firme tenere al massimo dai feed pubblici. */
  THREAT_FEED_MAX: z.coerce.number().int().min(1000).max(2_000_000).default(150_000),
  /** Numero di shard del gateway. Serve oltre i 2500 server. */
  SHARD_COUNT: z.coerce.number().int().min(1).max(1000).optional(),

  STORAGE_DIR: z.string().default('./storage'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configurazione ambiente non valida:\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

/** Solo per i test: azzera la cache così si può ricaricare con valori diversi. */
export function resetEnvCache(): void {
  cached = null;
}

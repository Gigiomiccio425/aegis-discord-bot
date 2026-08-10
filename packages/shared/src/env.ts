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
  DISCORD_PUBLIC_KEY: z.string().optional(),
  DEV_GUILD_ID: z.string().optional(),

  /** ID dei proprietari, separati da virgola. */
  OWNER_IDS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean)),

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

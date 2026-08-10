import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export * from '../generated/prisma/client.js';
export * from './transcript.js';

let client: PrismaClient | null = null;

/**
 * Client Prisma condiviso dal processo.
 *
 * Prisma 7 richiede un driver adapter esplicito: il client non incorpora più
 * il motore Rust, quindi la connessione passa da `pg`.
 */
export function getPrisma(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (client) return client;
  if (!connectionString) {
    throw new Error('DATABASE_URL non impostata: il client Prisma non può connettersi.');
  }
  const adapter = new PrismaPg({ connectionString });
  client = new PrismaClient({
    adapter,
    log:
      process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace'
        ? ['warn', 'error', 'query']
        : ['warn', 'error'],
  });
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = null;
}

/**
 * `AuditEvent.id` è un BigInt: `JSON.stringify` lo rifiuta. Questa funzione
 * prepara un oggetto per la serializzazione verso il pannello.
 */
export function serializeBigInt<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as T;
}

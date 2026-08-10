import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShardingManager } from 'discord.js';
import { logger } from './core/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   AVVIO CON SHARDING

   Serve solo oltre i 2500 server: sotto quella soglia una singola connessione
   basta, e lo sharding aggiungerebbe soltanto processi da coordinare. Per
   questo è un punto d'ingresso separato — `node apps/bot/dist/shard.js` invece
   di `index.js` — e non una complicazione che tutti pagano.

   Cosa cambia con più processi:
     • ogni shard ha la propria cache: le funzioni che iterano
       `client.guilds.cache` vedono solo la propria fetta;
     • i comandi dal pannello arrivano via Redis a *tutti* gli shard, e ognuno
       ignora i server che non gli appartengono — il controllo è già nel
       gestore, che esce se la guild non è nella sua cache;
     • le code BullMQ e il database restano condivisi, quindi worker e API non
       cambiano di una riga.
   ═══════════════════════════════════════════════════════════════════════ */

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.fatal('DISCORD_TOKEN non impostato.');
    process.exit(1);
  }

  const manager = new ShardingManager(path.join(here, 'index.js'), {
    token,
    // 'auto' chiede a Discord quanti shard servono: il numero dipende dal
    // conteggio dei server e cambia nel tempo, sceglierlo a mano significa
    // doverlo correggere prima o poi.
    totalShards: process.env.SHARD_COUNT ? Number(process.env.SHARD_COUNT) : 'auto',
    respawn: true,
    mode: 'process',
  });

  manager.on('shardCreate', (shard) => {
    logger.info({ shardId: shard.id }, 'shard avviato');

    shard.on('death', () => logger.error({ shardId: shard.id }, 'shard terminato'));
    shard.on('disconnect', () => logger.warn({ shardId: shard.id }, 'shard disconnesso'));
    shard.on('reconnecting', () => logger.info({ shardId: shard.id }, 'shard in riconnessione'));
    shard.on('error', (error) => logger.error({ err: error, shardId: shard.id }, 'errore shard'));
  });

  await manager.spawn();
  logger.info({ shards: manager.shards.size }, 'tutti gli shard sono attivi');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'spegnimento degli shard');
    // I singoli processi gestiscono il proprio spegnimento pulito: qui si
    // chiede soltanto di terminare, senza forzare.
    for (const shard of manager.shards.values()) {
      shard.kill();
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((error) => {
  logger.fatal({ err: error }, 'avvio dello sharding fallito');
  process.exit(1);
});

import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import { disconnectPrisma, getPrisma } from '@angel/db';
import { announceVersion, Queues, runningVersion } from '@angel/shared';
import { logger } from './logger.js';
import { getRedis, closeRedis } from './redis.js';
import { deepScanProcessor } from './jobs/deepScan.js';
import { snapshotProcessor } from './jobs/snapshot.js';
import { threatFeedProcessor } from './jobs/threatFeeds.js';
import { retentionProcessor } from './jobs/retention.js';
import { twitchProcessor } from './jobs/twitch.js';
import { integrationsProcessor } from './jobs/integrations.js';
import { securityAuditProcessor } from './jobs/securityAudit.js';
import { socialProcessor } from './jobs/social.js';
import { terminateOcr } from '@angel/scanner';

/**
 * Worker.
 *
 * Tutto ciò che è lento o periodico vive qui e non nel processo del bot: OCR
 * delle immagini, backup programmati, aggiornamento delle blocklist, pulizia
 * per scadenza, controllo degli stream Twitch.
 *
 * La separazione non è estetica: un'analisi OCR da due secondi eseguita nel
 * processo del gateway ritarderebbe *tutti* gli altri eventi, compresi quelli
 * dell'anti-raid, che sono quelli che non possono aspettare.
 */
async function main(): Promise<void> {
  const connection = getRedis();
  const prisma = getPrisma();
  await prisma.$queryRaw`SELECT 1`;
  // Dichiara la propria versione: e l'unico modo di accorgersi che un
  // aggiornamento ha ricreato tre container su quattro.
  announceVersion(connection, 'worker');
  logger.info({ versione: runningVersion() }, 'worker avviato');

  const workers = [
    new Worker(Queues.deepScan, deepScanProcessor, {
      connection,
      // Un'immagine alla volta: tesseract è pesante e la concorrenza alta
      // farebbe solo aumentare la memoria senza migliorare la resa.
      concurrency: 2,
      limiter: { max: 30, duration: 60_000 },
    }),
    new Worker(Queues.snapshot, snapshotProcessor, { connection, concurrency: 1 }),
    new Worker(Queues.threatFeeds, threatFeedProcessor, { connection, concurrency: 1 }),
    new Worker(Queues.retention, retentionProcessor, { connection, concurrency: 1 }),
    new Worker(Queues.twitch, twitchProcessor, { connection, concurrency: 3 }),
    new Worker(Queues.integrations, integrationsProcessor, { connection, concurrency: 1 }),
    new Worker(Queues.securityAudit, securityAuditProcessor, { connection, concurrency: 1 }),
    new Worker(Queues.social, socialProcessor, { connection, concurrency: 2 }),
  ];

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      logger.error({ err: error, job: job?.name, queue: worker.name }, 'lavoro fallito');
    });
  }

  await scheduleRecurringJobs();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'spegnimento worker');
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await terminateOcr();
    await closeRedis();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'promise non gestita'));
}

/**
 * Lavori ricorrenti.
 *
 * Le chiavi dei job ripetuti sono stabili: BullMQ non li duplica a ogni
 * riavvio, e un riavvio frequente non produce dieci backup all'ora.
 */
async function scheduleRecurringJobs(): Promise<void> {
  const connection = getRedis();

  const snapshots = new Queue(Queues.snapshot, { connection });
  await snapshots.upsertJobScheduler(
    'snapshot-periodico',
    { pattern: '0 4 * * *' }, // ogni notte alle 4
    { name: 'scheduled', opts: { removeOnComplete: 20 } },
  );

  const feeds = new Queue(Queues.threatFeeds, { connection });
  await feeds.upsertJobScheduler(
    'aggiorna-blocklist',
    { every: 3_600_000 }, // ogni ora
    { name: 'sync', opts: { removeOnComplete: 10 } },
  );

  const retention = new Queue(Queues.retention, { connection });
  await retention.upsertJobScheduler(
    'pulizia-retention',
    { pattern: '30 3 * * *' },
    { name: 'cleanup', opts: { removeOnComplete: 10 } },
  );

  const twitch = new Queue(Queues.twitch, { connection });
  await twitch.upsertJobScheduler(
    'controllo-clip',
    { every: 900_000 }, // ogni 15 minuti
    { name: 'clips', opts: { removeOnComplete: 10 } },
  );

  const integrations = new Queue(Queues.integrations, { connection });
  await integrations.upsertJobScheduler(
    'scadenze-sondaggi-giveaway',
    { every: 60_000 },
    { name: 'due', opts: { removeOnComplete: 5, removeOnFail: 20 } },
  );

  // Gira ogni mezz'ora, ma il controllo vero è per server: il job verifica
  // l'intervallo configurato da ciascuno e richiede la revisione solo a chi è
  // effettivamente scaduto.
  // Gira ogni 5 minuti, ma ogni fonte è interrogata al proprio intervallo:
  // il job si limita a chiedere «è ora?» a ciascuna.
  const social = new Queue(Queues.social, { connection });
  await social.upsertJobScheduler(
    'fonti-esterne',
    { every: 300_000 },
    { name: 'poll', opts: { removeOnComplete: 10, removeOnFail: 30 } },
  );

  const audit = new Queue(Queues.securityAudit, { connection });
  await audit.upsertJobScheduler(
    'revisione-sicurezza',
    { every: 1_800_000 },
    { name: 'due', opts: { removeOnComplete: 10 } },
  );

  logger.info('lavori ricorrenti programmati');
}

void main().catch((error) => {
  logger.fatal({ err: error }, 'avvio worker fallito');
  process.exit(1);
});

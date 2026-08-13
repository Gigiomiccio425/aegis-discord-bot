import { statfs } from 'node:fs/promises';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { disconnectPrisma, getPrisma } from '@angel/db';
import { logger, loggerOptions } from './logger.js';
import { closeRedis, getRedis } from './redis.js';
import { announceVersion, runningVersion } from '@angel/shared';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { logRoutes } from './routes/logs.js';
import { moderationRoutes } from './routes/moderation.js';
import { builderRoutes } from './routes/builder.js';
import { backupRoutes } from './routes/backups.js';
import { threatRoutes } from './routes/threats.js';
import { archiveRoutes } from './routes/archive.js';
import { ticketRoutes } from './routes/tickets.js';
import { inventoryRoutes } from './routes/inventory.js';
import { integrationRoutes } from './routes/integrations.js';
import { accessRoutes } from './routes/access.js';
import { webhookRoutes } from './routes/webhooks.js';
import { versionRoutes } from './routes/version.js';
import { syncRoutes } from './routes/sync.js';
import { registerLiveFeed } from './ws.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Spazio libero sul volume dei dati, in percentuale e in gigabyte.
 *
 * `statfs` e non un comando esterno: dentro il container non c'è `df`, e in
 * ogni caso far girare un processo per leggere un numero è un modo elaborato
 * di introdurre un guasto in più.
 */
async function spazioLibero(): Promise<{ liberoGb: number; totaleGb: number; usatoPercento: number } | null> {
  try {
    const percorso = process.env.STORAGE_DIR ?? '/data';
    const stat = await statfs(percorso);
    const totale = stat.blocks * stat.bsize;
    const libero = stat.bavail * stat.bsize;
    const giga = (byte: number): number => Math.round((byte / 1_073_741_824) * 10) / 10;

    return {
      liberoGb: giga(libero),
      totaleGb: giga(totale),
      usatoPercento: totale > 0 ? Math.round((1 - libero / totale) * 100) : 0,
    };
  } catch {
    // Un controllo di salute non deve fallire perché non è riuscito a leggere
    // un dato accessorio.
    return null;
  }
}

async function main(): Promise<void> {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    logger.fatal(
      'SESSION_SECRET mancante o troppo corta (minimo 32 caratteri). Genera con: openssl rand -hex 32',
    );
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_KEY) {
    logger.fatal('ENCRYPTION_KEY mancante. Genera con: openssl rand -hex 32');
    process.exit(1);
  }

  const prisma = getPrisma();

  /*
   * Il database può non esserci. Prima si usciva, il container ripartiva, e il
   * pannello non si apriva mai: chi cercava di capire perché il bot non c'era
   * più trovava solo un ciclo di errori nei log.
   *
   * Partire lo stesso non serve a moderare — senza database non si può fare
   * nulla — serve a **dire cosa non va**, che nel momento del guasto è
   * esattamente ciò che manca.
   */
  let motivoDegrado: string | null = null;
  await prisma.$queryRaw`SELECT 1`.catch((errore: Error) => {
    motivoDegrado = errore.message.slice(0, 300);
    logger.error({ err: errore }, 'database irraggiungibile: pannello in modalità ridotta');
  });

  const app = Fastify({
    logger: loggerOptions,
    // Dietro Caddy l'IP reale arriva negli header: senza questo, il rate limit
    // vedrebbe un solo client per tutti.
    trustProxy: true,
    // 32 MB: un rientro dal nodo di emergenza porta con se ore di registro, e
    // rifiutarlo per dimensione significherebbe perdere proprio i dati che si
    // stava cercando di salvare.
    bodyLimit: 32 * 1024 * 1024,
  });

  /**
   * Il webhook Twitch richiede il corpo grezzo per verificare la firma HMAC:
   * riserializzare il JSON dopo il parsing cambia gli spazi e la firma non
   * corrisponde più. Si conserva quindi il testo originale prima di analizzarlo.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request: FastifyRequest & { rawBody?: string }, body, done) => {
      request.rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  await app.register(cookie, { secret: sessionSecret });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis: getRedis(),
    // Il feed live e i file statici non devono consumare la quota: sono
    // richieste legittime e frequenti.
    allowList: (request) =>
      request.url.startsWith('/assets/') || request.url.endsWith('/live'),
    errorResponseBuilder: () => ({
      error: 'Troppe richieste. Riprova fra poco.',
    }),
  });

  await app.register(websocket);

  /*
   * Stato del nodo.
   *
   * Non richiede autenticazione di proposito: è ciò che il nodo di emergenza
   * interroga per sapere se il server principale è vivo, e un controllo che
   * ha bisogno di credenziali è un controllo che fallisce anche quando il
   * server sta benissimo — cioè un falso allarme che accende un secondo bot.
   *
   * Non espone nulla di sensibile: se questo risponde, la porta è già
   * raggiungibile, e chi la raggiunge sta già dentro il tailnet.
   */
  /*
   * Modalità ridotta: le rotte che hanno bisogno del database rispondono con
   * una spiegazione invece di un errore di connessione grezzo, e `/health`
   * continua a rispondere — è quello che il nodo di emergenza interroga, e
   * deve poter distinguere «server morto» da «server vivo ma senza database».
   */
  app.addHook('onRequest', async (request, reply) => {
    if (!motivoDegrado) return;
    if (!request.url.startsWith('/api/')) return;
    if (request.url.startsWith('/api/version')) return;

    await reply.code(503).send({
      error:
        'Il database non risponde, quindi il pannello è in modalità ridotta: può dire cosa non va, non modificare nulla.',
      dettaglio: motivoDegrado,
      cosaFare:
        'Nove volte su dieci è il disco pieno. Controlla con `df -h` e `df -i` sulla macchina, ' +
        'poi libera spazio: il database riparte da solo e il pannello torna completo senza riavvii.',
    });
  });

  // Ogni mezzo minuto si riprova: quando il database torna, il pannello torna
  // completo da solo. Riavviare a mano dopo aver fatto spazio è un passaggio
  // che nessuno ricorda di dover fare.
  if (motivoDegrado) {
    const riprova = setInterval(() => {
      void prisma.$queryRaw`SELECT 1`
        .then(() => {
          motivoDegrado = null;
          clearInterval(riprova);
          logger.info('database tornato disponibile: pannello completo');
        })
        .catch(() => undefined);
    }, 30_000);
    riprova.unref();
  }

  app.get('/health', async () => {
    const database = await prisma
      .$queryRaw`SELECT 1`
      .then(() => true)
      .catch(() => false);
    const redis = await getRedis()
      .ping()
      .then(() => true)
      .catch(() => false);

    return {
      ok: database && redis,
      database,
      redis,
      uptime: process.uptime(),
      versione: runningVersion(),
      // Lo spazio libero sta qui perché il disco pieno non si annuncia: il bot
      // continua a rispondere mentre Postgres non riesce più a scrivere e Redis
      // blocca le code. Averlo nel controllo di salute significa accorgersene
      // dal sorvegliante, prima che diventi un guasto.
      disco: await spazioLibero(),
      // `principale` o `emergenza`. Il nodo di emergenza si spegne da solo
      // quando vede un principale rispondere: la priorità non si negozia.
      ruolo: process.env.ANGEL_MODE === 'emergenza' ? 'emergenza' : 'principale',
    };
  });

  await app.register(authRoutes);
  await app.register(configRoutes);
  await app.register(logRoutes);
  await app.register(moderationRoutes);
  await app.register(builderRoutes);
  await app.register(backupRoutes);
  await app.register(threatRoutes);
  await app.register(archiveRoutes);
  await app.register(ticketRoutes);
  await app.register(inventoryRoutes);
  await app.register(integrationRoutes);
  await app.register(accessRoutes);
  await app.register(webhookRoutes);
  await app.register(versionRoutes);
  await app.register(syncRoutes);
  await registerLiveFeed(app);

  /**
   * Il pannello compilato viene servito dalla stessa origine dell'API.
   *
   * Un container in meno da gestire su ZimaOS, e soprattutto niente CORS: il
   * cookie di sessione resta same-site, che è la configurazione più solida
   * contro il CSRF.
   */
  const webRoot = path.resolve(here, '../../web/dist');
  await app.register(staticPlugin, { root: webRoot, prefix: '/', wildcard: false });

  // Tutte le rotte non-API tornano l'index: il routing lo gestisce React.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'endpoint non trovato' });
    }
    return reply.sendFile('index.html');
  });

  const port = Number(process.env.API_PORT ?? 8080);
  await app.listen({ port, host: '0.0.0.0' });
  announceVersion(getRedis(), 'api');
  logger.info(
    { port, publicUrl: process.env.PUBLIC_URL, versione: runningVersion() },
    'API avviata',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'spegnimento API');
    await app.close();
    await closeRedis();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((error) => {
  logger.fatal({ err: error }, 'avvio API fallito');
  process.exit(1);
});

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { disconnectPrisma, getPrisma } from '@aegis/db';
import { logger, loggerOptions } from './logger.js';
import { closeRedis, getRedis } from './redis.js';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { logRoutes } from './routes/logs.js';
import { moderationRoutes } from './routes/moderation.js';
import { builderRoutes } from './routes/builder.js';
import { backupRoutes } from './routes/backups.js';
import { threatRoutes } from './routes/threats.js';
import { archiveRoutes } from './routes/archive.js';
import { integrationRoutes } from './routes/integrations.js';
import { accessRoutes } from './routes/access.js';
import { webhookRoutes } from './routes/webhooks.js';
import { registerLiveFeed } from './ws.js';

const here = path.dirname(fileURLToPath(import.meta.url));

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
  await prisma.$queryRaw`SELECT 1`;

  const app = Fastify({
    logger: loggerOptions,
    // Dietro Caddy l'IP reale arriva negli header: senza questo, il rate limit
    // vedrebbe un solo client per tutti.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
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

  app.get('/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    await getRedis().ping();
    return { ok: true, uptime: process.uptime() };
  });

  await app.register(authRoutes);
  await app.register(configRoutes);
  await app.register(logRoutes);
  await app.register(moderationRoutes);
  await app.register(builderRoutes);
  await app.register(backupRoutes);
  await app.register(threatRoutes);
  await app.register(archiveRoutes);
  await app.register(integrationRoutes);
  await app.register(accessRoutes);
  await app.register(webhookRoutes);
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
  logger.info({ port, publicUrl: process.env.PUBLIC_URL }, 'API avviata');

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

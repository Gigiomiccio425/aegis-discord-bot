import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@aegis/db';
import {
  defaultGuildConfig,
  MODULE_REGISTRY,
  parseGuildConfig,
  RedisKeys,
  type GuildConfig,
} from '@aegis/shared';
import { requireGuild } from '../guard.js';
import { getRedis, sendBotCommand } from '../redis.js';
import { logger } from '../logger.js';

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/config', async (request, reply) => {
    const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
    if (!context) return;

    const prisma = getPrisma();
    const guild = await prisma.guild.findUnique({ where: { id: context.guildId } });
    if (!guild) return reply.code(404).send({ error: 'server non trovato' });

    const parsed = parseGuildConfig(guild.config);
    return {
      config: parsed.ok ? parsed.value : defaultGuildConfig(),
      modules: MODULE_REGISTRY,
      // Segnalato apertamente: una configurazione non valida nel database
      // significa che il bot sta girando con i valori predefiniti.
      invalid: parsed.ok ? null : parsed.errors,
    };
  });

  /**
   * Salvataggio della configurazione.
   *
   * La validazione usa gli stessi schemi Zod che usa il bot: se passa qui,
   * funziona lì. È il motivo per cui gli schemi stanno in `@aegis/shared` e non
   * duplicati nei due progetti — due copie divergono sempre, e la divergenza si
   * scopre quando una difesa non parte.
   */
  app.put<{ Params: { guildId: string }; Body: unknown }>(
    '/api/guilds/:guildId/config',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const parsed = parseGuildConfig(request.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: 'configurazione non valida', dettagli: parsed.errors });
      }

      const prisma = getPrisma();
      const previous = await prisma.guild.findUnique({ where: { id: context.guildId } });
      if (!previous) return reply.code(404).send({ error: 'server non trovato' });

      const changedPaths = diffPaths(previous.config as GuildConfig, parsed.value);

      await prisma.guild.update({
        where: { id: context.guildId },
        data: { config: parsed.value as unknown as object, configVersion: parsed.value.version },
      });

      await prisma.configHistory.create({
        data: {
          guildId: context.guildId,
          actorId: context.user.id,
          source: 'panel',
          paths: changedPaths,
          before: (previous.config ?? {}) as object,
          after: parsed.value as unknown as object,
        },
      });

      // Invalidazione immediata: senza, il bot userebbe la vecchia
      // configurazione fino alla scadenza della cache.
      const redis = getRedis();
      await redis.del(RedisKeys.guildConfig(context.guildId));
      await redis.publish(RedisKeys.configChannel, context.guildId);

      await prisma.auditEvent.create({
        data: {
          guildId: context.guildId,
          type: 'CONFIG_CHANGED',
          category: 'BOT',
          actorId: context.user.id,
          actorTag: context.user.tag,
          summary: `Configurazione aggiornata dal pannello (${changedPaths.length} modifiche)`,
          payload: { paths: changedPaths } as object,
        },
      });

      logger.info(
        { guildId: context.guildId, userId: context.user.id, changes: changedPaths.length },
        'configurazione aggiornata',
      );

      return { ok: true, changedPaths };
    },
  );

  /** Storico delle modifiche: chi ha cambiato cosa e quando. */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/config/history',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      return prisma.configHistory.findMany({
        where: { guildId: context.guildId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, actorId: true, source: true, paths: true, createdAt: true },
      });
    },
  );

  /** Ripristino di una versione precedente della configurazione. */
  app.post<{ Params: { guildId: string; historyId: string } }>(
    '/api/guilds/:guildId/config/history/:historyId/restore',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const entry = await prisma.configHistory.findUnique({
        where: { id: request.params.historyId },
      });
      if (!entry || entry.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'versione non trovata' });
      }

      const parsed = parseGuildConfig(entry.before);
      if (!parsed.ok) return reply.code(400).send({ error: 'versione non ripristinabile' });

      await prisma.guild.update({
        where: { id: context.guildId },
        data: { config: parsed.value as unknown as object },
      });

      const redis = getRedis();
      await redis.del(RedisKeys.guildConfig(context.guildId));
      await redis.publish(RedisKeys.configChannel, context.guildId);
      await sendBotCommand({ action: 'config.reloaded', guildId: context.guildId });

      return { ok: true };
    },
  );
}

/** Percorsi modificati fra due configurazioni, per lo storico. */
function diffPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (before === after) return [];
  if (
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    before === null ||
    after === null ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return [prefix];
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
  }

  const keys = new Set([
    ...Object.keys(before as Record<string, unknown>),
    ...Object.keys(after as Record<string, unknown>),
  ]);
  const paths: string[] = [];
  for (const key of keys) {
    paths.push(
      ...diffPaths(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        prefix ? `${prefix}.${key}` : key,
      ),
    );
  }
  return paths;
}

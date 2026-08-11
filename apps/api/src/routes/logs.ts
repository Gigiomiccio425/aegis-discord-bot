import type { FastifyInstance } from 'fastify';
import { getPrisma, serializeBigInt } from '@angel/db';
import { z } from 'zod';
import { requireGuild } from '../guard.js';

const LogQuery = z.object({
  // `cursor` invece di `page`: con milioni di righe l'OFFSET diventa lento in
  // modo drammatico, mentre la paginazione per chiave resta costante.
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  type: z.string().optional(),
  category: z.string().optional(),
  actorId: z.string().optional(),
  targetId: z.string().optional(),
  channelId: z.string().optional(),
  search: z.string().max(200).optional(),
  minSeverity: z.coerce.number().int().min(0).max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function logRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { guildId: string }; Querystring: Record<string, string> }>(
    '/api/guilds/:guildId/logs',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const parsed = LogQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'parametri non validi', dettagli: parsed.error.issues });
      }
      const query = parsed.data;

      const prisma = getPrisma();
      const events = await prisma.auditEvent.findMany({
        where: {
          guildId: context.guildId,
          ...(query.type ? { type: query.type } : {}),
          ...(query.category ? { category: query.category } : {}),
          ...(query.actorId ? { actorId: query.actorId } : {}),
          ...(query.targetId ? { targetId: query.targetId } : {}),
          ...(query.channelId ? { channelId: query.channelId } : {}),
          ...(query.minSeverity !== undefined ? { severity: { gte: query.minSeverity } } : {}),
          ...(query.search ? { summary: { contains: query.search, mode: 'insensitive' } } : {}),
          ...(query.from || query.to
            ? {
                createdAt: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lte: new Date(query.to) } : {}),
                },
              }
            : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: BigInt(query.cursor) }, skip: 1 } : {}),
      });

      const hasMore = events.length > query.limit;
      const page = hasMore ? events.slice(0, query.limit) : events;

      return serializeBigInt({
        events: page,
        nextCursor: hasMore ? page[page.length - 1]?.id : null,
      });
    },
  );

  /**
   * Esportazione del registro.
   *
   * CSV per chi deve aprirlo in un foglio di calcolo, JSON per chi deve
   * elaborarlo. Il limite è alto ma non illimitato: un'esportazione da milioni
   * di righe non serve a nessuno e blocca il database per minuti.
   */
  app.get<{ Params: { guildId: string }; Querystring: Record<string, string> }>(
    '/api/guilds/:guildId/logs/export',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const query = z
        .object({
          format: z.enum(['csv', 'json']).default('csv'),
          category: z.string().optional(),
          type: z.string().optional(),
          actorId: z.string().optional(),
          minSeverity: z.coerce.number().int().min(0).max(100).optional(),
          days: z.coerce.number().int().min(1).max(3650).optional(),
          limit: z.coerce.number().int().min(1).max(100000).default(20000),
        })
        .safeParse(request.query);

      if (!query.success) return reply.code(400).send({ error: 'parametri non validi' });

      const prisma = getPrisma();
      const events = await prisma.auditEvent.findMany({
        where: {
          guildId: context.guildId,
          ...(query.data.category ? { category: query.data.category } : {}),
          ...(query.data.type ? { type: query.data.type } : {}),
          ...(query.data.actorId ? { actorId: query.data.actorId } : {}),
          ...(query.data.minSeverity !== undefined
            ? { severity: { gte: query.data.minSeverity } }
            : {}),
          ...(query.data.days
            ? { createdAt: { gte: new Date(Date.now() - query.data.days * 86_400_000) } }
            : {}),
        },
        orderBy: { id: 'desc' },
        take: query.data.limit,
      });

      const stamp = new Date().toISOString().slice(0, 10);

      await prisma.auditEvent
        .create({
          data: {
            guildId: context.guildId,
            type: 'PANEL_ACTION',
            category: 'BOT',
            actorId: context.user.id,
            actorTag: context.user.tag,
            severity: 20,
            summary: `Registro esportato: ${events.length} righe in formato ${query.data.format}`,
            payload: { format: query.data.format, count: events.length },
          },
        })
        .catch(() => undefined);

      if (query.data.format === 'json') {
        return reply
          .header('content-type', 'application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="registro-${stamp}.json"`)
          .send(serializeBigInt(events));
      }

      const columns = [
        'id',
        'createdAt',
        'type',
        'category',
        'severity',
        'automated',
        'actorId',
        'actorTag',
        'targetId',
        'targetTag',
        'channelId',
        'messageId',
        'summary',
      ] as const;

      const rows = events.map((event) =>
        columns
          .map((column) => {
            const value = event[column];
            if (value === null || value === undefined) return '';
            const text = value instanceof Date ? value.toISOString() : String(value);
            // Le virgolette raddoppiate sono la forma prevista dal formato: un
            // riepilogo che contiene una virgola o un a capo romperebbe
            // altrimenti l'intero file.
            return `"${text.replace(/"/g, '""')}"`;
          })
          .join(','),
      );

      // BOM iniziale: senza, Excel apre gli accenti come caratteri incomprensibili.
      const csv = `\uFEFF${columns.join(',')}\n${rows.join('\n')}`;

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="registro-${stamp}.csv"`)
        .send(csv);
    },
  );

  /** Timeline di un singolo utente: tutto ciò che ha fatto e subito. */
  app.get<{ Params: { guildId: string; userId: string } }>(
    '/api/guilds/:guildId/users/:userId/timeline',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      const [profile, events, cases, voice] = await Promise.all([
        prisma.userProfile.findUnique({
          where: { guildId_userId: { guildId: context.guildId, userId: request.params.userId } },
        }),
        prisma.auditEvent.findMany({
          where: {
            guildId: context.guildId,
            OR: [{ actorId: request.params.userId }, { targetId: request.params.userId }],
          },
          orderBy: { id: 'desc' },
          take: 100,
        }),
        prisma.case.findMany({
          where: { guildId: context.guildId, targetId: request.params.userId },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.voiceSession.aggregate({
          where: { guildId: context.guildId, userId: request.params.userId },
          _sum: { seconds: true },
          _count: true,
        }),
      ]);

      return serializeBigInt({
        profile,
        events,
        cases,
        voice: { totalSeconds: voice._sum.seconds ?? 0, sessions: voice._count },
      });
    },
  );

  /** Statistiche per la dashboard. */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/stats',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'VIEWER');
      if (!context) return;

      const prisma = getPrisma();
      const day = new Date(Date.now() - 86_400_000);
      const week = new Date(Date.now() - 7 * 86_400_000);

      const [threatsToday, threatsWeek, joinsToday, activeCases, quarantined, topThreats, incidents] =
        await Promise.all([
          prisma.auditEvent.count({
            where: { guildId: context.guildId, category: 'SECURITY', createdAt: { gte: day } },
          }),
          prisma.auditEvent.count({
            where: { guildId: context.guildId, category: 'SECURITY', createdAt: { gte: week } },
          }),
          prisma.auditEvent.count({
            where: { guildId: context.guildId, type: 'MEMBER_JOINED', createdAt: { gte: day } },
          }),
          prisma.case.count({ where: { guildId: context.guildId, status: 'ACTIVE' } }),
          prisma.userProfile.count({
            where: { guildId: context.guildId, quarantinedAt: { not: null } },
          }),
          prisma.auditEvent.groupBy({
            by: ['type'],
            where: { guildId: context.guildId, category: 'SECURITY', createdAt: { gte: week } },
            _count: true,
            orderBy: { _count: { type: 'desc' } },
            take: 8,
          }),
          prisma.incident.findMany({
            where: { guildId: context.guildId },
            orderBy: { startedAt: 'desc' },
            take: 5,
          }),
        ]);

      // Serie oraria degli ingressi: è il grafico su cui si riconosce un raid a
      // colpo d'occhio, molto più di un numero aggregato.
      const joinSeries = await prisma.$queryRaw<{ ora: Date; totale: bigint }[]>`
        SELECT date_trunc('hour', "createdAt") AS ora, COUNT(*)::bigint AS totale
        FROM "AuditEvent"
        WHERE "guildId" = ${context.guildId}
          AND "type" = 'MEMBER_JOINED'
          AND "createdAt" >= ${week}
        GROUP BY 1
        ORDER BY 1
      `;

      return serializeBigInt({
        threatsToday,
        threatsWeek,
        joinsToday,
        activeCases,
        quarantined,
        topThreats: topThreats.map((entry) => ({ type: entry.type, count: entry._count })),
        incidents,
        joinSeries: joinSeries.map((row) => ({
          hour: row.ora,
          count: Number(row.totale),
        })),
      });
    },
  );

  /** Contenuto archiviato di un messaggio eliminato. */
  app.get<{ Params: { guildId: string; messageId: string } }>(
    '/api/guilds/:guildId/messages/:messageId',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      const message = await prisma.messageArchive.findUnique({
        where: { id: request.params.messageId },
        include: { attachments: true },
      });
      if (!message || message.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'messaggio non archiviato' });
      }
      return message;
    },
  );
}

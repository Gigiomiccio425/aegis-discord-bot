import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@aegis/db';
import { requireGuild } from '../guard.js';
import { sendBotCommand } from '../redis.js';

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/backups',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const snapshots = await prisma.snapshot.findMany({
        where: { guildId: context.guildId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        // I contenuti completi pesano megabyte: nell'elenco servono solo i
        // metadati, il dettaglio si carica su richiesta.
        select: {
          id: true,
          kind: true,
          createdAt: true,
          createdBy: true,
          sizeBytes: true,
          restoredAt: true,
          restoredBy: true,
        },
      });
      return snapshots;
    },
  );

  app.get<{ Params: { guildId: string; snapshotId: string } }>(
    '/api/guilds/:guildId/backups/:snapshotId',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const snapshot = await prisma.snapshot.findUnique({
        where: { id: request.params.snapshotId },
      });
      if (!snapshot || snapshot.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'backup non trovato' });
      }
      return snapshot;
    },
  );

  /**
   * Anteprima del ripristino.
   *
   * Mostra cosa verrebbe ricreato *prima* di agire: dopo un nuke parziale,
   * ripristinare alla cieca può fare più danni dell'attacco, ricreando canali
   * che erano stati eliminati di proposito.
   */
  app.get<{ Params: { guildId: string; snapshotId: string } }>(
    '/api/guilds/:guildId/backups/:snapshotId/diff',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const snapshot = await prisma.snapshot.findUnique({
        where: { id: request.params.snapshotId },
      });
      if (!snapshot || snapshot.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'backup non trovato' });
      }

      const current = await prisma.snapshot.findFirst({
        where: { guildId: context.guildId },
        orderBy: { createdAt: 'desc' },
      });

      const snapshotRoles = (snapshot.roles as unknown as { id: string; name: string }[]) ?? [];
      const snapshotChannels = (snapshot.channels as unknown as { id: string; name: string }[]) ?? [];
      const currentRoles = (current?.roles as unknown as { id: string; name: string }[]) ?? [];
      const currentChannels = (current?.channels as unknown as { id: string; name: string }[]) ?? [];

      return {
        missingRoles: snapshotRoles.filter(
          (role) => !currentRoles.some((entry) => entry.name === role.name),
        ),
        missingChannels: snapshotChannels.filter(
          (channel) => !currentChannels.some((entry) => entry.name === channel.name),
        ),
        addedSince: {
          roles: currentRoles.filter(
            (role) => !snapshotRoles.some((entry) => entry.name === role.name),
          ),
          channels: currentChannels.filter(
            (channel) => !snapshotChannels.some((entry) => entry.name === channel.name),
          ),
        },
        note:
          'Il ripristino ricrea solo ciò che manca, confrontando per nome. ' +
          'La cronologia dei messaggi non è ripristinabile: Discord non lo consente. ' +
          'I messaggi archiviati dal bot restano consultabili nel registro.',
      };
    },
  );

  app.post<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/backups',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      await sendBotCommand({
        action: 'snapshot.create',
        guildId: context.guildId,
        actorId: context.user.id,
      });
      return { ok: true, note: 'Backup richiesto: comparirà nell\'elenco fra qualche secondo.' };
    },
  );
}

import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { getPrisma } from '@aegis/db';
import { GuildConfigSchema, RedisKeys, type LogCategory } from '@aegis/shared';
import { childLogger } from '../logger.js';
import { getRedis } from '../redis.js';
import { recordWorkerEvent, timeoutMember, unbanMember } from '../discord.js';

const log = childLogger('retention');

/**
 * Pulizia periodica.
 *
 * Tre compiti distinti che condividono la stessa cadenza notturna:
 *   1. applicare i periodi di conservazione configurati per ciascuna categoria
 *   2. eliminare gli allegati archiviati oltre la scadenza, dal disco e dal DB
 *   3. chiudere i provvedimenti scaduti
 *
 * Il primo punto non è solo igiene: una retention dichiarata e non applicata è
 * peggio di nessuna retention, perché è una promessa non mantenuta agli utenti
 * a cui il comando `/privacy` mostra quei numeri.
 */
export async function retentionProcessor(_job: Job): Promise<void> {
  const prisma = getPrisma();
  const guilds = await prisma.guild.findMany({ where: { active: true } });

  for (const guild of guilds) {
    const parsed = GuildConfigSchema.safeParse(guild.config);
    if (!parsed.success) continue;
    const config = parsed.data;

    /* ── Eventi, per categoria ──────────────────────────────────────── */
    for (const [category, days] of Object.entries(config.logging.retentionDays)) {
      if (!days || days <= 0) continue;
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const deleted = await prisma.auditEvent.deleteMany({
        where: { guildId: guild.id, category: category as LogCategory, createdAt: { lt: cutoff } },
      });
      if (deleted.count > 0) {
        log.debug({ guildId: guild.id, category, removed: deleted.count }, 'eventi scaduti rimossi');
      }
    }

    /* ── Messaggi archiviati ────────────────────────────────────────── */
    const messageDays = config.logging.retentionDays.MESSAGE ?? 90;
    if (messageDays > 0) {
      const cutoff = new Date(Date.now() - messageDays * 86_400_000);
      await prisma.messageArchive
        .deleteMany({ where: { guildId: guild.id, createdAt: { lt: cutoff } } })
        .catch(() => undefined);
    }

    /* ── Allegati: prima il file, poi la riga ───────────────────────── */
    const attachmentCutoff = new Date(
      Date.now() - config.logging.attachmentRetentionDays * 86_400_000,
    );
    const expired = await prisma.attachmentArchive.findMany({
      where: { guildId: guild.id, createdAt: { lt: attachmentCutoff }, storagePath: { not: null } },
      take: 5000,
    });

    const storageRoot = process.env.STORAGE_DIR ?? './storage';
    for (const attachment of expired) {
      if (!attachment.storagePath) continue;
      await rm(path.join(storageRoot, attachment.storagePath), { force: true }).catch(() => undefined);
    }
    if (expired.length > 0) {
      await prisma.attachmentArchive
        .deleteMany({ where: { id: { in: expired.map((entry) => entry.id) } } })
        .catch(() => undefined);
      log.info({ guildId: guild.id, removed: expired.length }, 'allegati scaduti rimossi');
    }

    /* ── Sessioni vocali senza chiusura ─────────────────────────────── */
    // Un riavvio del bot lascia sessioni aperte per sempre: si chiudono qui,
    // altrimenti la statistica sul tempo in vocale diventa priva di senso.
    await prisma.voiceSession
      .updateMany({
        where: {
          guildId: guild.id,
          leftAt: null,
          joinedAt: { lt: new Date(Date.now() - 24 * 3_600_000) },
        },
        data: { leftAt: new Date(), seconds: 0 },
      })
      .catch(() => undefined);

    /* ── Riprofilazione degli account ───────────────────────────────── */
    // Il rischio di un account non è una fotografia scattata all'ingresso: chi
    // è entrato mesi fa può cambiare nome e avatar per somigliare a un
    // moderatore. La riprofilazione la esegue il bot, che ha la cache dei
    // membri; qui si limita a chiederla.
    if (config.security.accountGuard.enabled && config.security.accountGuard.rescanIntervalHours > 0) {
      await getRedis()
        .publish(
          RedisKeys.commandChannel,
          JSON.stringify({ action: 'accounts.rescan', guildId: guild.id }),
        )
        .catch(() => undefined);
    }

    /* ── File di log scaduti ────────────────────────────────────────── */
    // Con retention 0 il bot non cancella nulla: è il caso normale quando lo
    // spazio non è il vincolo, ed è il motivo per cui si scrive su disco.
    if (config.logging.fileSink.enabled && config.logging.fileSink.retentionDays > 0) {
      await getRedis()
        .publish(
          RedisKeys.commandChannel,
          JSON.stringify({ action: 'logs.prune', guildId: guild.id }),
        )
        .catch(() => undefined);
    }

    /* ── Ticket dimenticati ─────────────────────────────────────────── */
    if (config.integrations.tickets.enabled && config.integrations.tickets.autoCloseHours > 0) {
      await getRedis()
        .publish(
          RedisKeys.commandChannel,
          JSON.stringify({ action: 'tickets.autoclose', guildId: guild.id }),
        )
        .catch(() => undefined);
    }
  }

  await expireCases();
  await cleanupSessions();
}

/**
 * Provvedimenti a termine scaduti.
 *
 * Il timeout nativo di Discord si esaurisce da solo, ma un ban temporaneo no:
 * senza questo passaggio, un «ban di 7 giorni» resterebbe per sempre. È il
 * motivo per cui la scadenza va eseguita davvero e non solo registrata.
 */
async function expireCases(): Promise<void> {
  const prisma = getPrisma();
  const expired = await prisma.case.findMany({
    where: { status: 'ACTIVE', expiresAt: { not: null, lte: new Date() } },
    take: 200,
  });

  for (const record of expired) {
    let undone = true;

    switch (record.type) {
      case 'BAN':
        undone = await unbanMember(
          record.guildId,
          record.targetId,
          `Scadenza automatica del caso #${record.number}`,
        );
        break;

      case 'MUTE':
        // Il timeout scade da solo, ma può essere stato prolungato a mano:
        // azzerarlo esplicitamente rende lo stato coerente con il caso chiuso.
        await timeoutMember(
          record.guildId,
          record.targetId,
          0,
          `Scadenza automatica del caso #${record.number}`,
        ).catch(() => undefined);
        break;

      default:
        break;
    }

    await prisma.case
      .update({ where: { id: record.id }, data: { status: 'EXPIRED' } })
      .catch(() => undefined);

    await recordWorkerEvent({
      guildId: record.guildId,
      type: record.type === 'BAN' ? 'MOD_UNBAN' : 'MOD_CASE_UPDATED',
      targetId: record.targetId,
      summary:
        `Caso #${record.number} (${record.type}) scaduto` +
        (record.type === 'BAN'
          ? undone
            ? ' — ban revocato automaticamente'
            : ' — ⚠️ revoca del ban non riuscita, verifica i permessi del bot'
          : ''),
      payload: { caseId: record.id, undone },
    });
  }

  if (expired.length > 0) {
    log.info({ count: expired.length }, 'provvedimenti scaduti chiusi');
  }
}

/** Sessioni del pannello scadute o revocate. */
async function cleanupSessions(): Promise<void> {
  const prisma = getPrisma();
  const removed = await prisma.panelSession.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } },
      ],
    },
  });
  if (removed.count > 0) log.debug({ removed: removed.count }, 'sessioni pannello ripulite');
}

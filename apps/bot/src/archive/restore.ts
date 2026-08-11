import { EmbedBuilder, type Client, type TextChannel } from 'discord.js';
import { getPrisma } from '@angel/db';
import { childLogger } from '../core/logger.js';
import { getPersonaWebhook } from '../personas/webhooks.js';
import { recordEvent } from '../logging/auditLogger.js';

const log = childLogger('archive:restore');

/* ═══════════════════════════════════════════════════════════════════════
   RICOSTRUZIONE DI UN CANALE

   Ripubblica i messaggi archiviati tramite webhook, con il nome originale
   dell'autore. Tre cose che non sono negoziabili:

   1. **È dichiarata.** In testa al canale compare un avviso, e ogni messaggio
      porta la data originale. Una ricostruzione indistinguibile dall'originale
      sarebbe uno strumento per fabbricare prove.
   2. **Il nome dell'autore è marcato.** Il webhook usa «Nome (archivio)»: senza,
      si potrebbe far dire a chiunque qualsiasi cosa, e questo bot ha già delle
      regole severe sulle personas proprio per evitarlo.
   3. **Ritmo controllato.** Un webhook regge circa 5 messaggi ogni 2 secondi:
      andare più veloce significa solo accumulare errori 429.
   ═══════════════════════════════════════════════════════════════════════ */

export interface RestoreOptions {
  guildId: string;
  sourceChannelId: string;
  sourceChannelName: string;
  targetChannel: TextChannel;
  limit: number;
  since?: Date;
  actorId: string;
}

export interface RestoreReport {
  published: number;
  skipped: number;
  attachmentsOmitted: number;
}

/** Circa 5 messaggi ogni 2 secondi è il limite pratico di un webhook. */
const DELAY_MS = 420;

export async function restoreChannelMessages(
  client: Client,
  options: RestoreOptions,
): Promise<RestoreReport> {
  const prisma = getPrisma();

  const messages = await prisma.messageArchive.findMany({
    where: {
      guildId: options.guildId,
      channelId: options.sourceChannelId,
      ...(options.since ? { createdAt: { gte: options.since } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: options.limit,
    include: { attachments: true },
  });

  const report: RestoreReport = { published: 0, skipped: 0, attachmentsOmitted: 0 };
  if (messages.length === 0) return report;

  const webhook = await getPersonaWebhook(options.targetChannel.guild, options.targetChannel.id);
  if (!webhook) {
    log.warn({ channelId: options.targetChannel.id }, 'webhook non disponibile per la ricostruzione');
    return report;
  }

  const oldest = messages[0]!.createdAt;
  const newest = messages[messages.length - 1]!.createdAt;

  await options.targetChannel
    .send({
      embeds: [
        new EmbedBuilder()
          .setTitle('📼 Ricostruzione da archivio')
          .setColor(0xfaa61a)
          .setDescription(
            `I messaggi che seguono sono una **ricostruzione** di <#${options.sourceChannelId}> ` +
              `(#${options.sourceChannelName}), ripubblicata dall'archivio di ANGEL.\n\n` +
              '**Non sono i messaggi originali.** Sono stati inviati da un webhook, le date ' +
              'indicate sono quelle di pubblicazione originale, e gli allegati non sono inclusi.\n\n' +
              `Periodo: <t:${Math.floor(oldest.getTime() / 1000)}:f> → <t:${Math.floor(newest.getTime() / 1000)}:f>\n` +
              `Messaggi: ${messages.length} · richiesta da <@${options.actorId}>`,
          ),
      ],
    })
    .catch(() => undefined);

  for (const message of messages) {
    if (!message.content && message.attachments.length === 0) {
      report.skipped++;
      continue;
    }
    if (message.content === null) {
      // Contenuto non conservato per scelta di privacy: si salta invece di
      // pubblicare un messaggio vuoto e inutile.
      report.skipped++;
      continue;
    }

    const timestamp = `<t:${Math.floor(message.createdAt.getTime() / 1000)}:f>`;
    const notes: string[] = [];
    if (message.editedAt) notes.push('modificato');
    if (message.deletedAt) notes.push('poi eliminato');
    if (message.attachments.length > 0) {
      notes.push(
        `${message.attachments.length} allegat${message.attachments.length === 1 ? 'o' : 'i'} non ripubblicat${message.attachments.length === 1 ? 'o' : 'i'}: ` +
          message.attachments.map((attachment) => attachment.filename).join(', '),
      );
      report.attachmentsOmitted += message.attachments.length;
    }

    const body =
      `${message.content.slice(0, 1800)}\n` +
      `-# ${timestamp}${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`;

    await webhook
      .send({
        // Il suffisso è la garanzia che nessuno possa confondere una
        // ricostruzione con un messaggio autentico.
        username: `${(message.authorTag ?? message.authorId).slice(0, 60)} (archivio)`,
        content: body,
        allowedMentions: { parse: [] },
      })
      .then(() => {
        report.published++;
      })
      .catch(() => {
        report.skipped++;
      });

    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  await recordEvent(client, {
    guildId: options.guildId,
    type: 'ARCHIVE_RESTORED',
    actorId: options.actorId,
    channelId: options.targetChannel.id,
    severity: 40,
    summary:
      `Ricostruiti ${report.published} messaggi di <#${options.sourceChannelId}> ` +
      `in <#${options.targetChannel.id}>`,
    payload: {
      source: options.sourceChannelId,
      target: options.targetChannel.id,
      ...report,
    },
  });

  log.info(
    { guildId: options.guildId, published: report.published, skipped: report.skipped },
    'ricostruzione completata',
  );
  return report;
}

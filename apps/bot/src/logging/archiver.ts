import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message } from 'discord.js';
import { getPrisma } from '@angel/db';
import { contentFingerprint, type GuildConfig } from '@angel/shared';
import { childLogger } from '../core/logger.js';

const log = childLogger('archiver');

/* ═══════════════════════════════════════════════════════════════════════
   ARCHIVIAZIONE DEI MESSAGGI

   Il registro di Discord dice *che* un messaggio è stato eliminato, non cosa
   contenesse. Senza una copia propria, la domanda che si pone sempre — «cosa
   aveva scritto?» — resta senza risposta.

   Vale anche per gli allegati: gli URL della CDN Discord smettono di
   funzionare quando il messaggio sparisce, quindi le immagini vanno salvate sul
   volume locale o le prove svaniscono proprio quando servono.

   Tutto questo ha un costo in termini di privacy, e per questo la modalità è
   configurabile: FULL, HASHED (solo impronta, riconosce i duplicati senza
   conservare il testo), METADATA_ONLY, o niente affatto.
   ═══════════════════════════════════════════════════════════════════════ */

const IMAGE_TYPES = /^image\//i;

export async function archiveMessage(message: Message, config: GuildConfig): Promise<void> {
  if (!message.guild) return;
  const mode = config.logging.messageContent;
  if (mode === 'CHANNEL_ONLY') return;
  if (config.logging.ignoredChannelIds.includes(message.channelId)) return;
  if (config.logging.ignoreBots && message.author.bot) return;

  const prisma = getPrisma();
  const content = message.content ?? '';

  await prisma.messageArchive
    .upsert({
      where: { id: message.id },
      create: {
        id: message.id,
        guildId: message.guild.id,
        channelId: message.channelId,
        authorId: message.author.id,
        authorTag: message.author.tag,
        content: mode === 'FULL' ? content.slice(0, 4000) : null,
        fingerprint: content && mode !== 'METADATA_ONLY' ? contentFingerprint(content) : null,
        embeds: message.embeds.map((embed) => embed.toJSON()) as unknown as object,
        stickers: message.stickers.map((sticker) => ({
          id: sticker.id,
          name: sticker.name,
        })) as unknown as object,
        replyToId: message.reference?.messageId ?? null,
        threadId: message.hasThread ? message.thread?.id : null,
        createdAt: message.createdAt,
      },
      update: {},
    })
    .catch((error) => log.debug({ err: error }, 'archiviazione messaggio fallita'));

  if (config.logging.archiveAttachments && message.attachments.size > 0) {
    await archiveAttachments(message, config).catch((error) =>
      log.debug({ err: error }, 'archiviazione allegati fallita'),
    );
  }
}

async function archiveAttachments(message: Message, config: GuildConfig): Promise<void> {
  const prisma = getPrisma();
  const maxBytes = config.logging.maxAttachmentSizeMb * 1024 * 1024;
  const storageRoot = process.env.STORAGE_DIR ?? './storage';

  for (const attachment of message.attachments.values()) {
    if (attachment.size > maxBytes) {
      // Oltre il limite si conservano comunque i metadati: sapere che è stato
      // inviato un file da 80 MB è di per sé un'informazione.
      await prisma.attachmentArchive
        .create({
          data: {
            guildId: message.guild!.id,
            messageId: message.id,
            filename: attachment.name,
            contentType: attachment.contentType ?? null,
            sizeBytes: attachment.size,
            width: attachment.width ?? null,
            height: attachment.height ?? null,
          },
        })
        .catch(() => undefined);
      continue;
    }

    const buffer = await downloadAttachment(attachment.url);
    if (!buffer) continue;

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    // Suddivisione in sottocartelle per i primi due caratteri dell'hash:
    // decine di migliaia di file in una sola directory rendono lente anche le
    // operazioni più banali.
    const relativePath = path.join(
      message.guild!.id,
      sha256.slice(0, 2),
      `${sha256}${path.extname(attachment.name)}`,
    );
    const absolutePath = path.join(storageRoot, relativePath);

    try {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, buffer, { flag: 'wx' });
    } catch (error) {
      // wx fallisce se il file esiste già: è deduplicazione, non un errore.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.debug({ err: error }, 'scrittura allegato fallita');
        continue;
      }
    }

    await prisma.attachmentArchive
      .create({
        data: {
          guildId: message.guild!.id,
          messageId: message.id,
          filename: attachment.name,
          contentType: attachment.contentType ?? null,
          sizeBytes: attachment.size,
          storagePath: relativePath,
          sha256,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          verdict: IMAGE_TYPES.test(attachment.contentType ?? '') ? 'UNSCANNED' : 'UNSCANNED',
        },
      })
      .catch(() => undefined);
  }
}

async function downloadAttachment(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** Marca un messaggio come eliminato e restituisce ciò che era stato salvato. */
export async function markDeleted(messageId: string, deletedBy: string | null) {
  const prisma = getPrisma();
  const existing = await prisma.messageArchive.findUnique({ where: { id: messageId } });
  if (!existing) return null;

  await prisma.messageArchive
    .update({
      where: { id: messageId },
      data: { deletedAt: new Date(), deletedBy },
    })
    .catch(() => undefined);

  return existing;
}

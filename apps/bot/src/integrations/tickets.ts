import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  OverwriteType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildChannel,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { buildTranscript, getPrisma } from '@angel/db';
import type { GuildConfig } from '@angel/shared';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';
import { getRedis } from '../core/redis.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const log = childLogger('tickets');

/**
 * Salva la trascrizione sul disco della macchina e restituisce il percorso
 * relativo a `STORAGE_DIR`.
 *
 * Su disco e non solo su Discord: un allegato vive finché vive il messaggio
 * che lo porta, e un messaggio si può eliminare — anche per sbaglio, anche da
 * chi aveva ragione di farlo. La copia sulla VPS è quella che resta, ed è
 * quella che il pannello serve.
 *
 * Il percorso è relativo di proposito: salvarlo assoluto legherebbe il
 * database alla cartella di questa installazione, e al primo spostamento del
 * volume nessun file risulterebbe più trovabile.
 */
async function salvaTrascrizione(
  guildId: string,
  nomeFile: string,
  html: string,
): Promise<string> {
  const radice = process.env.STORAGE_DIR ?? './storage';
  const relativo = path.posix.join('trascrizioni', guildId);
  const cartella = path.join(radice, relativo);

  await fs.mkdir(cartella, { recursive: true });
  await fs.writeFile(path.join(cartella, nomeFile), html, 'utf8');

  return path.posix.join(relativo, nomeFile);
}

/* ═══════════════════════════════════════════════════════════════════════
   TICKET

   Una conversazione privata fra un utente e lo staff, dentro il server invece
   che nei DM. La differenza non è di comodità:

   • nei DM non c'è registro, e una contestazione diventa parola contro parola;
   • nei DM non esiste passaggio di consegne fra moderatori;
   • soprattutto, nei DM **nessuno può verificare chi sta scrivendo**. È
     esattamente lì che opera chi si finge staff.

   Alla chiusura resta la trascrizione, che è l'unica parte che serve dopo.
   ═══════════════════════════════════════════════════════════════════════ */

/** Numerazione progressiva per server, come per i casi. */
async function nextTicketNumber(guildId: string): Promise<number> {
  const redis = getRedis();
  const key = `ticket:seq:${guildId}`;

  if (!(await redis.exists(key))) {
    const prisma = getPrisma();
    const last = await prisma.ticket.findFirst({
      where: { guildId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    await redis.set(key, String(last?.number ?? 0), 'NX');
  }
  return redis.incr(key);
}

/** Pubblica il pannello con il pulsante di apertura. */
export async function publishTicketPanel(
  guild: Guild,
  channel: TextChannel,
  config: GuildConfig,
): Promise<string | null> {
  const embed = new EmbedBuilder()
    .setTitle('Assistenza')
    .setColor(0x5865f2)
    .setDescription(
      'Premi il pulsante per aprire una richiesta privata con lo staff.\n\n' +
        'Verrà creato un canale visibile solo a te e ai moderatori. ' +
        '**Lo staff non ti contatterà mai per primo in privato** per chiederti ' +
        'token, password o codici: se succede, non è lo staff.',
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('aegis:ticket:open')
      .setLabel('Apri un ticket')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎫'),
  );

  const message = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  void config;
  void guild;
  return message?.id ?? null;
}

export interface OpenResult {
  ok: boolean;
  reason?: string;
  channelId?: string;
  number?: number;
}

export async function openTicket(
  client: Client,
  guild: Guild,
  member: GuildMember,
  subject: string,
  config: GuildConfig,
): Promise<OpenResult> {
  const settings = config.integrations.tickets;
  if (!settings.enabled) return { ok: false, reason: 'Il modulo ticket è disattivato.' };

  const prisma = getPrisma();

  const open = await prisma.ticket.count({
    where: { guildId: guild.id, openerId: member.id, status: 'OPEN' },
  });
  if (open >= settings.maxOpenPerUser) {
    return {
      ok: false,
      reason:
        `Hai già ${open} ticket aperti (massimo ${settings.maxOpenPerUser}). ` +
        'Chiudi quello in corso prima di aprirne un altro.',
    };
  }

  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { ok: false, reason: 'Il bot non può creare canali: manca il permesso ManageChannels.' };
  }

  const number = await nextTicketNumber(guild.id);

  // I permessi del canale sono espliciti e restrittivi: @everyone escluso,
  // l'autore e i ruoli di supporto ammessi. Ereditare dalla categoria sarebbe
  // più corto ma renderebbe la visibilità dipendente da una configurazione
  // altrove, che è il modo classico in cui un ticket privato smette di esserlo.
  const channel = await guild.channels
    .create({
      name: `ticket-${String(number).padStart(4, '0')}`,
      type: ChannelType.GuildText,
      parent: settings.categoryId ?? undefined,
      topic: `Ticket #${number} di ${member.user.tag} · ${subject.slice(0, 200)}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
          ],
        },
        ...settings.supportRoleIds.map((roleId) => ({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        })),
      ],
      reason: `Ticket #${number} aperto da ${member.user.tag}`,
    })
    .catch((error: Error) => {
      log.warn({ err: error, guildId: guild.id }, 'creazione canale ticket fallita');
      return null;
    });

  if (!channel) return { ok: false, reason: 'Creazione del canale fallita.' };

  await prisma.ticket.create({
    data: {
      guildId: guild.id,
      number,
      channelId: channel.id,
      openerId: member.id,
      subject: subject.slice(0, 500),
    },
  });

  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`aegis:ticket:claim:${number}`)
      .setLabel('Prendi in carico')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🙋'),
    new ButtonBuilder()
      .setCustomId(`aegis:ticket:close:${number}`)
      .setLabel('Chiudi')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );

  await channel.send({
    content:
      settings.pingSupport && settings.supportRoleIds.length > 0
        ? settings.supportRoleIds.map((roleId) => `<@&${roleId}>`).join(' ')
        : undefined,
    embeds: [
      new EmbedBuilder()
        .setTitle(`Ticket #${number}`)
        .setColor(0x5865f2)
        .setDescription(`**Oggetto:** ${subject.slice(0, 500)}\n\n${settings.welcomeMessage}`)
        .addFields({ name: 'Aperto da', value: `<@${member.id}>`, inline: true })
        .setTimestamp(),
    ],
    components: [controls],
    allowedMentions: { roles: settings.supportRoleIds, users: [member.id] },
  });

  await recordEvent(client, {
    guildId: guild.id,
    type: 'TICKET_OPENED',
    actorId: member.id,
    actorTag: member.user.tag,
    channelId: channel.id,
    summary: `Ticket **#${number}** aperto: ${subject.slice(0, 150)}`,
    payload: { ticketNumber: number, subject },
  });

  return { ok: true, channelId: channel.id, number };
}

export async function claimTicket(
  client: Client,
  guild: Guild,
  number: number,
  staff: GuildMember,
): Promise<boolean> {
  const prisma = getPrisma();
  const ticket = await prisma.ticket.findUnique({
    where: { guildId_number: { guildId: guild.id, number } },
  });
  if (!ticket || ticket.status !== 'OPEN' || ticket.claimedBy) return false;

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { claimedBy: staff.id, claimedAt: new Date() },
  });

  await recordEvent(client, {
    guildId: guild.id,
    type: 'TICKET_CLAIMED',
    actorId: staff.id,
    actorTag: staff.user.tag,
    channelId: ticket.channelId,
    summary: `Ticket **#${number}** preso in carico da <@${staff.id}>`,
    payload: { ticketNumber: number },
  });
  return true;
}

/**
 * Chiusura.
 *
 * La trascrizione si genera **prima** di eliminare il canale: dopo, i messaggi
 * archiviati resterebbero nel database ma il canale sparirebbe, e con esso il
 * contesto. Viene inviata all'autore in privato e allegata al registro.
 */
export async function closeTicket(
  client: Client,
  guild: Guild,
  number: number,
  closedBy: string,
  reason: string,
  config: GuildConfig,
  /**
   * Il canale, quando non è più nella cache perché è appena stato eliminato.
   * È l'unico modo di sapere ancora chi era stato aggiunto al ticket: gli
   * inviti sono permessi per singola persona sul canale, e il canale non c'è
   * più.
   */
  canaleEliminato?: GuildChannel | null,
): Promise<boolean> {
  const prisma = getPrisma();
  const ticket = await prisma.ticket.findUnique({
    where: { guildId_number: { guildId: guild.id, number } },
  });
  if (!ticket || ticket.status !== 'OPEN') return false;

  const settings = config.integrations.tickets;
  let transcriptFile: AttachmentBuilder | null = null;
  let messageCount = 0;

  let transcriptPath: string | null = null;

  if (settings.transcriptOnClose && ticket.channelId) {
    const channel = guild.channels.cache.get(ticket.channelId) ?? canaleEliminato ?? null;

    // Chi è stato aggiunto al canale oltre a chi lo ha aperto: sono permessi
    // per singola persona, e nel canale di un ticket ce ne sono solo perché
    // qualcuno ce li ha messi. Il perché di quell'aggiunta è spesso la
    // domanda che ci si pone rileggendo mesi dopo.
    const invitati: { id: string; tag?: string | null }[] = [];
    if (channel && 'permissionOverwrites' in channel) {
      for (const overwrite of channel.permissionOverwrites.cache.values()) {
        if (overwrite.type !== OverwriteType.Member) continue;
        if (overwrite.id === ticket.openerId) continue;
        if (overwrite.id === client.user?.id) continue;
        const membro = await guild.members.fetch(overwrite.id).catch(() => null);
        invitati.push({ id: overwrite.id, tag: membro?.user.tag ?? null });
      }
    }

    const [apertoDa, presoDa, chiusoDa] = await Promise.all([
      client.users.fetch(ticket.openerId).catch(() => null),
      ticket.claimedBy ? client.users.fetch(ticket.claimedBy).catch(() => null) : null,
      client.users.fetch(closedBy).catch(() => null),
    ]);

    const result = await buildTranscript({
      guildId: guild.id,
      channelId: ticket.channelId,
      channelName: channel?.name ?? `ticket-${number}`,
      guildName: guild.name,
      limit: 5000,
      includeDeleted: true,
      ticket: {
        number,
        subject: ticket.subject,
        openerId: ticket.openerId,
        openerTag: apertoDa?.tag ?? null,
        claimedBy: ticket.claimedBy,
        claimedByTag: presoDa?.tag ?? null,
        claimedAt: ticket.claimedAt,
        closedBy,
        closedByTag: chiusoDa?.tag ?? null,
        closedAt: new Date(),
        closeReason: reason,
        createdAt: ticket.createdAt,
        invitati,
      },
    }).catch(() => null);

    if (result) {
      messageCount = result.messageCount;
      const nome = `ticket-${String(number).padStart(4, '0')}.html`;

      transcriptFile = new AttachmentBuilder(Buffer.from(result.html, 'utf8'), { name: nome });

      // Su disco prima ancora che su Discord: un allegato Discord vive finché
      // vive il messaggio, e un messaggio si può cancellare. Il file sulla VPS
      // è la copia che resta.
      transcriptPath = await salvaTrascrizione(guild.id, nome, result.html).catch(
        (errore: unknown) => {
          log.warn({ err: errore, ticket: number }, 'trascrizione non salvata su disco');
          return null;
        },
      );
    }
  }

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      closedBy,
      closeReason: reason.slice(0, 500),
      messageCount,
      transcriptPath,
    },
  });

  // La trascrizione all'autore: è la sua conversazione, e senza copia
  // resterebbe con nulla in mano.
  const opener = await client.users.fetch(ticket.openerId).catch(() => null);
  if (opener && transcriptFile) {
    await opener
      .send({
        content:
          `Il tuo ticket **#${number}** in **${guild.name}** è stato chiuso.\n` +
          `Motivo: ${reason}\n\nIn allegato la trascrizione completa.`,
        files: [transcriptFile],
      })
      .catch(() => undefined);
  }

  // Copia nel canale dedicato: è l'archivio che lo staff consulta senza
  // aprire il pannello, e sopravvive alla persona che ha chiuso il ticket.
  if (settings.transcriptChannelId && transcriptFile) {
    const archivio = await client.channels
      .fetch(settings.transcriptChannelId)
      .catch(() => null);

    if (archivio?.isTextBased() && 'send' in archivio) {
      const durata = Math.max(1, Math.round((Date.now() - ticket.createdAt.getTime()) / 60000));
      await archivio
        .send({
          content:
            `📄 **Ticket #${String(number).padStart(4, '0')}** — ${ticket.subject}
` +
            `Aperto da <@${ticket.openerId}> · ` +
            (ticket.claimedBy ? `preso in carico da <@${ticket.claimedBy}> · ` : 'mai preso in carico · ') +
            `chiuso da <@${closedBy}>
` +
            `Motivo: ${reason.slice(0, 300)}
` +
            `-# ${messageCount} messaggi · durata ${durata} minuti` +
            (transcriptPath ? ` · copia sulla VPS` : ''),
          files: [new AttachmentBuilder(Buffer.from(transcriptFile.attachment as Buffer), {
            name: `ticket-${String(number).padStart(4, '0')}.html`,
          })],
          allowedMentions: { parse: [] },
        })
        .catch((errore: unknown) =>
          log.warn({ err: errore }, 'trascrizione non pubblicata nel canale dedicato'),
        );
    }
  }

  await recordEvent(client, {
    guildId: guild.id,
    type: 'TICKET_CLOSED',
    actorId: closedBy,
    targetId: ticket.openerId,
    channelId: ticket.channelId,
    summary:
      `Ticket **#${number}** chiuso da <@${closedBy}>\n` +
      `Motivo: ${reason}\n${messageCount} messaggi nella trascrizione`,
    payload: { ticketNumber: number, messageCount, reason },
  });

  if (ticket.channelId) {
    const channel = guild.channels.cache.get(ticket.channelId);
    // Ritardo prima di eliminare: chi sta leggendo deve vedere il messaggio di
    // chiusura, non ritrovarsi il canale sparito sotto gli occhi.
    if (channel) {
      await (channel as TextChannel)
        .send('🔒 Ticket chiuso. Il canale verrà eliminato fra 10 secondi.')
        .catch(() => undefined);
      setTimeout(() => {
        void channel.delete(`Ticket #${number} chiuso`).catch(() => undefined);
      }, 10_000);
    }
  }

  return true;
}

/**
 * Chiusura automatica dei ticket inattivi.
 *
 * Un ticket dimenticato aperto per settimane è rumore che nasconde quelli veri:
 * chi guarda l'elenco smette di distinguere le richieste in corso da quelle
 * abbandonate.
 */
export async function closeInactiveTickets(
  client: Client,
  guild: Guild,
  config: GuildConfig,
): Promise<number> {
  const settings = config.integrations.tickets;
  if (!settings.enabled || settings.autoCloseHours === 0) return 0;

  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - settings.autoCloseHours * 3_600_000);

  const stale = await prisma.ticket.findMany({
    where: { guildId: guild.id, status: 'OPEN', createdAt: { lt: cutoff } },
    take: 20,
  });

  let closed = 0;
  for (const ticket of stale) {
    // Si controlla l'ultima attività reale nel canale, non la data di
    // apertura: un ticket vecchio ma ancora vivo non va chiuso.
    const lastMessage = await prisma.messageArchive.findFirst({
      where: { guildId: guild.id, channelId: ticket.channelId ?? '' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const lastActivity = lastMessage?.createdAt ?? ticket.createdAt;
    if (lastActivity >= cutoff) continue;

    const done = await closeTicket(
      client,
      guild,
      ticket.number,
      client.user?.id ?? 'system',
      `Chiusura automatica dopo ${settings.autoCloseHours} ore di inattività`,
      config,
    );
    if (done) closed++;
  }

  return closed;
}

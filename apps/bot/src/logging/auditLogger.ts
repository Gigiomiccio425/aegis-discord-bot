import {
  ChannelType,
  type APIEmbedField,
  type Client,
  type EmbedBuilder,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { getPrisma } from '@aegis/db';
import {
  CRITICAL_EVENTS,
  EVENT_CATEGORY,
  RedisKeys,
  type GuildConfig,
  type LogEventType,
} from '@aegis/shared';
import { getGuildConfig } from '../core/config.js';
import { getPublisher } from '../core/redis.js';
import { childLogger } from '../core/logger.js';
import { buildLogEmbed } from './formatters.js';
import { writeToFile } from './fileSink.js';
import { isWatched } from '../security/watchlist.js';

const log = childLogger('audit');

export interface AuditInput {
  guildId: string;
  type: LogEventType;
  actorId?: string | null;
  actorTag?: string | null;
  targetId?: string | null;
  targetTag?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  roleId?: string | null;
  summary?: string;
  payload?: Record<string, unknown>;
  severity?: number;
  automated?: boolean;
  caseId?: string | null;
  /** Campi aggiuntivi mostrati nell'embed del canale di log. */
  fields?: APIEmbedField[];
}

/**
 * Punto unico di registrazione.
 *
 * Tre destinazioni: Postgres (ricercabile dal pannello), il canale Discord
 * della categoria, e il feed live via Redis. Se una fallisce le altre
 * proseguono — perdere un log non deve mai far fallire l'azione di moderazione
 * che lo ha generato.
 */
export async function recordEvent(client: Client, input: AuditInput): Promise<void> {
  const config = await getGuildConfig(input.guildId).catch(() => null);
  if (!config) return;

  const category = EVENT_CATEGORY[input.type];
  const isCritical = CRITICAL_EVENTS.includes(input.type);

  // I filtri non valgono per gli eventi critici: chi disattiva una categoria
  // vuole meno rumore, non rinunciare all'allarme di un raid.
  if (!isCritical) {
    if (!config.logging.enabled) return;
    if (config.logging.disabledCategories.includes(category)) return;
    if (input.channelId && config.logging.ignoredChannelIds.includes(input.channelId)) return;
    if (input.actorId && config.logging.ignoredUserIds.includes(input.actorId)) return;
  }

  const createdAt = new Date();

  // Utente attenzionato: l'evento resta identico nel database, ma viene messo
  // in evidenza e non passa mai dal raggruppamento. Chi ha chiesto di
  // sorvegliare qualcuno vuole vederlo subito, non fra cinque secondi in fondo
  // a un blocco di dieci embed.
  const watchedId = await firstWatched(input).catch(() => null);
  if (watchedId) {
    input = {
      ...input,
      severity: Math.max(input.severity ?? 0, 60),
      summary: `👁️ **Utente attenzionato** <@${watchedId}>\n${input.summary ?? ''}`.trim(),
      payload: { ...(input.payload ?? {}), watched: watchedId },
    };
  }

  await persistEvent(input, category, createdAt).catch((error) => {
    log.error({ err: error, type: input.type }, 'salvataggio evento fallito');
  });

  // Copia su disco: è sincrona e bufferizzata, quindi non aggiunge attesa.
  // Sta qui e non dopo le altre destinazioni perché è la più affidabile — se
  // Discord o Redis non rispondono, sul file l'evento c'è comunque.
  try {
    writeToFile(
      {
        guildId: input.guildId,
        type: input.type,
        category,
        createdAt,
        actorId: input.actorId,
        actorTag: input.actorTag,
        targetId: input.targetId,
        targetTag: input.targetTag,
        channelId: input.channelId,
        messageId: input.messageId,
        severity: input.severity,
        automated: input.automated,
        summary: input.summary,
        payload: input.payload,
      },
      config.logging.fileSink,
    );
  } catch (error) {
    log.debug({ err: error }, 'scrittura su file fallita');
  }

  await publishLive(input, category, createdAt).catch(() => undefined);

  await deliverToChannel(
    client,
    input,
    config,
    category,
    createdAt,
    isCritical || watchedId !== null,
  ).catch((error) => {
    log.debug({ err: error, type: input.type }, 'invio al canale di log fallito');
  });
}

/**
 * Chi fra attore e bersaglio è sotto sorveglianza, se qualcuno lo è.
 *
 * Si controlla anche il bersaglio e non solo l'attore: se un utente
 * attenzionato viene bandito, quella è precisamente l'informazione che chi lo
 * sorvegliava sta aspettando.
 */
async function firstWatched(input: AuditInput): Promise<string | null> {
  for (const id of [input.actorId, input.targetId]) {
    if (id && (await isWatched(input.guildId, id))) return id;
  }
  return null;
}

async function persistEvent(
  input: AuditInput,
  category: string,
  createdAt: Date,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.auditEvent.create({
    data: {
      guildId: input.guildId,
      type: input.type,
      category,
      createdAt,
      actorId: input.actorId ?? null,
      actorTag: input.actorTag ?? null,
      targetId: input.targetId ?? null,
      targetTag: input.targetTag ?? null,
      channelId: input.channelId ?? null,
      messageId: input.messageId ?? null,
      roleId: input.roleId ?? null,
      summary: input.summary ?? null,
      payload: (input.payload ?? {}) as object,
      severity: input.severity ?? 0,
      automated: input.automated ?? false,
      caseId: input.caseId ?? null,
    },
  });
}

/** Feed live del pannello: fire-and-forget, non deve mai bloccare. */
async function publishLive(
  input: AuditInput,
  category: string,
  createdAt: Date,
): Promise<void> {
  const publisher = getPublisher();
  await publisher.publish(
    RedisKeys.eventChannel,
    JSON.stringify({
      guildId: input.guildId,
      type: input.type,
      category,
      createdAt: createdAt.toISOString(),
      actorId: input.actorId ?? null,
      targetId: input.targetId ?? null,
      channelId: input.channelId ?? null,
      summary: input.summary ?? null,
      severity: input.severity ?? 0,
    }),
  );
}

/* ── Consegna sul canale Discord, con accorpamento ────────────────────── */

interface PendingBatch {
  embeds: EmbedBuilder[];
  timer: NodeJS.Timeout;
}

/**
 * Gli eventi ad alta frequenza (messaggi, reazioni, voce) vengono accorpati:
 * un embed per evento significa un messaggio al secondo in un server attivo, e
 * il rate limit di Discord farebbe accumulare ritardo fino a rendere il log
 * inutile proprio durante un attacco.
 */
const batches = new Map<string, PendingBatch>();

/**
 * Le sole categorie che vale la pena accorpare: quelle che in un server attivo
 * producono decine di eventi al minuto.
 *
 * Moderazione, sicurezza, ruoli, canali e webhook restano immediati. Sono rari
 * e sono esattamente quelli che qualcuno sta aspettando di vedere.
 */
const BATCHED_CATEGORIES = new Set(['MESSAGE', 'REACTION', 'VOICE']);

async function deliverToChannel(
  client: Client,
  input: AuditInput,
  config: GuildConfig,
  category: string,
  createdAt: Date,
  isCritical: boolean,
): Promise<void> {
  const channelId = resolveChannel(config, category, input.type);
  if (!channelId) return;

  const embed = buildLogEmbed(
    {
      type: input.type,
      createdAt,
      actorId: input.actorId,
      actorTag: input.actorTag,
      targetId: input.targetId,
      targetTag: input.targetTag,
      channelId: input.channelId,
      messageId: input.messageId,
      summary: input.summary,
      severity: input.severity,
      fields: input.fields,
      guildId: input.guildId,
    },
    { showUserIds: config.logging.showUserIds },
  );

  // Gli eventi critici saltano la coda: durante un nuke i secondi contano.
  // E con loro tutto ciò che non è ad alta frequenza: accodare un ban per
  // cinque secondi non fa risparmiare nulla — non ce ne sono cento al minuto —
  // e fa sembrare il registro lento proprio dove si guarda per primo.
  if (isCritical || config.logging.batchSeconds === 0 || !BATCHED_CATEGORIES.has(category)) {
    await sendEmbeds(client, channelId, [embed], isCritical ? config : undefined);
    return;
  }

  const key = `${input.guildId}:${channelId}`;
  const existing = batches.get(key);
  if (existing) {
    existing.embeds.push(embed);
    // Il limite di Discord è 10 embed per messaggio.
    if (existing.embeds.length >= 10) {
      clearTimeout(existing.timer);
      batches.delete(key);
      await sendEmbeds(client, channelId, existing.embeds);
    }
    return;
  }

  const batch: PendingBatch = {
    embeds: [embed],
    timer: setTimeout(() => {
      const pending = batches.get(key);
      batches.delete(key);
      if (pending) void sendEmbeds(client, channelId, pending.embeds);
    }, config.logging.batchSeconds * 1000),
  };
  batches.set(key, batch);
}

function resolveChannel(
  config: GuildConfig,
  category: string,
  type: LogEventType,
): string | null {
  // Canale unico: le rotte per categoria restano salvate ma non vengono lette.
  // L'unica eccezione è il canale degli alert, che ha senso tenere separato
  // anche in questo modo — chi lo configura vuole poterlo seguire senza
  // scorrere il registro ordinario.
  if (config.logging.singleChannel) {
    if (category === 'SECURITY' && config.general.alertChannelId) {
      return config.general.alertChannelId;
    }
    return config.logging.defaultChannelId;
  }

  const route = config.logging.routes[category as keyof typeof config.logging.routes];
  if (route) {
    if (!route.enabled) return null;
    if (route.excludeTypes.includes(type)) return null;
    if (route.channelId) return route.channelId;
  }
  // Gli eventi di sicurezza hanno un canale dedicato se configurato.
  if (category === 'SECURITY' && config.general.alertChannelId) {
    return config.general.alertChannelId;
  }
  return config.logging.defaultChannelId;
}

async function sendEmbeds(
  client: Client,
  channelId: string,
  embeds: EmbedBuilder[],
  mentionConfig?: GuildConfig,
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const content = mentionConfig?.general.alertRoleId
      ? `<@&${mentionConfig.general.alertRoleId}>`
      : undefined;

    await (channel as TextChannel).send({
      content,
      embeds,
      allowedMentions: content ? { roles: [mentionConfig!.general.alertRoleId!] } : { parse: [] },
    });
  } catch (error) {
    log.debug({ err: error, channelId }, 'impossibile scrivere sul canale di log');
  }
}

/** Svuota le code in sospeso: usata allo spegnimento per non perdere eventi. */
export async function flushBatches(client: Client): Promise<void> {
  const pending = [...batches.entries()];
  batches.clear();
  await Promise.allSettled(
    pending.map(async ([key, batch]) => {
      clearTimeout(batch.timer);
      const channelId = key.split(':')[1];
      if (channelId) await sendEmbeds(client, channelId, batch.embeds);
    }),
  );
}

/** Scorciatoia per gli alert di sicurezza con menzione allo staff. */
export async function alertStaff(
  client: Client,
  guild: Guild,
  input: Omit<AuditInput, 'guildId'>,
): Promise<void> {
  await recordEvent(client, { ...input, guildId: guild.id, severity: input.severity ?? 70 });
}

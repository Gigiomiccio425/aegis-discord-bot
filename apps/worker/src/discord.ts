import { REST, Routes } from 'discord.js';
import { getPrisma } from '@angel/db';
import { EVENT_CATEGORY, RedisKeys, type LogEventType } from '@angel/shared';
import { getRedis } from './redis.js';
import { childLogger } from './logger.js';

const log = childLogger('discord');

let rest: REST | null = null;

/**
 * Il worker non apre una connessione al gateway: usa solo le API REST.
 *
 * Una seconda connessione gateway consumerebbe una sessione, riceverebbe
 * eventi che nessuno gestisce e complicherebbe lo sharding. Per eliminare un
 * messaggio o scrivere in un canale bastano le REST.
 */
export function getRest(): REST {
  if (rest) return rest;
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN non impostato');
  rest = new REST({ version: '10' }).setToken(token);
  return rest;
}

export async function deleteMessage(
  channelId: string,
  messageId: string,
  reason: string,
): Promise<boolean> {
  try {
    await getRest().delete(Routes.channelMessage(channelId, messageId), { reason });
    return true;
  } catch (error) {
    // 10008 = messaggio già eliminato: non è un errore.
    const code = (error as { code?: number }).code;
    if (code === 10008) return true;
    log.debug({ err: error, channelId, messageId }, 'eliminazione messaggio fallita');
    return false;
  }
}

export async function sendMessage(
  channelId: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  try {
    const result = (await getRest().post(Routes.channelMessages(channelId), {
      body: payload,
    })) as { id: string };
    return result.id;
  } catch (error) {
    log.debug({ err: error, channelId }, 'invio messaggio fallito');
    return null;
  }
}

/**
 * Manda un messaggio privato.
 *
 * Due chiamate e non una: Discord non permette di scrivere a un utente per ID,
 * bisogna prima aprire (o riaprire) il canale privato. Restituisce `false` se
 * la persona ha i messaggi privati chiusi, che non è un errore ma una scelta
 * legittima — e chi chiama deve poterla distinguere da un guasto.
 */
export async function inviaInPrivato(
  userId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const canale = (await getRest().post(Routes.userChannels(), {
      body: { recipient_id: userId },
    })) as { id: string };

    await getRest().post(Routes.channelMessages(canale.id), { body: payload });
    return true;
  } catch (error) {
    log.debug({ err: error, userId }, 'messaggio privato non consegnato');
    return false;
  }
}

/**
 * Dà o toglie un ruolo a un membro.
 *
 * Le REST bastano: aggiungere un ruolo è una chiamata sola e non richiede la
 * cache dei membri, che il worker non ha e non deve avere.
 */
export async function setMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
  attivo: boolean,
  reason: string,
): Promise<boolean> {
  try {
    const route = Routes.guildMemberRole(guildId, userId, roleId);
    if (attivo) await getRest().put(route, { reason });
    else await getRest().delete(route, { reason });
    return true;
  } catch (error) {
    // 10007 = membro non nel server, 10011 = ruolo inesistente: sono
    // configurazioni rimaste indietro, non guasti da segnalare come errori.
    const code = (error as { code?: number }).code;
    if (code === 10007 || code === 10011) return false;
    log.debug({ err: error, guildId, userId, roleId }, 'assegnazione ruolo fallita');
    return false;
  }
}

/** `seconds = 0` rimuove il silenziamento invece di impostarne uno di durata nulla. */
export async function timeoutMember(
  guildId: string,
  userId: string,
  seconds: number,
  reason: string,
): Promise<boolean> {
  try {
    await getRest().patch(Routes.guildMember(guildId, userId), {
      body: {
        communication_disabled_until:
          seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null,
      },
      reason,
    });
    return true;
  } catch (error) {
    log.debug({ err: error, guildId, userId }, 'timeout fallito');
    return false;
  }
}

export async function unbanMember(
  guildId: string,
  userId: string,
  reason: string,
): Promise<boolean> {
  try {
    await getRest().delete(Routes.guildBan(guildId, userId), { reason });
    return true;
  } catch (error) {
    // 10026 = ban inesistente: già revocato a mano, non è un errore.
    const code = (error as { code?: number }).code;
    if (code === 10026) return true;
    log.debug({ err: error, guildId, userId }, 'revoca ban fallita');
    return false;
  }
}

export interface WorkerAuditInput {
  guildId: string;
  type: LogEventType;
  actorId?: string | null;
  targetId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  summary?: string;
  payload?: Record<string, unknown>;
  severity?: number;
}

/**
 * Registrazione di un evento dal worker.
 *
 * Scrive su Postgres e pubblica sul feed live. La consegna al canale Discord
 * avviene qui solo per gli eventi rilevanti: il worker non ha la cache dei
 * canali e non deve replicare il router del bot.
 */
export async function recordWorkerEvent(input: WorkerAuditInput): Promise<void> {
  const prisma = getPrisma();
  const category = EVENT_CATEGORY[input.type];

  await prisma.auditEvent
    .create({
      data: {
        guildId: input.guildId,
        type: input.type,
        category,
        actorId: input.actorId ?? null,
        targetId: input.targetId ?? null,
        channelId: input.channelId ?? null,
        messageId: input.messageId ?? null,
        summary: input.summary ?? null,
        payload: (input.payload ?? {}) as object,
        severity: input.severity ?? 0,
        automated: true,
      },
    })
    .catch((error) => log.error({ err: error }, 'salvataggio evento fallito'));

  await getRedis()
    .publish(
      RedisKeys.eventChannel,
      JSON.stringify({
        guildId: input.guildId,
        type: input.type,
        category,
        createdAt: new Date().toISOString(),
        actorId: input.actorId ?? null,
        summary: input.summary ?? null,
        severity: input.severity ?? 0,
      }),
    )
    .catch(() => undefined);
}

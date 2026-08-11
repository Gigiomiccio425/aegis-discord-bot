import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
  type Webhook,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import { FORBIDDEN_PERSONA_PATTERNS, nameSimilarity, type GuildConfig } from '@angel/shared';
import { registerManagedWebhook } from '../security/webhookGuard.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('personas');

/* ═══════════════════════════════════════════════════════════════════════
   PERSONAS

   Il "finto utente" che parla in chat con nome e immagine propri è un webhook:
   Discord consente di sovrascrivere username e avatar per singolo messaggio.
   Non serve creare account, e non è possibile farlo in altro modo.

   Un solo webhook per canale, riusato da tutte le personas: il limite di
   Discord è di 15 webhook per canale, e crearne uno per persona lo
   esaurirebbe in fretta.

   Due vincoli non negoziabili:
     • una persona non può imitare lo staff reale né Discord — sarebbe uno
       strumento di truffa confezionato;
     • ogni messaggio resta attribuito in `AuditEvent` all'utente umano che ha
       lanciato il comando. Una persona non è mai anonimato.
   ═══════════════════════════════════════════════════════════════════════ */

const WEBHOOK_NAME = 'ANGEL Personas';

/** Cache dei webhook per canale: evita una chiamata API a ogni messaggio. */
const webhookCache = new Map<string, Webhook>();

export async function getPersonaWebhook(
  guild: Guild,
  channelId: string,
): Promise<Webhook | null> {
  const cached = webhookCache.get(channelId);
  if (cached) return cached;

  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) return null;

  const me = await guild.members.fetchMe();
  if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
    log.warn({ channelId }, 'permesso ManageWebhooks assente nel canale');
    return null;
  }

  const existing = await (channel as TextChannel).fetchWebhooks().catch(() => null);
  const own = existing?.find(
    (webhook) => webhook.owner?.id === guild.client.user.id && webhook.name === WEBHOOK_NAME,
  );

  if (own) {
    webhookCache.set(channelId, own);
    await registerManagedWebhook(guild.id, own).catch(() => undefined);
    return own;
  }

  const created = await (channel as TextChannel)
    .createWebhook({
      name: WEBHOOK_NAME,
      reason: 'Webhook per i comandi personalizzati di ANGEL',
    })
    .catch((error) => {
      log.warn({ err: error, channelId }, 'creazione webhook fallita');
      return null;
    });

  if (!created) return null;

  webhookCache.set(channelId, created);
  // Va registrato subito come gestito, altrimenti il Webhook Guard lo
  // eliminerebbe entro pochi secondi considerandolo non autorizzato.
  await registerManagedWebhook(guild.id, created).catch(() => undefined);
  return created;
}

export function forgetWebhook(channelId: string): void {
  webhookCache.delete(channelId);
}

export interface PersonaMessage {
  name: string;
  avatarUrl?: string | null;
  content: string;
  embed?: {
    title?: string;
    color?: number;
    imageUrl?: string | null;
  };
  allowMentions: boolean;
}

export async function sendAsPersona(
  guild: Guild,
  channelId: string,
  message: PersonaMessage,
): Promise<string | null> {
  const webhook = await getPersonaWebhook(guild, channelId);
  if (!webhook) return null;

  const sent = await webhook
    .send({
      username: message.name.slice(0, 80),
      avatarURL: message.avatarUrl ?? undefined,
      content: message.embed ? undefined : message.content.slice(0, 2000),
      embeds: message.embed
        ? [
            {
              title: message.embed.title?.slice(0, 256),
              description: message.content.slice(0, 4000),
              color: message.embed.color,
              image: message.embed.imageUrl ? { url: message.embed.imageUrl } : undefined,
            },
          ]
        : undefined,
      // Per impostazione predefinita le menzioni sono disattivate: un comando
      // personalizzato che può scrivere @everyone è un megafono regalato a
      // chiunque abbia il ruolo giusto.
      allowedMentions: message.allowMentions ? { parse: ['users'] } : { parse: [] },
      threadId: undefined,
    })
    .catch((error) => {
      log.warn({ err: error, channelId }, 'invio messaggio persona fallito');
      // Il webhook potrebbe essere stato eliminato: si invalida la cache così
      // il prossimo tentativo lo ricrea.
      forgetWebhook(channelId);
      return null;
    });

  return sent?.id ?? null;
}

/**
 * Verifica che il nome di una persona non imiti lo staff o Discord.
 *
 * Il controllo è duplice: un elenco di termini vietati (Discord, staff,
 * moderatore, supporto, nitro…) e il confronto per somiglianza con i nickname
 * reali dello staff, normalizzato contro gli omoglifi.
 */
export async function validatePersonaName(
  guild: Guild,
  name: string,
  config: GuildConfig,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const forbidden = FORBIDDEN_PERSONA_PATTERNS.find((pattern) => pattern.test(name));
  if (forbidden) {
    return {
      ok: false,
      reason:
        `Il nome "${name}" contiene un termine riservato. Una persona non può presentarsi come ` +
        'Discord, come staff o come supporto: sarebbe indistinguibile da una truffa.',
    };
  }

  const staffRoleIds = config.general.staffRoleIds;
  if (staffRoleIds.length > 0) {
    const members = await guild.members.fetch().catch(() => null);
    const staff = members?.filter((member) =>
      member.roles.cache.some((role) => staffRoleIds.includes(role.id)),
    );

    for (const member of staff?.values() ?? []) {
      const similarity = Math.max(
        nameSimilarity(name, member.user.username),
        nameSimilarity(name, member.displayName),
      );
      if (similarity >= 0.85) {
        return {
          ok: false,
          reason:
            `Il nome "${name}" è troppo simile a quello di un membro dello staff ` +
            `(${member.displayName}). Scegline uno chiaramente distinto.`,
        };
      }
    }
  }

  const prisma = getPrisma();
  const duplicate = await prisma.persona.findFirst({
    where: { guildId: guild.id, name },
  });
  if (duplicate) {
    return { ok: false, reason: `Esiste già una persona chiamata "${name}".` };
  }

  return { ok: true };
}

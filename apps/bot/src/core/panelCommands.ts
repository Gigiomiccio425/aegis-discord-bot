import type { Client } from 'discord.js';
import { z } from 'zod';
import { childLogger } from './logger.js';
import { getGuildConfig } from './config.js';
import {
  disableLockdown,
  enableLockdown,
  liftQuarantine,
  quarantineMember,
} from './enforcer.js';
// `liftQuarantine` serve sia al comando dedicato sia all'annullamento generico.
import { createSnapshot } from '../security/snapshot.js';
import { recordEvent } from '../logging/auditLogger.js';
import { invalidateCustomCommands } from '../personas/customCommands.js';
import { deployGuildCommands } from '../scripts/deployCommands.js';
import { closePoll, drawGiveaway } from '../integrations/actions.js';
import { syncAutoModRules } from '../security/automodSync.js';
import { rescanGuildAccounts } from '../security/accountGuard.js';
import { checkEventReminders } from '../integrations/events.js';
import { auditWebhooks } from '../security/webhookGuard.js';
import { auditBots } from '../security/botGuard.js';
import { checkWatchedInvites } from '../security/inviteGuard.js';
import { closeInactiveTickets } from '../integrations/tickets.js';
import { pruneLogFiles } from '../logging/fileSink.js';
import { unwatchUser, watchUser } from '../security/watchlist.js';

const log = childLogger('panelCommands');

/**
 * Comandi inviati dal pannello al bot via Redis pub/sub.
 *
 * Il pannello non parla mai direttamente con il gateway Discord: pubblica
 * un'intenzione e il bot la esegue. Così l'unico processo connesso a Discord
 * resta uno, i rate limit sono gestiti in un punto solo, e il pannello può
 * essere riavviato senza far cadere la connessione del bot.
 */
const PanelCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('lockdown.enable'), guildId: z.string(), actorId: z.string(), reason: z.string(), durationSec: z.number().int().min(0).default(0) }),
  z.object({ action: z.literal('lockdown.disable'), guildId: z.string(), actorId: z.string() }),
  z.object({ action: z.literal('snapshot.create'), guildId: z.string(), actorId: z.string() }),
  z.object({ action: z.literal('quarantine.lift'), guildId: z.string(), actorId: z.string(), userId: z.string() }),
  z.object({ action: z.literal('quarantine.apply'), guildId: z.string(), actorId: z.string(), userId: z.string(), reason: z.string().default('Quarantena dal pannello') }),
  z.object({ action: z.literal('watch.add'), guildId: z.string(), actorId: z.string(), userId: z.string(), reason: z.string(), hours: z.number().int().min(0).max(8760).default(0) }),
  z.object({ action: z.literal('watch.remove'), guildId: z.string(), actorId: z.string(), userId: z.string() }),
  // Messaggio scritto dal bot su richiesta del pannello: stesso effetto di
  // `/dì`, stesse regole — niente menzioni di massa, tutto tracciato.
  z.object({
    action: z.literal('message.send'),
    guildId: z.string(),
    actorId: z.string(),
    channelId: z.string(),
    text: z.string().max(1900).default(''),
    imageUrl: z.string().max(1000).nullable().default(null),
    embed: z.boolean().default(false),
    title: z.string().max(200).nullable().default(null),
    /** ID di un messaggio del bot da riscrivere invece di pubblicarne uno nuovo. */
    editMessageId: z.string().nullable().default(null),
  }),
  z.object({ action: z.literal('commands.reload'), guildId: z.string() }),
  z.object({ action: z.literal('config.reloaded'), guildId: z.string() }),
  // Scadenze gestite dal worker, che non ha una connessione al gateway.
  z.object({ action: z.literal('poll.close'), guildId: z.string(), pollId: z.string() }),
  z.object({ action: z.literal('giveaway.draw'), guildId: z.string(), giveawayId: z.string() }),
  z.object({ action: z.literal('automod.sync'), guildId: z.string(), actorId: z.string() }),
  z.object({ action: z.literal('accounts.rescan'), guildId: z.string() }),
  z.object({ action: z.literal('events.reminders'), guildId: z.string() }),
  z.object({ action: z.literal('security.audit'), guildId: z.string() }),
  z.object({ action: z.literal('tickets.autoclose'), guildId: z.string() }),
  z.object({ action: z.literal('logs.prune'), guildId: z.string() }),
  // Annulla l'effetto di un provvedimento: serve al pannello, che aggiorna il
  // database ma non può parlare con Discord.
  z.object({
    action: z.literal('case.undo'),
    guildId: z.string(),
    actorId: z.string(),
    caseType: z.string(),
    targetId: z.string(),
    reason: z.string().default('Provvedimento revocato dal pannello'),
  }),
]);

export async function handlePanelCommand(client: Client, raw: string): Promise<void> {
  let parsed;
  try {
    parsed = PanelCommand.parse(JSON.parse(raw));
  } catch (error) {
    log.warn({ err: error, raw: raw.slice(0, 200) }, 'comando dal pannello non valido');
    return;
  }

  const guild = client.guilds.cache.get(parsed.guildId);
  if (!guild) return;

  switch (parsed.action) {
    case 'lockdown.enable': {
      const config = await getGuildConfig(parsed.guildId);
      await enableLockdown(client, guild, config, parsed.reason, parsed.durationSec);
      break;
    }

    case 'lockdown.disable': {
      // `force` sempre acceso: il pulsante del pannello è la via d'uscita di
      // chi vede il server bloccato, e deve funzionare anche quando lo stato
      // salvato è andato perso.
      const config = await getGuildConfig(parsed.guildId);
      await disableLockdown(client, guild, 'Revoca dal pannello', { config, force: true });
      break;
    }

    case 'snapshot.create': {
      const id = await createSnapshot(guild, 'MANUAL', parsed.actorId);
      await recordEvent(client, {
        guildId: parsed.guildId,
        type: 'SECURITY_SNAPSHOT_CREATED',
        actorId: parsed.actorId,
        summary: `Backup creato dal pannello: \`${id}\``,
      });
      break;
    }

    case 'quarantine.lift':
      await liftQuarantine(client, guild, parsed.userId, parsed.actorId);
      break;

    case 'quarantine.apply': {
      const member = await guild.members.fetch(parsed.userId).catch(() => null);
      if (!member) {
        log.warn({ userId: parsed.userId }, 'quarantena richiesta per un membro non presente');
        break;
      }
      const config = await getGuildConfig(parsed.guildId);
      const done = await quarantineMember(
        { client, guild, config, member, module: 'pannello' },
        `${parsed.reason} (da <@${parsed.actorId}>)`,
      );
      if (!done) {
        // Le due cause sono sempre le stesse: manca il ruolo di quarantena, o
        // il bersaglio ha un ruolo più alto di quello del bot. Entrambe si
        // risolvono in configurazione, non riprovando.
        await recordEvent(client, {
          guildId: parsed.guildId,
          type: 'SECURITY_QUARANTINE_APPLIED',
          actorId: parsed.actorId,
          targetId: parsed.userId,
          severity: 50,
          summary:
            '⚠️ Quarantena **non applicata**: ruolo di quarantena non configurato, ' +
            'oppure il ruolo del bot non è più in alto di quello della persona.',
        });
      }
      break;
    }

    case 'watch.add':
      await watchUser(parsed.guildId, parsed.userId, parsed.actorId, parsed.reason, parsed.hours);
      await recordEvent(client, {
        guildId: parsed.guildId,
        type: 'MOD_WATCH_ADDED',
        actorId: parsed.actorId,
        targetId: parsed.userId,
        severity: 40,
        summary: `👁️ <@${parsed.userId}> messo sotto sorveglianza dal pannello\n${parsed.reason}`,
      });
      break;

    case 'watch.remove':
      if (await unwatchUser(parsed.guildId, parsed.userId)) {
        await recordEvent(client, {
          guildId: parsed.guildId,
          type: 'MOD_WATCH_REMOVED',
          actorId: parsed.actorId,
          targetId: parsed.userId,
          summary: 'Sorveglianza rimossa dal pannello',
        });
      }
      break;

    case 'message.send': {
      const channel = await client.channels.fetch(parsed.channelId).catch(() => null);
      if (!channel?.isTextBased() || !('send' in channel)) break;

      const payload = parsed.embed
        ? {
            embeds: [
              {
                color: 0xe8d8a0,
                ...(parsed.title ? { title: parsed.title } : {}),
                ...(parsed.text ? { description: parsed.text } : {}),
                ...(parsed.imageUrl ? { image: { url: parsed.imageUrl } } : {}),
              },
            ],
            allowedMentions: { parse: [] as never[] },
          }
        : {
            content: [parsed.text, parsed.imageUrl].filter(Boolean).join('\n'),
            allowedMentions: { parse: [] as never[] },
          };

      if (parsed.editMessageId) {
        const existing = await channel.messages.fetch(parsed.editMessageId).catch(() => null);
        // Solo i propri messaggi: modificare quelli altrui non è possibile per
        // Discord, e provarci produrrebbe solo un errore poco chiaro.
        if (!existing || existing.author.id !== client.user?.id) break;
        await existing.edit(payload);
      } else {
        await channel.send(payload);
      }

      await recordEvent(client, {
        guildId: parsed.guildId,
        type: parsed.editMessageId ? 'BOT_MESSAGE_EDITED' : 'BOT_MESSAGE_SENT',
        actorId: parsed.actorId,
        channelId: parsed.channelId,
        summary: `Messaggio pubblicato dal bot su richiesta di <@${parsed.actorId}> (pannello)`,
        payload: { text: parsed.text.slice(0, 500), hasImage: Boolean(parsed.imageUrl) },
      });
      break;
    }

    case 'commands.reload':
      invalidateCustomCommands(parsed.guildId);
      // I comandi personalizzati sono comandi slash veri: dopo una modifica dal
      // pannello vanno ripubblicati su Discord, altrimenti la nuova definizione
      // esiste solo nel database.
      await deployGuildCommands(client, parsed.guildId).catch((error) =>
        log.error({ err: error }, 'ripubblicazione comandi fallita'),
      );
      break;

    case 'config.reloaded':
      log.debug({ guildId: parsed.guildId }, 'configurazione ricaricata');
      break;

    case 'poll.close':
      await closePoll(client, parsed.pollId);
      break;

    case 'giveaway.draw':
      await drawGiveaway(client, parsed.giveawayId);
      break;

    case 'automod.sync': {
      const config = await getGuildConfig(parsed.guildId);
      const report = await syncAutoModRules(client, guild, config);
      log.info({ guildId: parsed.guildId, ...report }, 'AutoMod sincronizzato dal pannello');
      break;
    }

    case 'accounts.rescan': {
      const config = await getGuildConfig(parsed.guildId);
      await rescanGuildAccounts(client, guild, config);
      break;
    }

    case 'events.reminders': {
      const config = await getGuildConfig(parsed.guildId);
      await checkEventReminders(client, guild, config);
      break;
    }

    case 'logs.prune': {
      const config = await getGuildConfig(parsed.guildId);
      await pruneLogFiles(parsed.guildId, config.logging.fileSink.retentionDays);
      break;
    }

    case 'tickets.autoclose': {
      const config = await getGuildConfig(parsed.guildId);
      const closed = await closeInactiveTickets(client, guild, config);
      if (closed > 0) log.info({ guildId: parsed.guildId, closed }, 'ticket inattivi chiusi');
      break;
    }

    case 'security.audit': {
      const config = await getGuildConfig(parsed.guildId);
      const [webhooks, bots] = await Promise.all([
        auditWebhooks(client, guild, config),
        auditBots(client, guild, config),
        checkWatchedInvites(client, guild, config),
      ]);
      log.info(
        { guildId: parsed.guildId, webhooks, bots },
        'revisione periodica di sicurezza completata',
      );
      break;
    }

    case 'case.undo': {
      switch (parsed.caseType) {
        case 'BAN':
          await guild.bans.remove(parsed.targetId, parsed.reason).catch(() => undefined);
          break;
        case 'MUTE': {
          const member = await guild.members.fetch(parsed.targetId).catch(() => null);
          await member?.timeout(null, parsed.reason).catch(() => undefined);
          break;
        }
        case 'QUARANTINE':
          await liftQuarantine(client, guild, parsed.targetId, parsed.actorId);
          break;
        default:
          // WARN, NOTE e PURGE non hanno un effetto da annullare su Discord:
          // basta il cambio di stato già fatto dal pannello.
          break;
      }
      break;
    }
  }
}

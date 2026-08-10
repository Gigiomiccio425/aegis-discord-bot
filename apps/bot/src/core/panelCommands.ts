import type { Client } from 'discord.js';
import { z } from 'zod';
import { childLogger } from './logger.js';
import { getGuildConfig } from './config.js';
import { disableLockdown, enableLockdown, liftQuarantine } from './enforcer.js';
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

    case 'lockdown.disable':
      await disableLockdown(client, guild, 'Revoca dal pannello');
      break;

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

import { Events, type Client } from 'discord.js';
import { ensureGuild } from '../core/config.js';
import { childLogger } from '../core/logger.js';
import { checkPrivilegedIntents } from '../core/client.js';
import { missingBotPermissions } from '../core/permissions.js';
import { registerMessageEvents } from './messages.js';
import { registerMemberEvents } from './members.js';
import { registerVoiceEvents } from './voice.js';
import { registerStructureEvents } from './structure.js';
import { registerReactionEvents } from './reactions.js';
import { registerAuditLogEvents } from './auditLog.js';
import { registerInviteEvents, primeInviteCache } from './invites.js';
import { registerInteractionEvents } from './interactions.js';
import { deployGuildCommands } from '../scripts/deployCommands.js';
import { getPrisma } from '@aegis/db';

const log = childLogger('events');

export function registerAllEvents(client: Client): void {
  registerMessageEvents(client);
  registerMemberEvents(client);
  registerVoiceEvents(client);
  registerStructureEvents(client);
  registerReactionEvents(client);
  registerAuditLogEvents(client);
  registerInviteEvents(client);
  registerInteractionEvents(client);

  client.once(Events.ClientReady, (readyClient) => {
    void onReady(readyClient).catch((error) => log.error({ err: error }, 'avvio fallito'));
  });

  client.on(Events.GuildCreate, (guild) => {
    void (async () => {
      await ensureGuild({
        id: guild.id,
        name: guild.name,
        iconHash: guild.icon,
        ownerId: guild.ownerId,
        memberCount: guild.memberCount,
      });
      await primeInviteCache(guild).catch(() => undefined);
      await deployGuildCommands(client, guild.id).catch((error) =>
        log.error({ err: error, guildId: guild.id }, 'registrazione comandi fallita'),
      );
      log.info({ guildId: guild.id, name: guild.name }, 'aggiunto a un nuovo server');
    })();
  });

  client.on(Events.GuildDelete, (guild) => {
    void getPrisma()
      .guild.updateMany({ where: { id: guild.id }, data: { active: false } })
      .catch(() => undefined);
    log.info({ guildId: guild.id }, 'rimosso da un server');
  });
}

async function onReady(client: Client<true>): Promise<void> {
  log.info(
    { tag: client.user.tag, guilds: client.guilds.cache.size },
    'connesso al gateway',
  );

  checkPrivilegedIntents(client);

  for (const guild of client.guilds.cache.values()) {
    await ensureGuild({
      id: guild.id,
      name: guild.name,
      iconHash: guild.icon,
      ownerId: guild.ownerId,
      memberCount: guild.memberCount,
    }).catch((error) => log.error({ err: error, guildId: guild.id }, 'registrazione server fallita'));

    // I contatori degli inviti vanno caricati subito: senza il confronto con lo
    // stato precedente, il primo ingresso non è attribuibile ad alcun invito.
    await primeInviteCache(guild).catch(() => undefined);

    // I comandi personalizzati sono comandi slash veri e vivono nel database:
    // vanno ripubblicati all'avvio, altrimenti dopo un riavvio esisterebbero
    // solo lato server.
    await deployGuildCommands(client, guild.id).catch((error) =>
      log.warn({ err: error, guildId: guild.id }, 'registrazione comandi del server fallita'),
    );

    const me = await guild.members.fetchMe().catch(() => null);
    if (me) {
      const missing = missingBotPermissions(me);
      if (missing.length > 0) {
        log.warn(
          { guildId: guild.id, guildName: guild.name, missing },
          'permessi mancanti: alcune difese non potranno agire',
        );
      }
    }
  }

  client.user.setPresence({
    activities: [{ name: 'la sicurezza del server', type: 3 }], // 3 = Watching
    status: 'online',
  });
}

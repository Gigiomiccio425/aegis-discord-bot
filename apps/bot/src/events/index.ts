import { Events, type Client } from 'discord.js';
import { ensureGuild, getGuildConfig } from '../core/config.js';
import { childLogger } from '../core/logger.js';
import { checkPrivilegedIntents } from '../core/client.js';
import { missingBotPermissions } from '../core/permissions.js';
import { startLockdownSweeper } from '../core/enforcer.js';
import { applyGlobalIdentity, applyNickname, applyPresence } from '../core/identity.js';
import { ensureOwnerRole } from '../security/ownerRole.js';
import { provisionGuild } from '../security/provision.js';
import { registerMessageEvents } from './messages.js';
import { registerMemberEvents } from './members.js';
import { registerVoiceEvents } from './voice.js';
import { registerStructureEvents } from './structure.js';
import { registerReactionEvents } from './reactions.js';
import { registerAuditLogEvents } from './auditLog.js';
import { registerInviteEvents, primeInviteCache } from './invites.js';
import { registerInteractionEvents } from './interactions.js';
import { registraInventario } from '../core/inventory.js';
import { deployGuildCommands } from '../scripts/deployCommands.js';
import { getPrisma } from '@angel/db';

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
  registraInventario(client);

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

      // Server nuovo: si prepara tutto adesso, non al prossimo riavvio. Ruoli,
      // canali di servizio e configurazione compilata — è il momento in cui
      // serve, perché fino a qui il bot è acceso e non ha dove scrivere né con
      // cosa isolare.
      const config = await getGuildConfig(guild.id).catch(() => null);
      if (config) {
        if (config.general.autoProvision) {
          const esito = await provisionGuild(client, guild, config).catch(() => null);
          if (esito) {
            log.info(
              {
                guildId: guild.id,
                ruoli: esito.ruoliCreati.length,
                canali: esito.canaliCreati.length,
                campi: esito.campiCompilati,
              },
              'server predisposto',
            );
          }
        }
        if (config.general.ownerRole.enabled) {
          await ensureOwnerRole(client, guild, config).catch(() => undefined);
        }
      }

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

  // Un lockdown a tempo deve poter scadere anche se il bot è stato riavviato
  // nel frattempo: il conto alla rovescia sta in Redis, non in memoria.
  startLockdownSweeper(client);

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

    const config = await getGuildConfig(guild.id).catch(() => null);

    // Predisposizione: all'avvio riempie solo i campi rimasti vuoti e non
    // ricrea ciò che è stato eliminato di proposito. Cancellare un canale di
    // servizio è un modo legittimo di dire che non lo si vuole, e ritrovarselo
    // lì a ogni riavvio sarebbe il bot che discute con chi lo amministra.
    if (config?.general.autoProvision) {
      await provisionGuild(client, guild, config).catch(() => undefined);
    }

    // Ruolo del proprietario: si ricrea se qualcuno lo ha eliminato e torna a
    // chi gli spetta. All'avvio e non solo all'ingresso, perché il caso da
    // coprire è proprio quello in cui è sparito mentre il bot era spento.
    if (config?.general.ownerRole.enabled) {
      const esito = await ensureOwnerRole(client, guild, config).catch(() => null);
      if (esito && !esito.ok) {
        log.warn({ guildId: guild.id, motivo: esito.reason }, 'ruolo del proprietario non applicato');
      }
    }

    if (config) await applyNickname(guild, config).catch(() => undefined);

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

  // Identità: nome e immagine sono globali, quindi si prende la configurazione
  // del primo server. Non è arbitrario — sono impostazioni dell'applicazione,
  // non del server, e Discord non offre alcun modo di differenziarle.
  const primo = client.guilds.cache.first();
  const config = primo ? await getGuildConfig(primo.id).catch(() => null) : null;
  if (config) {
    await applyGlobalIdentity(client, config).catch(() => undefined);
    applyPresence(client, config, primo);
  }
}

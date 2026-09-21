import { EmbedBuilder, type Client } from 'discord.js';
import { z } from 'zod';
import type { Esito } from '@angel/shared';
import { childLogger } from './logger.js';
import { forgetGuildConfig, getGuildConfig } from './config.js';
import {
  descriviBlocco,
  descriviSblocco,
  disableLockdown,
  enableLockdown,
  quarantineMember,
  revocaQuarantena,
} from './enforcer.js';
import { descriviErroreDiscord } from './erroriDiscord.js';
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
import { provisionGuild } from '../security/provision.js';
import { ensureOwnerRole } from '../security/ownerRole.js';
import { pubblicaCopiaLeggera } from '../security/copiaLeggera.js';

const log = childLogger('comandi');

/**
 * Comandi che gli altri processi chiedono al bot.
 *
 * Il pannello, il worker e il bot Twitch non parlano mai con il gateway
 * Discord: chiedono, e il bot esegue. Così l'unico processo connesso a Discord
 * resta uno e i rate limit si gestiscono in un punto solo.
 *
 * Ogni comando restituisce un **esito**, e non è un dettaglio: prima questa
 * funzione non restituiva niente, il pannello rispondeva «ok» un istante dopo
 * aver spedito, e un lockdown fallito per un permesso mancante sembrava
 * riuscito. Ora quello che succede davvero torna a chi l'ha chiesto.
 */
const ComandoBot = z.discriminatedUnion('action', [
  z.object({ action: z.literal('lockdown.enable'), guildId: z.string(), actorId: z.string(), reason: z.string(), durationSec: z.number().int().min(0).default(0) }),
  // `forza` solo se chiesto: riapre anche i canali che lo staff voleva in sola
  // lettura, come gli annunci. Prima il pannello la usava sempre, e revocare
  // un lockdown dal pannello lasciava gli annunci scrivibili da chiunque.
  z.object({ action: z.literal('lockdown.disable'), guildId: z.string(), actorId: z.string(), forza: z.boolean().default(false) }),
  // Il tipo lo sceglie chi chiede: prima il bot scriveva sempre MANUAL, e il
  // worker — che salta il giro se trova un SCHEDULED recente — non ne trovava
  // mai uno: a ogni passaggio partiva un backup nuovo, attribuito al pannello.
  z.object({ action: z.literal('snapshot.create'), guildId: z.string(), actorId: z.string(), kind: z.enum(['MANUAL', 'SCHEDULED']).default('MANUAL') }),
  // La copia leggera pubblicata su Discord. La chiede il worker dopo quella su
  // disco, e chi preme il pulsante dal pannello. Nessun parametro: cosa e dove
  // pubblicare lo dice la configurazione del server, non chi chiede.
  z.object({ action: z.literal('copia.leggera'), guildId: z.string() }),
  // Predisposizione a richiesta: crea solo ciò che manca, non duplica nulla.
  z.object({ action: z.literal('server.setup'), guildId: z.string(), actorId: z.string() }),
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
  /*
   * Registro del bot Twitch.
   *
   * Lo manda il processo Twitch, che con Discord non parla: l'unico
   * collegato al gateway è il bot, e due processi con lo stesso token
   * riceverebbero gli stessi eventi agendo due volte.
   */
  z.object({
    action: z.literal('twitch.log'),
    guildId: z.string(),
    channelId: z.string(),
    canale: z.string(),
    tipo: z.string(),
    modulo: z.string().nullable().default(null),
    gravita: z.number().int().min(0).max(100).default(0),
    utente: z.string().nullable().default(null),
    azione: z.string().nullable().default(null),
    durataSec: z.number().int().nullable().default(null),
    motivo: z.string().nullable().default(null),
    simulato: z.boolean().default(false),
    testo: z.string().max(1000).nullable().default(null),
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

const fatto = (messaggio: string, dati?: unknown): Esito => ({ stato: 'fatto', messaggio, dati });
const fallito = (messaggio: string): Esito => ({ stato: 'fallito', messaggio });

export async function eseguiComando(client: Client, grezzo: unknown): Promise<Esito> {
  const letto = ComandoBot.safeParse(grezzo);
  if (!letto.success) {
    log.warn(
      { issues: letto.error.issues.slice(0, 3), action: (grezzo as { action?: unknown })?.action },
      'comando non valido',
    );
    return fallito('comando non riconosciuto: il pannello e il bot hanno versioni diverse?');
  }
  const comando = letto.data;

  const guild = client.guilds.cache.get(comando.guildId);
  if (!guild) {
    return fallito(
      'il bot non è in questo server, oppure non ha ancora finito di collegarsi a Discord',
    );
  }

  switch (comando.action) {
    case 'lockdown.enable': {
      const config = await getGuildConfig(comando.guildId);
      const esito = await enableLockdown(client, guild, config, comando.reason, comando.durationSec);
      const messaggio = descriviBlocco(esito, Math.round(comando.durationSec / 60));
      if (esito.permessoMancante) return fallito(messaggio);
      return fatto(messaggio, esito);
    }

    case 'lockdown.disable': {
      const config = await getGuildConfig(comando.guildId);
      const esito = await disableLockdown(client, guild, 'Revoca dal pannello', {
        config,
        force: comando.forza,
      });
      return fatto(descriviSblocco(esito, comando.forza), esito);
    }

    case 'snapshot.create': {
      const id = await createSnapshot(guild, comando.kind, comando.actorId);
      const programmato = comando.kind === 'SCHEDULED';
      await recordEvent(client, {
        guildId: comando.guildId,
        type: 'SECURITY_SNAPSHOT_CREATED',
        actorId: programmato ? null : comando.actorId,
        automated: programmato,
        summary: programmato
          ? `Backup programmato: \`${id}\``
          : `Backup creato dal pannello: \`${id}\``,
      });
      return fatto(`Backup della struttura salvato: ${id}`, { id });
    }

    /*
     * La copia leggera, chiesta dal worker dopo quella su disco.
     *
     * Non lancia: un server che non ce la fa — canale sparito, permessi tolti
     * — non deve impedire agli altri di avere la loro. Il motivo torna al
     * mittente e finisce nei log.
     */
    case 'copia.leggera':
      return pubblicaCopiaLeggera(client, comando.guildId);

    case 'server.setup': {
      const config = await getGuildConfig(comando.guildId);
      const esito = await provisionGuild(client, guild, config);
      if (config.general.ownerRole.enabled) {
        await ensureOwnerRole(client, guild, config).catch(() => undefined);
      }
      log.info(
        {
          guildId: comando.guildId,
          ruoli: esito.ruoliCreati.length,
          canali: esito.canaliCreati.length,
          campi: esito.campiCompilati,
        },
        'predisposizione richiesta dal pannello',
      );
      const parti = [
        `Ruoli creati: ${esito.ruoliCreati.length}`,
        `canali creati: ${esito.canaliCreati.length}`,
        `campi compilati: ${esito.campiCompilati}`,
      ];
      if (esito.errori.length > 0) {
        return fallito(`${parti.join(', ')}. Problemi: ${esito.errori.slice(0, 5).join('; ')}`);
      }
      return fatto(`${parti.join(', ')}.`, esito);
    }

    case 'quarantine.lift': {
      const esito = await revocaQuarantena(client, guild, comando.userId, comando.actorId);
      return esito.ok
        ? fatto('Quarantena revocata: ruoli precedenti restituiti.')
        : fallito(`Quarantena non revocata: ${esito.motivo}.`);
    }

    case 'quarantine.apply': {
      const member = await guild.members.fetch(comando.userId).catch(() => null);
      if (!member) return fallito('la persona non è nel server');
      const config = await getGuildConfig(comando.guildId);
      const done = await quarantineMember(
        { client, guild, config, member, module: 'pannello' },
        `${comando.reason} (da <@${comando.actorId}>)`,
      ).catch((errore: unknown) => {
        log.warn({ err: errore, guildId: comando.guildId }, 'quarantena dal pannello fallita');
        return descriviErroreDiscord(errore);
      });
      if (done === true) return fatto('Quarantena applicata.');

      // Le due cause sono sempre le stesse: manca il ruolo di quarantena, o il
      // bersaglio ha un ruolo più alto di quello del bot. Entrambe si
      // risolvono in configurazione, non riprovando.
      const motivo =
        typeof done === 'string'
          ? done
          : config.general.quarantineRoleId
            ? 'il ruolo del bot non è più in alto di quello della persona'
            : 'il ruolo di quarantena non è configurato';
      await recordEvent(client, {
        guildId: comando.guildId,
        type: 'SECURITY_QUARANTINE_APPLIED',
        actorId: comando.actorId,
        targetId: comando.userId,
        severity: 50,
        summary: `⚠️ Quarantena **non applicata**: ${motivo}.`,
      });
      return fallito(`Quarantena non applicata: ${motivo}.`);
    }

    case 'watch.add':
      await watchUser(comando.guildId, comando.userId, comando.actorId, comando.reason, comando.hours);
      await recordEvent(client, {
        guildId: comando.guildId,
        type: 'MOD_WATCH_ADDED',
        actorId: comando.actorId,
        targetId: comando.userId,
        severity: 40,
        summary: `👁️ <@${comando.userId}> messo sotto sorveglianza dal pannello\n${comando.reason}`,
      });
      return fatto('Sorveglianza avviata.');

    case 'watch.remove':
      if (await unwatchUser(comando.guildId, comando.userId)) {
        await recordEvent(client, {
          guildId: comando.guildId,
          type: 'MOD_WATCH_REMOVED',
          actorId: comando.actorId,
          targetId: comando.userId,
          summary: 'Sorveglianza rimossa dal pannello',
        });
        return fatto('Sorveglianza rimossa.');
      }
      return fatto('Non era sotto sorveglianza.');

    case 'message.send': {
      const channel = await client.channels.fetch(comando.channelId).catch(() => null);
      /*
       * Il canale deve stare nel server del comando.
       *
       * L'identificativo arriva dal pannello, e il controllo d'accesso del
       * pannello riguarda il server nell'indirizzo, non il canale nel corpo:
       * senza questa verifica chi modera un server poteva far scrivere il bot
       * in un canale di un altro server qualunque in cui il bot è presente.
       */
      if (!channel || !('guildId' in channel) || channel.guildId !== comando.guildId) {
        return fallito('canale non trovato in questo server');
      }
      if (!channel.isTextBased() || !('send' in channel)) {
        return fallito('in quel canale non si può scrivere');
      }

      const payload = comando.embed
        ? {
            embeds: [
              {
                color: 0xe8d8a0,
                ...(comando.title ? { title: comando.title } : {}),
                ...(comando.text ? { description: comando.text } : {}),
                ...(comando.imageUrl ? { image: { url: comando.imageUrl } } : {}),
              },
            ],
            allowedMentions: { parse: [] as never[] },
          }
        : {
            content: [comando.text, comando.imageUrl].filter(Boolean).join('\n'),
            allowedMentions: { parse: [] as never[] },
          };

      try {
        if (comando.editMessageId) {
          const existing = await channel.messages.fetch(comando.editMessageId).catch(() => null);
          // Solo i propri messaggi: modificare quelli altrui non è possibile per
          // Discord, e provarci produrrebbe solo un errore poco chiaro.
          if (!existing || existing.author.id !== client.user?.id) {
            return fallito('il messaggio da modificare non esiste, o non è del bot');
          }
          await existing.edit(payload);
        } else {
          await channel.send(payload);
        }
      } catch (errore) {
        return fallito(`Messaggio non pubblicato: ${descriviErroreDiscord(errore)}.`);
      }

      await recordEvent(client, {
        guildId: comando.guildId,
        type: comando.editMessageId ? 'BOT_MESSAGE_EDITED' : 'BOT_MESSAGE_SENT',
        actorId: comando.actorId,
        channelId: comando.channelId,
        summary: `Messaggio pubblicato dal bot su richiesta di <@${comando.actorId}> (pannello)`,
        payload: { text: comando.text.slice(0, 500), hasImage: Boolean(comando.imageUrl) },
      });
      return fatto(comando.editMessageId ? 'Messaggio modificato.' : 'Messaggio pubblicato.');
    }

    /*
     * Un fatto della chat Twitch, portato su Discord.
     *
     * Embed e non testo semplice per una ragione pratica: il colore si vede
     * prima di leggere. In un canale di registro che scorre, riconoscere un
     * bando da un messaggio cancellato senza leggere una riga è la
     * differenza fra guardarlo e non guardarlo.
     */
    case 'twitch.log': {
      const canale = guild.channels.cache.get(comando.channelId);
      if (!canale?.isTextBased()) return fallito('canale del registro Twitch non trovato');

      const colore =
        comando.gravita >= 70 ? 0xe05263 : comando.gravita >= 35 ? 0xd8b45f : 0x6f8a95;

      const righe: string[] = [];
      if (comando.utente) righe.push(`**Chi** ${comando.utente}`);
      if (comando.motivo) righe.push(`**Perché** ${comando.motivo}`);
      if (comando.azione) {
        righe.push(
          `**Azione** ${comando.azione.toLowerCase()}` +
            (comando.durataSec ? ` per ${comando.durataSec}s` : ''),
        );
      }
      if (comando.testo) {
        // In blocco di codice: il testo viene da un estraneo e può contenere
        // menzioni, che in un canale di registro suonerebbero il telefono
        // dello staff a ogni riga di spam.
        righe.push(`\`\`\`\n${comando.testo.replace(/`/g, "'").slice(0, 500)}\n\`\`\``);
      }

      const embed = new EmbedBuilder()
        .setColor(colore)
        .setAuthor({ name: `Twitch · ${comando.canale}` })
        .setTitle(comando.simulato ? `${comando.tipo} (prova)` : comando.tipo)
        .setDescription(righe.join('\n') || '—')
        .setTimestamp(new Date());

      if (comando.modulo) embed.setFooter({ text: comando.modulo });

      try {
        await canale.send({ embeds: [embed], allowedMentions: { parse: [] } });
      } catch (errore) {
        log.warn({ err: errore, guildId: comando.guildId }, 'registro Twitch non pubblicato');
        return fallito(descriviErroreDiscord(errore));
      }
      return fatto('Pubblicato.');
    }

    case 'commands.reload':
      invalidateCustomCommands(comando.guildId);
      // I comandi personalizzati sono comandi slash veri: dopo una modifica dal
      // pannello vanno ripubblicati su Discord, altrimenti la nuova definizione
      // esiste solo nel database.
      try {
        await deployGuildCommands(client, comando.guildId);
      } catch (errore) {
        log.error({ err: errore }, 'ripubblicazione comandi fallita');
        return fallito(
          `Salvato, ma Discord non ha accettato i comandi: ${descriviErroreDiscord(errore)}.`,
        );
      }
      return fatto('Comandi ripubblicati su Discord.');

    case 'config.reloaded':
      // La cache si svuota anche da qui: l'annuncio via pub/sub arriva solo a
      // chi ascolta in quel momento, e questo comando no — resta in coda.
      forgetGuildConfig(comando.guildId);
      return fatto('Configurazione ricaricata.');

    case 'poll.close':
      await closePoll(client, comando.pollId);
      return fatto('Sondaggio chiuso.');

    case 'giveaway.draw': {
      const vincitori = await drawGiveaway(client, comando.giveawayId);
      return fatto(
        vincitori.length > 0
          ? `Estratti: ${vincitori.map((id) => `<@${id}>`).join(', ')}`
          : 'Estrazione fatta: nessun partecipante in regola.',
        { vincitori },
      );
    }

    case 'automod.sync': {
      const config = await getGuildConfig(comando.guildId);
      const report = await syncAutoModRules(client, guild, config);
      log.info({ guildId: comando.guildId, ...report }, 'AutoMod sincronizzato dal pannello');
      const messaggio =
        `AutoMod: ${report.created.length} regole create, ${report.updated.length} aggiornate, ` +
        `${report.removed.length} rimosse.`;
      return report.errors.length > 0
        ? fallito(`${messaggio} Errori: ${report.errors.slice(0, 3).join('; ')}`)
        : fatto(messaggio, report);
    }

    case 'accounts.rescan': {
      const config = await getGuildConfig(comando.guildId);
      const esito = await rescanGuildAccounts(client, guild, config);
      return fatto(`Profili analizzati: ${esito.scanned}, segnalati: ${esito.flagged}.`, esito);
    }

    case 'events.reminders': {
      const config = await getGuildConfig(comando.guildId);
      const inviati = await checkEventReminders(client, guild, config);
      return fatto(`Promemoria inviati: ${inviati}.`);
    }

    case 'logs.prune': {
      const config = await getGuildConfig(comando.guildId);
      const tolti = await pruneLogFiles(comando.guildId, config.logging.fileSink.retentionDays);
      return fatto(`File di registro eliminati: ${tolti}.`);
    }

    case 'tickets.autoclose': {
      const config = await getGuildConfig(comando.guildId);
      const closed = await closeInactiveTickets(client, guild, config);
      if (closed > 0) log.info({ guildId: comando.guildId, closed }, 'ticket inattivi chiusi');
      return fatto(`Ticket inattivi chiusi: ${closed}.`);
    }

    case 'security.audit': {
      const config = await getGuildConfig(comando.guildId);
      const [webhooks, bots] = await Promise.all([
        auditWebhooks(client, guild, config),
        auditBots(client, guild, config),
        checkWatchedInvites(client, guild, config),
      ]);
      log.info(
        { guildId: comando.guildId, webhooks, bots },
        'revisione periodica di sicurezza completata',
      );
      return fatto(
        `Webhook: ${webhooks.total} (${webhooks.unauthorized} non autorizzati). ` +
          `Bot: ${bots.checked} (${bots.risky} a rischio).`,
      );
    }

    case 'case.undo': {
      switch (comando.caseType) {
        case 'BAN':
          try {
            await guild.bans.remove(comando.targetId, comando.reason);
          } catch (errore) {
            const motivo = descriviErroreDiscord(errore);
            // Già sbandita: l'effetto voluto c'è, non è un errore.
            if (motivo.includes('non risulta bandita')) return fatto('Non era più bandita.');
            return fallito(`Ban non revocato: ${motivo}.`);
          }
          return fatto('Ban revocato.');
        case 'MUTE': {
          const member = await guild.members.fetch(comando.targetId).catch(() => null);
          if (!member) return fatto('Non è più nel server: niente da annullare.');
          try {
            await member.timeout(null, comando.reason);
          } catch (errore) {
            return fallito(`Silenziamento non tolto: ${descriviErroreDiscord(errore)}.`);
          }
          return fatto('Silenziamento tolto.');
        }
        case 'QUARANTINE': {
          const esito = await revocaQuarantena(client, guild, comando.targetId, comando.actorId);
          if (esito.ok || esito.motivo === 'non risulta in quarantena') {
            return fatto('Quarantena revocata.');
          }
          return fallito(`Quarantena non revocata: ${esito.motivo}.`);
        }
        default:
          // WARN, NOTE e PURGE non hanno un effetto da annullare su Discord:
          // basta il cambio di stato già fatto dal pannello.
          return fatto('Provvedimento revocato.');
      }
    }
  }
}

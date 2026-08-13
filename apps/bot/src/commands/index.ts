import { MessageFlags, type ChatInputCommandInteraction, type Client, type GuildMember } from 'discord.js';
import { getGuildConfig } from '../core/config.js';
import { childLogger } from '../core/logger.js';
import { isBotOwner } from '../core/permissions.js';
import { recordEvent } from '../logging/auditLogger.js';
import { t } from '../core/i18n.js';
import { executeCustomCommand, loadCustomCommands } from '../personas/customCommands.js';
import type { Command } from './types.js';
import { generalCommands } from './general.js';
import { moderationCommands } from './moderation.js';
import { securityCommands } from './security.js';
import { privacyCommands } from './privacy.js';
import { verificationCommands } from './verification.js';
import { integrationCommands } from './integrations.js';
import { archiveCommands } from './archive.js';
import { appealCommands } from './appeals.js';
import { eventCommands } from './events.js';
import { voiceCommands } from './voice.js';
import { announceCommands } from './announce.js';
import { wordCommands } from './words.js';
import { reportCommands } from './reports.js';
import { healthCommands } from './health.js';

const log = childLogger('commands');

export const commands: Command[] = [
  ...generalCommands,
  ...moderationCommands,
  ...securityCommands,
  ...privacyCommands,
  ...verificationCommands,
  ...integrationCommands,
  ...archiveCommands,
  ...appealCommands,
  ...eventCommands,
  ...voiceCommands,
  ...announceCommands,
  ...wordCommands,
  ...reportCommands,
  ...healthCommands,
];

/* ═══════════════════════════════════════════════════════════════════════
   NOMI INGLESI

   I comandi sono in italiano perché il bot lo è, e perché `/bandisci` è più
   chiaro di `/ban` per chi non modera da anni. Ma chi modera da anni ha nelle
   dita `ban`, `kick`, `warn`: sono le parole con cui ha imparato, e cercare la
   traduzione mentre serve agire è tempo perso proprio nel momento peggiore.

   Discord non ha gli alias, quindi si registra un secondo comando che punta
   alla stessa funzione. Costa una voce nell'elenco — il limite è cento per
   server, qui si è largamente sotto — e non duplica una riga di logica: il
   giorno in cui `/bandisci` cambia comportamento, `/ban` cambia con lui.
   ═══════════════════════════════════════════════════════════════════════ */

const PSEUDONIMI: Record<string, string> = {
  avverti: 'warn',
  silenzia: 'mute',
  'rimuovi-silenzio': 'unmute',
  espelli: 'kick',
  bandisci: 'ban',
  'revoca-ban': 'unban',
  pulisci: 'purge',
  utente: 'whois',
  nota: 'note',
  quarantena: 'quarantine',
  segnala: 'report',
  salute: 'health',
  azioni: 'actions',
  parole: 'words',
  diagnosi: 'diagnosis',
  panico: 'panic',
  verifica: 'verify',
  'prepara-server': 'setup',
  annunci: 'announcements',
  archivio: 'archive',
  sondaggio: 'poll',
  ticket: 'tickets',
  stato: 'status',
  'dì': 'say',
};

/** Lo stesso comando con un altro nome: nessuna logica duplicata. */
function conNomeInglese(command: Command, nome: string): Command {
  const json = command.data.toJSON();
  const dati = { ...json, name: nome };

  return {
    ...command,
    // Un oggetto minimo con ciò che serve davvero: `name` per lo smistamento,
    // `toJSON` per la registrazione. Ricostruire il builder intero
    // significherebbe riscrivere tutte le opzioni, cioè avere due dichiarazioni
    // dello stesso comando che possono divergere.
    data: { name: nome, toJSON: () => dati } as unknown as Command['data'],
  };
}

const alias: Command[] = commands
  .filter((command) => PSEUDONIMI[command.data.name])
  .map((command) => conNomeInglese(command, PSEUDONIMI[command.data.name]!));

export const commandMap = new Map(
  [...commands, ...alias].map((command) => [command.data.name, command]),
);

/** Tutto ciò che va registrato su Discord: comandi e loro nomi inglesi. */
export const commandsDaRegistrare: Command[] = [...commands, ...alias];

/**
 * Smistamento dei comandi.
 *
 * I comandi integrati hanno la precedenza sui personalizzati: altrimenti
 * chiunque possa creare comandi dal pannello potrebbe sovrascrivere `/lockdown`
 * o `/backup` con qualcosa di innocuo, disattivando le difese senza toccarne la
 * configurazione.
 */
export async function handleCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'I comandi di ANGEL funzionano solo dentro un server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  /*
   * Se la configurazione non si carica, il comando non parte nemmeno — e
   * finora non partiva *in silenzio*: l'eccezione risaliva prima di qualunque
   * risposta, e chi aveva scritto il comando vedeva solo «l'applicazione non
   * ha risposto», che è vero per qualsiasi causa e non aiuta con nessuna.
   *
   * È successo davvero, con il disco pieno: il database rifiutava, e tutti i
   * comandi sembravano semplicemente rotti.
   */
  const config = await getGuildConfig(interaction.guildId).catch((errore: unknown) => {
    log.error({ err: errore, guildId: interaction.guildId }, 'configurazione non caricata');
    return null;
  });

  if (!config) {
    await interaction
      .reply({
        content:
          '⚠️ Non riesco a leggere la configurazione di questo server: probabilmente il database ' +
          'non risponde. Prova `/salute` per vedere quale pezzo è in difficoltà.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
    return;
  }

  const builtin = commandMap.get(interaction.commandName);

  if (builtin) {
    if (builtin.ownerOnly && !isBotOwner(interaction.user.id)) {
      await interaction.reply({
        content: t(config.general.locale, 'common.noPermission'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // I permessi predefiniti di un comando slash sono modificabili dagli
    // amministratori del server: il controllo va rifatto qui, altrimenti
    // basterebbe cambiarli nelle impostazioni per aggirarlo.
    if (builtin.requiredPermissions?.length) {
      const member = interaction.member as GuildMember | null;
      const allowed =
        isBotOwner(interaction.user.id) ||
        builtin.requiredPermissions.every((permission) => member?.permissions.has(permission));
      if (!allowed) {
        await interaction.reply({
          content: t(config.general.locale, 'common.noPermission'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    try {
      await builtin.execute({ client, interaction, config });

      // La registrazione dell'evento sta **fuori** dal destino del comando: se
      // fallisse dentro il `try`, un comando andato a buon fine verrebbe
      // sostituito dal messaggio d'errore, e chi lo ha eseguito crederebbe che
      // non abbia funzionato mentre invece ha funzionato benissimo.
      void recordEvent(client, {
        guildId: interaction.guildId,
        type: 'COMMAND_USED',
        actorId: interaction.user.id,
        actorTag: interaction.user.tag,
        channelId: interaction.channelId,
        summary: `\`/${interaction.commandName}\``,
        payload: {
          options: interaction.options.data.map((option) => ({
            name: option.name,
            value: option.value,
          })),
        },
      }).catch(() => undefined);
    } catch (error) {
      log.error({ err: error, command: interaction.commandName }, 'comando fallito');
      const message = t(config.general.locale, 'common.error');
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(() => undefined);
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
    return;
  }

  const custom = (await loadCustomCommands(interaction.guildId)).find(
    (command) => command.name === interaction.commandName,
  );
  if (!custom) return;

  await executeCustomCommand(client, interaction, custom, config).catch((error) =>
    log.error({ err: error, command: interaction.commandName }, 'comando personalizzato fallito'),
  );
}

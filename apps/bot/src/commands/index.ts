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
];

export const commandMap = new Map(commands.map((command) => [command.data.name, command]));

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
      content: 'I comandi di Aegis funzionano solo dentro un server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = await getGuildConfig(interaction.guildId);
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
      await recordEvent(client, {
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
      });
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

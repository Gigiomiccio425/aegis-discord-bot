import type {
  ChatInputCommandInteraction,
  Client,
  PermissionResolvable,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { GuildConfig } from '@aegis/shared';

export interface CommandContext {
  client: Client;
  interaction: ChatInputCommandInteraction;
  config: GuildConfig;
}

export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;
  /**
   * Permessi Discord richiesti *in aggiunta* a quelli dichiarati nel comando.
   * Il controllo lato server serve perché i permessi di default del comando
   * sono modificabili dagli amministratori del server.
   */
  requiredPermissions?: PermissionResolvable[];
  /** Solo per i proprietari del bot. */
  ownerOnly?: boolean;
  execute: (context: CommandContext) => Promise<void>;
}

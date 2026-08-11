import {
  ApplicationCommandOptionType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Role,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import {
  CommandStep,
  CustomCommandSchema,
  RedisKeys,
  type CustomCommand,
  type GuildConfig,
  type Persona,
} from '@angel/shared';
import { getRedis } from '../core/redis.js';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';
import { sendAsPersona } from './webhooks.js';

const log = childLogger('customCommands');

/* ═══════════════════════════════════════════════════════════════════════
   COMANDI PERSONALIZZATI

   L'idea: dal pannello si compone una sequenza — questa persona dice questo,
   tre secondi dopo quest'altra risponde, poi al destinatario viene assegnato un
   ruolo — e la sequenza diventa un comando slash utilizzabile solo da chi ha i
   ruoli indicati.

   L'esecuzione è volutamente lineare e senza cicli: il builder è per chi non
   programma, e un linguaggio con salti all'indietro produrrebbe comandi che
   non finiscono mai. L'unico costrutto è la condizione, che salta in avanti.
   ═══════════════════════════════════════════════════════════════════════ */

/** Comandi caricati, per server. Ricaricati quando il pannello li modifica. */
const cache = new Map<string, CustomCommand[]>();

export async function loadCustomCommands(guildId: string): Promise<CustomCommand[]> {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const prisma = getPrisma();
  const records = await prisma.customCommand.findMany({
    where: { guildId, enabled: true },
  });

  const commands: CustomCommand[] = [];
  for (const record of records) {
    const parsed = CustomCommandSchema.safeParse({
      id: record.id,
      name: record.name,
      description: record.description,
      enabled: record.enabled,
      allowedRoleIds: record.allowedRoleIds,
      deniedRoleIds: record.deniedRoleIds,
      allowedChannelIds: record.allowedChannelIds,
      args: record.args,
      steps: record.steps,
      cooldownSec: record.cooldownSec,
      guildCooldownSec: record.guildCooldownSec,
      ephemeralAck: record.ephemeralAck,
    });
    if (parsed.success) commands.push(parsed.data);
    else log.warn({ guildId, name: record.name, issues: parsed.error.issues }, 'comando non valido');
  }

  cache.set(guildId, commands);
  return commands;
}

export function invalidateCustomCommands(guildId: string): void {
  cache.delete(guildId);
}

/** Traduce la definizione salvata in un comando slash da registrare su Discord. */
export function buildSlashCommand(command: CustomCommand): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName(command.name)
    .setDescription(command.description)
    .setDMPermission(false);

  for (const arg of command.args) {
    switch (arg.type) {
      case 'USER':
        builder.addUserOption((option) =>
          option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
        );
        break;
      case 'CHANNEL':
        builder.addChannelOption((option) =>
          option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
        );
        break;
      case 'ROLE':
        builder.addRoleOption((option) =>
          option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
        );
        break;
      case 'NUMBER':
        builder.addNumberOption((option) =>
          option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
        );
        break;
      case 'BOOLEAN':
        builder.addBooleanOption((option) =>
          option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
        );
        break;
      case 'CHOICE':
        builder.addStringOption((option) =>
          option
            .setName(arg.name)
            .setDescription(arg.description)
            .setRequired(arg.required)
            .addChoices(
              ...arg.choices.slice(0, 25).map((choice) => ({ name: choice.name, value: choice.value })),
            ),
        );
        break;
      default:
        builder.addStringOption((option) =>
          option.setName(arg.name).setDescription(arg.description).setRequired(arg.required),
        );
    }
  }

  return builder;
}

export async function executeCustomCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
  command: CustomCommand,
  config: GuildConfig,
): Promise<void> {
  const guild = interaction.guild;
  const member = interaction.member as GuildMember | null;
  if (!guild || !member) return;

  /* ── Permessi ──────────────────────────────────────────────────────── */
  if (command.deniedRoleIds.some((roleId) => member.roles.cache.has(roleId))) {
    await interaction.reply({ content: 'Non puoi usare questo comando.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (
    command.allowedRoleIds.length > 0 &&
    !command.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId))
  ) {
    await interaction.reply({
      content: 'Questo comando è riservato a chi ha un ruolo specifico.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (
    command.allowedChannelIds.length > 0 &&
    !command.allowedChannelIds.includes(interaction.channelId)
  ) {
    await interaction.reply({
      content: 'Questo comando non è utilizzabile in questo canale.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  /* ── Cooldown ──────────────────────────────────────────────────────── */
  const redis = getRedis();
  if (command.cooldownSec > 0) {
    const key = RedisKeys.cooldown(guild.id, command.name, member.id);
    const set = await redis.set(key, '1', 'EX', command.cooldownSec, 'NX');
    if (set === null) {
      const remaining = await redis.ttl(key);
      await interaction.reply({
        content: `Aspetta ancora ${remaining}s prima di riusare \`/${command.name}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }
  if (command.guildCooldownSec > 0) {
    const key = RedisKeys.cooldown(guild.id, command.name, 'guild');
    const set = await redis.set(key, '1', 'EX', command.guildCooldownSec, 'NX');
    if (set === null) {
      const remaining = await redis.ttl(key);
      await interaction.reply({
        content: `Il comando è in pausa per tutto il server ancora ${remaining}s.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  await interaction.reply({
    content: `✅ \`/${command.name}\``,
    flags: command.ephemeralAck ? MessageFlags.Ephemeral : undefined,
  });

  /* ── Variabili disponibili nei testi ───────────────────────────────── */
  const args = collectArgs(interaction, command);
  const prisma = getPrisma();
  const record = await prisma.customCommand
    .update({
      where: { guildId_name: { guildId: guild.id, name: command.name } },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    })
    .catch(() => null);

  const personas = await loadPersonas(guild.id);
  const variables: Record<string, string> = {
    user: `<@${member.id}>`,
    'user.name': member.displayName,
    guild: guild.name,
    channel: `<#${interaction.channelId}>`,
    count: String(record?.useCount ?? 1),
  };
  for (const [name, value] of Object.entries(args)) {
    variables[`arg:${name}`] = value;
  }

  await recordEvent(client, {
    guildId: guild.id,
    type: 'CUSTOM_COMMAND_USED',
    actorId: member.id,
    actorTag: member.user.tag,
    channelId: interaction.channelId,
    summary: `Comando \`/${command.name}\` eseguito`,
    payload: { args },
  });

  // L'esecuzione prosegue in background: una sequenza con pause di tre secondi
  // supererebbe il limite di risposta dell'interazione.
  void runSteps(client, guild, interaction, command, personas, variables, args, config).catch(
    (error) => log.error({ err: error, command: command.name }, 'esecuzione comando fallita'),
  );
}

async function runSteps(
  client: Client,
  guild: Guild,
  interaction: ChatInputCommandInteraction,
  command: CustomCommand,
  personas: Map<string, Persona>,
  variables: Record<string, string>,
  args: Record<string, string>,
  config: GuildConfig,
): Promise<void> {
  const member = interaction.member as GuildMember;
  let index = 0;

  while (index < command.steps.length) {
    const step = command.steps[index] as CommandStep;
    index++;

    switch (step.kind) {
      case 'WAIT':
        await sleep(step.seconds * 1000);
        break;

      case 'PERSONA_MESSAGE': {
        const persona = personas.get(step.personaId);
        if (!persona) {
          log.warn({ personaId: step.personaId }, 'persona non trovata');
          break;
        }
        const channelId = step.channelId ?? interaction.channelId;
        const content = interpolate(step.content, variables);

        const messageId = await sendAsPersona(guild, channelId, {
          name: persona.name,
          avatarUrl: persona.avatarUrl,
          content,
          embed: step.asEmbed
            ? {
                title: step.embedTitle ? interpolate(step.embedTitle, variables) : undefined,
                color: persona.color ? Number.parseInt(persona.color.slice(1), 16) : undefined,
                imageUrl: step.embedImageUrl,
              }
            : undefined,
          allowMentions: step.allowMentions,
        });

        // Tracciabilità: il messaggio appare firmato dalla persona, ma nel
        // registro resta scritto chi lo ha davvero provocato.
        await recordEvent(client, {
          guildId: guild.id,
          type: 'PERSONA_MESSAGE_SENT',
          actorId: member.id,
          actorTag: member.user.tag,
          channelId,
          messageId,
          summary: `**${persona.name}**: ${content.slice(0, 200)}`,
          payload: { personaId: persona.id, command: command.name },
        });

        await getPrisma()
          .persona.update({
            where: { id: step.personaId },
            data: { messageCount: { increment: 1 } },
          })
          .catch(() => undefined);
        break;
      }

      case 'ADD_ROLE':
      case 'REMOVE_ROLE': {
        const target = await resolveTarget(guild, interaction, step.target, step.argName, args);
        if (!target) break;

        const role = guild.roles.cache.get(step.roleId);
        if (!role) break;

        // Un comando personalizzato non deve poter distribuire permessi:
        // sarebbe una scalata di privilegi confezionata dal pannello.
        if (isPrivilegedRole(role, config)) {
          log.warn(
            { roleId: role.id, command: command.name },
            'ruolo con permessi pericolosi rifiutato in un comando personalizzato',
          );
          break;
        }

        if (step.kind === 'ADD_ROLE') {
          await target.roles.add(role, `Comando /${command.name}`).catch(() => undefined);
          if (step.durationSec > 0) {
            setTimeout(() => {
              void target.roles.remove(role, `Scadenza da /${command.name}`).catch(() => undefined);
            }, step.durationSec * 1000);
          }
        } else {
          await target.roles.remove(role, `Comando /${command.name}`).catch(() => undefined);
        }
        break;
      }

      case 'REACT': {
        const channel = guild.channels.cache.get(interaction.channelId);
        if (!channel?.isTextBased()) break;
        const messages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
        await messages?.first()?.react(step.emoji).catch(() => undefined);
        break;
      }

      case 'DM_USER': {
        const target = await resolveTarget(guild, interaction, step.target, step.argName, args);
        await target?.send(interpolate(step.content, variables)).catch(() => undefined);
        break;
      }

      case 'CONDITION': {
        const passed = evaluateCondition(step, interaction, args, member);
        if (!passed) index += step.skipSteps;
        break;
      }

      default:
        break;
    }
  }
}

function evaluateCondition(
  step: Extract<CommandStep, { kind: 'CONDITION' }>,
  interaction: ChatInputCommandInteraction,
  args: Record<string, string>,
  member: GuildMember,
): boolean {
  switch (step.check) {
    case 'ARG_EQUALS':
      return (args[step.argName] ?? '').toLowerCase() === step.value.toLowerCase();
    case 'ARG_CONTAINS':
      return (args[step.argName] ?? '').toLowerCase().includes(step.value.toLowerCase());
    case 'INVOKER_HAS_ROLE':
      return step.roleId ? member.roles.cache.has(step.roleId) : false;
    case 'TARGET_HAS_ROLE': {
      const target = interaction.options.getMember(step.argName) as GuildMember | null;
      return step.roleId && target ? target.roles.cache.has(step.roleId) : false;
    }
    case 'RANDOM_CHANCE':
      return Math.random() * 100 < step.chance;
    default:
      return true;
  }
}

async function resolveTarget(
  guild: Guild,
  interaction: ChatInputCommandInteraction,
  target: 'INVOKER' | 'ARG_USER',
  argName: string,
  args: Record<string, string>,
): Promise<GuildMember | null> {
  if (target === 'INVOKER') return interaction.member as GuildMember;
  const raw = args[argName];
  if (!raw) return null;
  const id = raw.replace(/[<@!>]/g, '');
  return guild.members.fetch(id).catch(() => null);
}

function collectArgs(
  interaction: ChatInputCommandInteraction,
  command: CustomCommand,
): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of command.args) {
    const option = interaction.options.get(arg.name);
    if (!option) continue;
    switch (option.type) {
      case ApplicationCommandOptionType.User:
        args[arg.name] = option.user?.id ?? '';
        break;
      case ApplicationCommandOptionType.Channel:
        args[arg.name] = option.channel?.id ?? '';
        break;
      case ApplicationCommandOptionType.Role:
        args[arg.name] = option.role?.id ?? '';
        break;
      default:
        args[arg.name] = String(option.value ?? '');
    }
  }
  return args;
}

/**
 * Sostituisce i segnaposto.
 *
 * `{random:a|b|c}` è risolto per ultimo e a ogni occorrenza: due segnaposto
 * casuali nello stesso testo devono poter dare risultati diversi.
 */
export function interpolate(template: string, variables: Record<string, string>): string {
  let output = template;

  for (const [key, value] of Object.entries(variables)) {
    output = output.replaceAll(`{${key}}`, value);
  }

  output = output.replace(/\{random:([^}]+)\}/g, (_match, options: string) => {
    const choices = options.split('|');
    return choices[Math.floor(Math.random() * choices.length)] ?? '';
  });

  // I segnaposto non riconosciuti restano visibili: nasconderli renderebbe
  // impossibile accorgersi di un errore di battitura nel pannello.
  return output;
}

/**
 * Un comando personalizzato non deve poter assegnare ruoli con permessi:
 * sarebbe una scalata di privilegi confezionata dal pannello, utilizzabile da
 * chiunque abbia il ruolo abilitato a lanciare il comando.
 */
function isPrivilegedRole(role: Role, config: GuildConfig): boolean {
  return config.security.antiNuke.dangerousPermissions.some((name) => {
    const flag = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
    return typeof flag === 'bigint' && role.permissions.has(flag);
  });
}

async function loadPersonas(guildId: string): Promise<Map<string, Persona>> {
  const prisma = getPrisma();
  const records = await prisma.persona.findMany({ where: { guildId } });
  return new Map(
    records.map((record) => [
      record.id,
      {
        id: record.id,
        name: record.name,
        avatarUrl: record.avatarUrl,
        color: record.color,
        description: record.description,
      },
    ]),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

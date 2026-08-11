import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  version as djsVersion,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import { MODULE_REGISTRY } from '@angel/shared';
import type { Command } from './types.js';
import { t } from '../core/i18n.js';
import { missingBotPermissions } from '../core/permissions.js';

const ping: Command = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Verifica che il bot risponda e mostra la latenza')
    .setDMPermission(false),
  async execute({ client, interaction }) {
    const started = Date.now();
    await interaction.reply({ content: 'Misuro…', flags: MessageFlags.Ephemeral });
    const roundTrip = Date.now() - started;
    await interaction.editReply(
      `🏓 Latenza gateway **${Math.round(client.ws.ping)}ms** · risposta **${roundTrip}ms**\n` +
        `discord.js ${djsVersion} · Node ${process.version}`,
    );
  },
};

/**
 * Riepilogo dello stato dei moduli.
 *
 * La configurazione vera si modifica dal pannello: replicarla in comandi slash
 * significherebbe mantenere due interfacce per le stesse centinaia di opzioni.
 * Qui si mostra solo cosa è attivo e cosa manca perché funzioni.
 */
const config: Command = {
  data: new SlashCommandBuilder()
    .setName('stato')
    .setDescription('Mostra lo stato dei moduli di sicurezza di questo server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageGuild],
  async execute({ client, interaction, config: guildConfig }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const lines = MODULE_REGISTRY.map((module) => {
      const enabled = readPath(guildConfig, `${module.key}.enabled`) === true;
      return `${enabled ? '🟢' : '⚪'} ${module.label}`;
    });

    const me = await interaction.guild!.members.fetchMe();
    const missing = missingBotPermissions(me);

    const warnings: string[] = [];
    if (missing.length > 0) {
      warnings.push(`⚠️ Permessi mancanti al bot: \`${missing.join('`, `')}\``);
    }
    if (!guildConfig.general.quarantineRoleId) {
      warnings.push('⚠️ Ruolo di quarantena non configurato: le difese non potranno isolare nessuno.');
    }
    if (!guildConfig.general.alertChannelId && !guildConfig.logging.defaultChannelId) {
      warnings.push('⚠️ Nessun canale di log configurato: gli allarmi non hanno dove comparire.');
    }
    if (guildConfig.general.dryRun) {
      warnings.push('🧪 Modalità prova attiva: i moduli valutano e registrano ma non sanzionano.');
    }
    if (!guildConfig.general.staffCodeword) {
      warnings.push(
        'ℹ️ Parola d\'ordine dello staff non impostata: è la sola difesa pratica contro chi imita ' +
          'moderatori con voce o video generati da IA.',
      );
    }

    const prisma = getPrisma();
    const [cases, events] = await Promise.all([
      prisma.case.count({ where: { guildId: interaction.guildId!, status: 'ACTIVE' } }),
      prisma.auditEvent.count({
        where: {
          guildId: interaction.guildId!,
          category: 'SECURITY',
          createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
        },
      }),
    ]);

    const embed = new EmbedBuilder()
      .setTitle('Stato di ANGEL')
      .setColor(warnings.length > 0 ? 0xff9900 : 0x2ecc71)
      .setDescription(lines.join('\n'))
      .addFields(
        { name: 'Casi attivi', value: String(cases), inline: true },
        { name: 'Eventi di sicurezza (7 giorni)', value: String(events), inline: true },
        { name: 'Lingua', value: guildConfig.general.locale, inline: true },
      )
      .setFooter({ text: 'Configurazione completa dal pannello web' });

    if (warnings.length > 0) {
      embed.addFields({ name: 'Da sistemare', value: warnings.join('\n') });
    }

    await interaction.editReply({ embeds: [embed] });
    void client;
  },
};

/**
 * Verifica dell'identità dello staff.
 *
 * Contro un audio o un video generati da IA non esiste rilevamento affidabile:
 * bastano tre secondi di voce per clonarla con precisione superiore al 95%, e
 * gli strumenti sono gratuiti. L'unica difesa pratica è una parola concordata
 * in anticipo, che chi imita non può conoscere.
 */
const verifyStaff: Command = {
  data: new SlashCommandBuilder()
    .setName('verifica-staff')
    .setDescription('Verifica se chi ti ha contattato fa davvero parte dello staff')
    .addStringOption((option) =>
      option
        .setName('parola')
        .setDescription("La parola d'ordine che ti è stata comunicata")
        .setRequired(true),
    )
    .setDMPermission(false),
  async execute({ interaction, config: guildConfig }) {
    const provided = interaction.options.getString('parola', true);
    const expected = guildConfig.general.staffCodeword;
    const locale = guildConfig.general.locale;

    if (!expected) {
      await interaction.reply({
        content: t(locale, 'staff.codewordMissing'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const ok = provided.trim().toLowerCase() === expected.trim().toLowerCase();
    await interaction.reply({
      content: ok
        ? t(locale, 'staff.codewordOk')
        : `${t(locale, 'staff.codewordBad')}\n\n` +
          'Lo staff non chiede mai token, password o codici di verifica, e non ti chiederà mai di ' +
          'inquadrare un codice QR.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

const panel: Command = {
  data: new SlashCommandBuilder()
    .setName('pannello')
    .setDescription('Link al pannello di controllo web')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  async execute({ interaction }) {
    const url = process.env.PUBLIC_URL ?? 'http://localhost:8080';
    await interaction.reply({
      content: `🔗 Pannello di controllo: ${url}/g/${interaction.guildId}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object' && key in value) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

export const generalCommands: Command[] = [ping, config, verifyStaff, panel];

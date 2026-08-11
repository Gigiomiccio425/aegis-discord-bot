import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getPrisma } from '@aegis/db';
import { scanContent } from '@aegis/scanner';
import type { Command } from './types.js';
import {
  disableLockdown,
  enableLockdown,
  readLockdownState,
} from '../core/enforcer.js';
import { createSnapshot, restoreSnapshot } from '../security/snapshot.js';
import { auditWebhooks } from '../security/webhookGuard.js';
import { auditBots } from '../security/botGuard.js';
import { checkWatchedInvites } from '../security/inviteGuard.js';
import { syncAutoModRules } from '../security/automodSync.js';
import { buildDeps } from '../security/contentGuard.js';
import { recordEvent } from '../logging/auditLogger.js';
import { isBotOwner } from '../core/permissions.js';

const lockdown: Command = {
  data: new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Blocca o sblocca il server')
    .addSubcommand((sub) =>
      sub
        .setName('attiva')
        .setDescription('Canali in sola lettura e inviti in pausa')
        .addStringOption((option) =>
          option.setName('motivo').setDescription('Motivo').setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('minuti')
            .setDescription('Sblocco automatico dopo N minuti (0 = manuale)')
            .setMinValue(0)
            .setMaxValue(1440),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoca')
        .setDescription('Sblocca il server')
        .addBooleanOption((option) =>
          option
            .setName('forza')
            .setDescription(
              'Riapre ogni canale chiuso a @everyone, anche se il bot non risulta averlo bloccato',
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('stato').setDescription('Verifica se il lockdown è attivo'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageGuild],
  async execute({ client, interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild!;

    if (sub === 'stato') {
      const state = await readLockdownState(guild.id);
      if (!state) {
        await interaction.editReply(
          '🔓 Lockdown non attivo.\n' +
            '-# Se i canali risultano comunque chiusi, usa `/lockdown revoca forza:true`.',
        );
        return;
      }
      const da = Math.round((Date.now() - state.startedAt) / 60000);
      await interaction.editReply(
        `🔒 Lockdown **attivo** da ${da} minuti.\n` +
          `Motivo: ${state.reason}\n` +
          `Canali chiusi: ${state.channels.length}\n` +
          (state.expiresAt
            ? `Revoca automatica: <t:${Math.floor(state.expiresAt / 1000)}:R>`
            : 'Revoca: solo manuale'),
      );
      return;
    }

    if (sub === 'attiva') {
      const reason = interaction.options.getString('motivo', true);
      const minutes = interaction.options.getInteger('minuti') ?? 0;
      const result = await enableLockdown(
        client,
        guild,
        config,
        `${reason} (da ${interaction.user.tag})`,
        minutes * 60,
      );
      if (result.alreadyActive) {
        await interaction.editReply('Il lockdown era già attivo: nessuna modifica.');
        return;
      }
      await interaction.editReply(
        `🔒 Server bloccato. Canali chiusi: ${result.locked}.` +
          (minutes > 0 ? ` Sblocco automatico fra ${minutes} minuti.` : ''),
      );
      return;
    }

    const force = interaction.options.getBoolean('forza') ?? false;
    const result = await disableLockdown(
      client,
      guild,
      `Revoca manuale di ${interaction.user.tag}`,
      { force, config },
    );

    if (!result.hadState && !force) {
      await interaction.editReply(
        'Il lockdown non risulta attivo.\n' +
          '-# Se i canali sono comunque chiusi, ripeti con `forza:true`: riapre tutto ciò che nega la scrittura a @everyone.',
      );
      return;
    }
    await interaction.editReply(`🔓 Lockdown revocato. Canali riaperti: ${result.unlocked}.`);
  },
};

/**
 * Pulsante di emergenza.
 *
 * Fa in un comando ciò che sotto attacco nessuno ha il tempo di fare a mano:
 * blocca il server, salva uno snapshot e avvisa lo staff. È pensato per essere
 * usato nel dubbio — un lockdown ingiustificato costa dieci minuti, un nuke non
 * fermato costa il server.
 */
const panic: Command = {
  data: new SlashCommandBuilder()
    .setName('panico')
    .setDescription('Emergenza: blocca il server, salva un backup e avvisa lo staff')
    .addStringOption((option) =>
      option.setName('motivo').setDescription('Cosa sta succedendo').setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageGuild],
  async execute({ client, interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild!;
    const reason = interaction.options.getString('motivo', true);

    await recordEvent(client, {
      guildId: guild.id,
      type: 'SECURITY_PANIC',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      severity: 100,
      summary: `🆘 **Emergenza attivata da <@${interaction.user.id}>**\n${reason}`,
    });

    const [snapshotId] = await Promise.all([
      createSnapshot(guild, 'EMERGENCY', interaction.user.id),
      enableLockdown(client, guild, config, `Emergenza: ${reason}`, 0),
    ]);

    await interaction.editReply(
      '🆘 Emergenza attivata.\n' +
        '• Server bloccato (canali in sola lettura, inviti in pausa)\n' +
        `• Backup salvato: \`${snapshotId}\`\n` +
        '• Staff avvisato\n\n' +
        'Quando la situazione è sotto controllo: `/lockdown revoca`',
    );
  },
};

const backup: Command = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Backup della struttura del server')
    .addSubcommand((sub) => sub.setName('crea').setDescription('Salva lo stato attuale'))
    .addSubcommand((sub) => sub.setName('lista').setDescription('Elenca i backup disponibili'))
    .addSubcommand((sub) =>
      sub
        .setName('ripristina')
        .setDescription('Ripristina un backup (ruoli e canali mancanti)')
        .addStringOption((option) =>
          option.setName('id').setDescription('ID del backup').setRequired(true),
        )
        .addBooleanOption((option) =>
          option.setName('ruoli').setDescription('Ricrea i ruoli mancanti'),
        )
        .addBooleanOption((option) =>
          option.setName('canali').setDescription('Ricrea i canali mancanti'),
        )
        .addBooleanOption((option) =>
          option.setName('ruoli-membri').setDescription('Restituisce i ruoli ai membri'),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.Administrator],
  async execute({ client, interaction }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild!;
    const prisma = getPrisma();

    if (sub === 'crea') {
      const id = await createSnapshot(guild, 'MANUAL', interaction.user.id);
      await recordEvent(client, {
        guildId: guild.id,
        type: 'SECURITY_SNAPSHOT_CREATED',
        actorId: interaction.user.id,
        summary: `Backup manuale creato: \`${id}\``,
      });
      await interaction.editReply(
        `✅ Backup creato: \`${id}\`\n\n` +
          '⚠️ Nota: un backup conserva ruoli, canali, permessi, emoji e impostazioni. ' +
          'Discord **non consente** di ripristinare la cronologia dei messaggi — quella è ' +
          'recuperabile solo dall\'archivio del bot, e come ricostruzione.',
      );
      return;
    }

    if (sub === 'lista') {
      const snapshots = await prisma.snapshot.findMany({
        where: { guildId: guild.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      if (snapshots.length === 0) {
        await interaction.editReply('Nessun backup presente. Creane uno con `/backup crea`.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('Backup disponibili')
        .setColor(0x5865f2)
        .setDescription(
          snapshots
            .map(
              (snapshot) =>
                `**${snapshot.kind}** · <t:${Math.floor(snapshot.createdAt.getTime() / 1000)}:f>\n` +
                `\`${snapshot.id}\` · ${Math.round(snapshot.sizeBytes / 1024)} KB`,
            )
            .join('\n\n'),
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const id = interaction.options.getString('id', true);
    const report = await restoreSnapshot(
      guild,
      id,
      {
        roles: interaction.options.getBoolean('ruoli') ?? true,
        channels: interaction.options.getBoolean('canali') ?? true,
        permissions: true,
        memberRoles: interaction.options.getBoolean('ruoli-membri') ?? false,
        settings: false,
      },
      interaction.user.id,
    );

    await recordEvent(client, {
      guildId: guild.id,
      type: 'SECURITY_SNAPSHOT_RESTORED',
      actorId: interaction.user.id,
      severity: 60,
      summary:
        `Backup \`${id}\` ripristinato: ${report.rolesCreated} ruoli, ` +
        `${report.channelsCreated} canali, ${report.membersRestored} membri`,
      payload: report as unknown as Record<string, unknown>,
    });

    await interaction.editReply(
      `✅ Ripristino completato\n` +
        `• Ruoli creati: ${report.rolesCreated}\n` +
        `• Canali creati: ${report.channelsCreated}\n` +
        `• Permessi ripristinati: ${report.overwritesRestored}\n` +
        `• Membri con ruoli restituiti: ${report.membersRestored}` +
        (report.errors.length > 0
          ? `\n\n⚠️ Errori:\n${report.errors.slice(0, 5).join('\n')}`
          : ''),
    );
  },
};

/** Revisione di sicurezza su richiesta: webhook, bot, inviti sorvegliati. */
const audit: Command = {
  data: new SlashCommandBuilder()
    .setName('audit')
    .setDescription('Revisione di sicurezza: webhook, bot e inviti sorvegliati')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageGuild],
  async execute({ client, interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild!;

    const [webhooks, bots, automod] = await Promise.all([
      auditWebhooks(client, guild, config),
      auditBots(client, guild, config),
      config.security.autoMod.enabled
        ? syncAutoModRules(client, guild, config)
        : Promise.resolve(null),
      checkWatchedInvites(client, guild, config),
    ]);

    const prisma = getPrisma();
    const riskyBots = await prisma.botRecord.findMany({
      where: { guildId: guild.id, removedAt: null, riskScore: { gte: 60 } },
      orderBy: { riskScore: 'desc' },
      take: 10,
    });

    const embed = new EmbedBuilder()
      .setTitle('Revisione di sicurezza')
      .setColor(webhooks.unauthorized > 0 || riskyBots.length > 0 ? 0xff9900 : 0x2ecc71)
      .addFields(
        { name: 'Webhook totali', value: String(webhooks.total), inline: true },
        { name: 'Webhook non autorizzati', value: String(webhooks.unauthorized), inline: true },
        { name: 'Bot esaminati', value: String(bots.checked), inline: true },
      );

    if (riskyBots.length > 0) {
      embed.addFields({
        name: 'Bot con permessi rischiosi',
        value: riskyBots
          .map((bot) => `**${bot.name}** — ${bot.riskScore}/100 · ${bot.riskFlags.join(', ')}`)
          .join('\n'),
      });
    }

    if (automod) {
      embed.addFields({
        name: 'AutoMod nativo',
        value:
          `${automod.created.length} regole create · ${automod.updated.length} aggiornate · ` +
          `${automod.removed.length} rimosse` +
          (automod.errors.length > 0 ? `\n⚠️ ${automod.errors.slice(0, 3).join('; ')}` : ''),
      });
    }

    embed.setFooter({
      text: 'Un bot con Administrator rende il server compromettibile tramite la catena di fornitura del bot stesso.',
    });

    await interaction.editReply({ embeds: [embed] });
  },
};

/** Analisi manuale di un link o di un testo sospetto. */
const scan: Command = {
  data: new SlashCommandBuilder()
    .setName('scansiona')
    .setDescription('Analizza un link o un testo sospetto senza aprirlo')
    .addStringOption((option) =>
      option.setName('contenuto').setDescription('Link o testo da esaminare').setRequired(true),
    )
    .setDMPermission(false),
  async execute({ interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const content = interaction.options.getString('contenuto', true);

    const result = await scanContent(
      { text: content, skipOcr: true },
      config.scanner,
      buildDeps(interaction.guildId!, config),
    );

    const embed = new EmbedBuilder()
      .setTitle('Esito dell\'analisi')
      .setColor(
        result.verdict === 'MALICIOUS' ? 0xff0000 : result.verdict === 'SUSPICIOUS' ? 0xff9900 : 0x2ecc71,
      )
      .setDescription(
        `**Verdetto: ${result.verdict}** · punteggio ${result.score}/100\n` +
          `Analisi completata in ${result.elapsedMs}ms`,
      );

    if (result.urls.length > 0) {
      embed.addFields({
        name: 'Link trovati',
        value: result.urls
          .map((url) => `• \`${url.host}\`${url.finalHost ? ` → \`${url.finalHost}\`` : ''}`)
          .join('\n')
          .slice(0, 1024),
      });
    }

    if (result.findings.length > 0) {
      embed.addFields({
        name: 'Rilevamenti',
        value: result.findings
          .map((finding) => `• **${finding.code}** (+${finding.score}) ${finding.detail}`)
          .join('\n')
          .slice(0, 1024),
      });
    } else {
      embed.addFields({ name: 'Rilevamenti', value: 'Nessun segnale sospetto.' });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

/** Diagnostica riservata ai proprietari del bot. */
const diagnostics: Command = {
  data: new SlashCommandBuilder()
    .setName('diagnostica')
    .setDescription('Stato tecnico del bot (solo proprietari)')
    .setDMPermission(false),
  ownerOnly: true,
  async execute({ client, interaction }) {
    if (!isBotOwner(interaction.user.id)) {
      await interaction.reply({ content: 'Comando riservato.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const prisma = getPrisma();
    const [guilds, events, signatures] = await Promise.all([
      prisma.guild.count({ where: { active: true } }),
      prisma.auditEvent.count(),
      prisma.threatSignature.count({ where: { enabled: true } }),
    ]);

    const memory = process.memoryUsage();
    await interaction.editReply(
      [
        `**Server attivi:** ${guilds} (in cache: ${client.guilds.cache.size})`,
        `**Eventi registrati:** ${events.toLocaleString('it-IT')}`,
        `**Firme di minaccia attive:** ${signatures.toLocaleString('it-IT')}`,
        `**Memoria:** ${Math.round(memory.heapUsed / 1024 / 1024)} MB heap · ${Math.round(memory.rss / 1024 / 1024)} MB RSS`,
        `**Uptime:** ${Math.floor(process.uptime() / 60)} minuti`,
        `**Latenza gateway:** ${Math.round(client.ws.ping)}ms`,
      ].join('\n'),
    );
  },
};

export const securityCommands: Command[] = [lockdown, panic, backup, audit, scan, diagnostics];

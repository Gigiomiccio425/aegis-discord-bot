import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getPrisma } from '@aegis/db';
import type { Command } from './types.js';
import { recordEvent } from '../logging/auditLogger.js';
import { liftQuarantine } from '../core/enforcer.js';

/* ═══════════════════════════════════════════════════════════════════════
   APPELLI

   Una difesa automatica sbaglia: è nella sua natura, e il modo di conviverci
   non è alzare le soglie finché non blocca più nulla, ma dare a chi è stato
   colpito un modo semplice di farlo notare.

   Limite dichiarato: chi è **bandito** non può usare un comando slash, perché
   non è più nel server. Il suo appello deve arrivare per altra via — un server
   di supporto, un modulo web — ed essere registrato dallo staff con
   `/appello registra`. Fingere il contrario sarebbe una funzione che non
   funziona proprio nel caso in cui serve di più.
   ═══════════════════════════════════════════════════════════════════════ */

const appeal: Command = {
  data: new SlashCommandBuilder()
    .setName('appello')
    .setDescription('Contesta un provvedimento, o gestisci gli appelli ricevuti')
    .addSubcommand((sub) =>
      sub
        .setName('invia')
        .setDescription('Contesta un provvedimento che ti riguarda')
        .addIntegerOption((option) =>
          option.setName('caso').setDescription('Numero del caso').setRequired(true).setMinValue(1),
        )
        .addStringOption((option) =>
          option
            .setName('motivo')
            .setDescription('Perché ritieni che sia sbagliato')
            .setRequired(true)
            .setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) => sub.setName('miei').setDescription('I tuoi provvedimenti e appelli'))
    .addSubcommand((sub) =>
      sub.setName('elenca').setDescription('Appelli in attesa di risposta (staff)'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('risolvi')
        .setDescription('Accoglie o respinge un appello (staff)')
        .addIntegerOption((option) =>
          option.setName('caso').setDescription('Numero del caso').setRequired(true).setMinValue(1),
        )
        .addBooleanOption((option) =>
          option
            .setName('accolto')
            .setDescription('true = provvedimento revocato, false = confermato')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('nota').setDescription('Motivazione della decisione').setMaxLength(500),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('registra')
        .setDescription("Registra un appello ricevuto fuori da Discord (staff)")
        .addIntegerOption((option) =>
          option.setName('caso').setDescription('Numero del caso').setRequired(true).setMinValue(1),
        )
        .addStringOption((option) =>
          option
            .setName('testo')
            .setDescription("Il contenuto dell'appello")
            .setRequired(true)
            .setMaxLength(1000),
        ),
    )
    .setDMPermission(false),
  async execute({ client, interaction }) {
    const prisma = getPrisma();
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand();

    const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) ?? false;

    /* ── I miei provvedimenti ───────────────────────────────────────── */
    if (sub === 'miei') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const cases = await prisma.case.findMany({
        where: { guildId, targetId: interaction.user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      if (cases.length === 0) {
        await interaction.editReply('Non risultano provvedimenti a tuo carico in questo server.');
        return;
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('I tuoi provvedimenti')
            .setColor(0x5865f2)
            .setDescription(
              cases
                .map((record) => {
                  const state = record.appealAt
                    ? record.appealResolvedAt
                      ? record.status === 'REVOKED'
                        ? '✅ appello accolto'
                        : '❌ appello respinto'
                      : '⏳ appello in attesa'
                    : record.status === 'ACTIVE'
                      ? 'contestabile con `/appello invia`'
                      : record.status.toLowerCase();
                  return (
                    `**#${record.number}** ${record.type} · <t:${Math.floor(record.createdAt.getTime() / 1000)}:d>\n` +
                    `${record.reason.slice(0, 120)}\n_${state}_`
                  );
                })
                .join('\n\n'),
            ),
        ],
      });
      return;
    }

    /* ── Invio di un appello ────────────────────────────────────────── */
    if (sub === 'invia') {
      const number = interaction.options.getInteger('caso', true);
      const text = interaction.options.getString('motivo', true);

      const record = await prisma.case.findUnique({ where: { guildId_number: { guildId, number } } });
      if (!record || record.targetId !== interaction.user.id) {
        await interaction.reply({
          content: 'Caso non trovato, oppure non riguarda te.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (record.appealAt && !record.appealResolvedAt) {
        await interaction.reply({
          content: 'Hai già un appello in attesa per questo caso.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (record.appealResolvedAt) {
        await interaction.reply({
          content: 'Questo appello è già stato deciso. Rivolgiti allo staff per un riesame.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (record.status !== 'ACTIVE') {
        await interaction.reply({
          content: 'Questo provvedimento non è più attivo: non c\'è nulla da contestare.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await prisma.case.update({
        where: { id: record.id },
        data: { appealText: text, appealAt: new Date(), status: 'APPEALED' },
      });

      await recordEvent(client, {
        guildId,
        type: 'MOD_APPEAL_OPENED',
        actorId: interaction.user.id,
        actorTag: interaction.user.tag,
        caseId: record.id,
        severity: 30,
        summary: `Appello sul caso **#${record.number}** (${record.type})`,
        fields: [{ name: 'Motivazione', value: text.slice(0, 1024) }],
      });

      await interaction.reply({
        content:
          `✅ Appello registrato per il caso **#${record.number}**. ` +
          'Lo staff lo vedrà nel registro e ti risponderà.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    /* ── Da qui in poi: solo staff ──────────────────────────────────── */
    if (!isStaff) {
      await interaction.reply({
        content: 'Questa parte del comando è riservata allo staff.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'elenca') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const pending = await prisma.case.findMany({
        where: { guildId, appealAt: { not: null }, appealResolvedAt: null },
        orderBy: { appealAt: 'asc' },
        take: 15,
      });

      await interaction.editReply({
        content:
          pending.length === 0
            ? 'Nessun appello in attesa.'
            : pending
                .map(
                  (record) =>
                    `**#${record.number}** ${record.type} · <@${record.targetId}> · ` +
                    `<t:${Math.floor((record.appealAt ?? record.createdAt).getTime() / 1000)}:R>\n` +
                    `> ${(record.appealText ?? '').slice(0, 200)}`,
                )
                .join('\n\n'),
      });
      return;
    }

    if (sub === 'registra') {
      const number = interaction.options.getInteger('caso', true);
      const text = interaction.options.getString('testo', true);

      const record = await prisma.case.findUnique({ where: { guildId_number: { guildId, number } } });
      if (!record) {
        await interaction.reply({ content: 'Caso non trovato.', flags: MessageFlags.Ephemeral });
        return;
      }

      await prisma.case.update({
        where: { id: record.id },
        data: {
          appealText: `[registrato da ${interaction.user.tag}] ${text}`,
          appealAt: new Date(),
          status: 'APPEALED',
        },
      });

      await recordEvent(client, {
        guildId,
        type: 'MOD_APPEAL_OPENED',
        actorId: interaction.user.id,
        targetId: record.targetId,
        caseId: record.id,
        summary: `Appello registrato per conto di <@${record.targetId}> sul caso **#${record.number}**`,
      });

      await interaction.reply({
        content: `✅ Appello registrato sul caso **#${number}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    /* ── Decisione ──────────────────────────────────────────────────── */
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const number = interaction.options.getInteger('caso', true);
    const accepted = interaction.options.getBoolean('accolto', true);
    const note = interaction.options.getString('nota') ?? '';

    const record = await prisma.case.findUnique({ where: { guildId_number: { guildId, number } } });
    if (!record || !record.appealAt) {
      await interaction.editReply('Nessun appello risulta aperto per questo caso.');
      return;
    }

    await prisma.case.update({
      where: { id: record.id },
      data: {
        appealResolvedAt: new Date(),
        appealResolvedBy: interaction.user.id,
        // Accogliere un appello deve revocare il provvedimento davvero,
        // altrimenti resta una formalità senza effetti.
        status: accepted ? 'REVOKED' : 'UPHELD',
        ...(accepted ? { revokedAt: new Date(), revokedBy: interaction.user.id } : {}),
      },
    });

    if (accepted) {
      switch (record.type) {
        case 'BAN':
          await interaction
            .guild!.bans.remove(record.targetId, `Appello accolto sul caso #${number}`)
            .catch(() => undefined);
          break;
        case 'MUTE': {
          const member = await interaction.guild!.members
            .fetch(record.targetId)
            .catch(() => null);
          await member?.timeout(null, `Appello accolto sul caso #${number}`).catch(() => undefined);
          break;
        }
        case 'QUARANTINE':
          await liftQuarantine(client, interaction.guild!, record.targetId, interaction.user.id);
          break;
        default:
          break;
      }
    }

    await recordEvent(client, {
      guildId,
      type: 'MOD_APPEAL_RESOLVED',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      targetId: record.targetId,
      caseId: record.id,
      severity: 20,
      summary:
        `Appello sul caso **#${number}** ${accepted ? '**accolto**' : '**respinto**'}` +
        (note ? `\n${note}` : ''),
    });

    const member = await interaction.guild!.members.fetch(record.targetId).catch(() => null);
    await member?.send(
      accepted
        ? `Il tuo appello sul caso #${number} in **${interaction.guild!.name}** è stato accolto: ` +
            `il provvedimento è stato revocato.${note ? `\n\n${note}` : ''}`
        : `Il tuo appello sul caso #${number} in **${interaction.guild!.name}** è stato respinto.` +
            `${note ? `\n\n${note}` : ''}`,
    ).catch(() => undefined);

    await interaction.editReply(
      `✅ Appello ${accepted ? 'accolto' : 'respinto'} sul caso **#${number}**.` +
        (accepted ? ' Il provvedimento è stato revocato.' : ''),
    );
  },
};

export const appealCommands: Command[] = [appeal];

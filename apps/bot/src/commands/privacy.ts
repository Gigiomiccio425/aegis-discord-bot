import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getPrisma } from '@angel/db';
import type { Command } from './types.js';
import { t } from '../core/i18n.js';
import { recordEvent } from '../logging/auditLogger.js';

/* ═══════════════════════════════════════════════════════════════════════
   PRIVACY E GDPR

   Un bot che registra ogni azione tratta dati personali: gli ID Discord sono
   identificatori univoci, e il contenuto dei messaggi lo è a maggior ragione.
   La Developer Policy di Discord richiede una privacy policy a prescindere, e
   in Europa l'art. 17 del GDPR dà a ogni utente il diritto di ottenere la
   cancellazione.

   Il compromesso adottato: i dati di attività si cancellano su richiesta, i
   provvedimenti di moderazione restano ma pseudonimizzati. Cancellare anche
   quelli permetterebbe a chiunque di azzerare la propria fedina uscendo e
   rientrando nel server.
   ═══════════════════════════════════════════════════════════════════════ */

const privacy: Command = {
  data: new SlashCommandBuilder()
    .setName('privacy')
    .setDescription('Cosa registra questo bot e per quanto tempo')
    .setDMPermission(false),
  async execute({ interaction, config }) {
    const logging = config.logging;
    const modeLabel: Record<string, string> = {
      FULL: 'contenuto completo',
      HASHED: 'solo impronta (nessun testo conservato)',
      METADATA_ONLY: 'solo metadati (chi, dove, quando)',
      CHANNEL_ONLY: 'niente nel database',
    };

    const embed = new EmbedBuilder()
      .setTitle('Trattamento dei dati')
      .setColor(0x5865f2)
      .setDescription(
        'Questo server usa **ANGEL** per moderazione e sicurezza. ' +
          'Ecco cosa viene registrato.',
      )
      .addFields(
        {
          name: 'Contenuto dei messaggi',
          value: modeLabel[logging.messageContent] ?? logging.messageContent,
        },
        {
          name: 'Allegati',
          value: logging.archiveAttachments
            ? `Conservati ${logging.attachmentRetentionDays} giorni sul server di chi ospita il bot`
            : 'Non conservati',
        },
        {
          name: 'Conservazione',
          value: Object.entries(logging.retentionDays)
            .map(([category, days]) => `${category}: ${days === 0 ? 'illimitata' : `${days} giorni`}`)
            .join(' · '),
        },
        {
          name: 'Anche registrato',
          value:
            'Ingressi e uscite, cambi di ruolo e nickname, attività nei canali vocali, reazioni, ' +
            'azioni dei moderatori, eventi di sicurezza.',
        },
        {
          name: 'I tuoi diritti',
          value: logging.allowSelfErasure
            ? 'Puoi chiedere la cancellazione dei tuoi dati con `/cancella-i-miei-dati`.'
            : 'Per la cancellazione dei dati contatta lo staff del server.',
        },
      )
      .setFooter({
        text: 'Il bot non può leggere i messaggi privati fra utenti né ottenere indirizzi IP.',
      });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

const erase: Command = {
  data: new SlashCommandBuilder()
    .setName('cancella-i-miei-dati')
    .setDescription('Richiede la cancellazione dei tuoi dati registrati da questo bot')
    .addBooleanOption((option) =>
      option
        .setName('conferma')
        .setDescription('Conferma: la cancellazione è definitiva')
        .setRequired(true),
    )
    .setDMPermission(false),
  async execute({ client, interaction, config }) {
    const locale = config.general.locale;

    if (!config.logging.allowSelfErasure) {
      await interaction.reply({ content: t(locale, 'gdpr.disabled'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!interaction.options.getBoolean('conferma', true)) {
      await interaction.reply({
        content: 'Operazione annullata: non hai confermato.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const prisma = getPrisma();
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    const request = await prisma.erasureRequest.create({
      data: { guildId, userId, requestedBy: userId },
    });

    // I messaggi archiviati e gli eventi ordinari spariscono del tutto.
    const [messages, events, profile] = await prisma.$transaction([
      prisma.messageArchive.deleteMany({ where: { guildId, authorId: userId } }),
      prisma.auditEvent.deleteMany({
        where: { guildId, actorId: userId, category: { notIn: ['MODERATION', 'SECURITY'] } },
      }),
      prisma.userProfile.deleteMany({ where: { guildId, userId } }),
    ]);

    // I provvedimenti restano, ma senza il nome: resta la storia della
    // moderazione, non l'identità leggibile.
    const anonymised = await prisma.case.updateMany({
      where: { guildId, targetId: userId },
      data: { targetTag: null },
    });

    const summary = {
      messages: messages.count,
      events: events.count,
      profiles: profile.count,
      casesAnonymised: anonymised.count,
    };

    await prisma.erasureRequest.update({
      where: { id: request.id },
      data: { completedAt: new Date(), summary },
    });

    await recordEvent(client, {
      guildId,
      type: 'GDPR_DATA_DELETED',
      actorId: userId,
      summary: `Cancellazione dati richiesta dall'interessato · ${messages.count} messaggi, ${events.count} eventi`,
      payload: summary,
    });

    await interaction.editReply(
      `${t(locale, 'gdpr.done', { guild: interaction.guild!.name })}\n\n` +
        `Messaggi archiviati rimossi: ${messages.count}\n` +
        `Eventi rimossi: ${events.count}\n` +
        `Provvedimenti resi anonimi: ${anonymised.count}`,
    );
  },
};

export const privacyCommands: Command[] = [privacy, erase];

import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { GuildConfigSchema } from '@angel/shared';
import type { Command } from './types.js';
import { getGuildConfig, saveGuildConfig } from '../core/config.js';
import { recordEvent } from '../logging/auditLogger.js';
import { accettaDocumento, pubblicaCopiaLeggera } from '../security/copiaLeggera.js';

/* ═══════════════════════════════════════════════════════════════════════
   RIMETTERE LA COPIA LEGGERA

   Il comando **non accetta un file caricato**, ed è la decisione che tiene in
   piedi tutto il resto.

   Un allegato caricato da chi scrive il comando è un file di provenienza
   sconosciuta: chiunque può prepararne uno che spegne le difese e convincere
   un amministratore ad allegarlo. Rimettere una configurazione è come
   cambiarla, e cambiarla con un file altrui è la stessa cosa che lasciare a
   qualcun altro la chiave.

   Qui invece si legge dal canale dove il bot pubblica, e si prende solo un
   messaggio **scritto dal bot**. La provenienza non si chiede a chi comanda:
   la verifica Discord, ed è l'unica versione di questo controllo che regge.

   Il prezzo è che non si può rimettere una copia salvata altrove — su un
   disco, in una mail. È un prezzo accettabile: quella copia serve a
   ricostruire un server leggendola, e per quello basta aprirla.
   ═══════════════════════════════════════════════════════════════════════ */

/** Un file più grande di così non è una copia leggera: è qualcos'altro. */
const LIMITE_BYTE = 4 * 1024 * 1024;

const copiaLeggera: Command = {
  requiredPermissions: [PermissionFlagsBits.Administrator],
  data: new SlashCommandBuilder()
    .setName('copia-leggera')
    .setDescription('La copia che sopravvive alla macchina: pubblicala o rimettila')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName('adesso').setDescription('Pubblica subito una copia nel canale configurato'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rimetti')
        .setDescription('Rimette la configurazione dall’ultima copia pubblicata')
        .addStringOption((option) =>
          option
            .setName('messaggio')
            .setDescription('ID del messaggio da cui leggere, se non vuoi l’ultimo')
            .setRequired(false),
        ),
    ),

  async execute({ interaction }) {
    const guild = interaction.guild;
    if (!guild) return;

    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();

    if (sub === 'adesso') {
      const esito = await pubblicaCopiaLeggera(interaction.client, guild.id);
      await interaction.editReply(
        esito.stato === 'fatto' ? `✅ ${esito.messaggio}` : `⚠️ ${esito.messaggio}`,
      );
      return;
    }

    /* ── rimetti ─────────────────────────────────────────────────────── */

    const config = await getGuildConfig(guild.id);
    const canaleId = config.general.copiaLeggera.channelId;
    if (!canaleId) {
      await interaction.editReply(
        'Non c’è un canale della copia leggera: impostalo dal pannello, in Generale.',
      );
      return;
    }

    const canale = guild.channels.cache.get(canaleId);
    if (!canale || canale.type !== ChannelType.GuildText) {
      await interaction.editReply('Il canale della copia leggera non esiste più.');
      return;
    }

    const idScelto = interaction.options.getString('messaggio');

    /*
     * Si cercano solo i messaggi del bot, e solo con un allegato.
     *
     * Cinquanta indietro bastano: le copie sono una al giorno e il canale è
     * riservato. Se qualcuno ci scrive sopra abbastanza da seppellirle, l'ID
     * del messaggio è la via d'uscita.
     */
    const messaggio = idScelto
      ? await canale.messages.fetch(idScelto).catch(() => null)
      : await canale.messages
          .fetch({ limit: 50 })
          .then(
            (elenco) =>
              elenco.find(
                (m) => m.author.id === interaction.client.user?.id && m.attachments.size > 0,
              ) ?? null,
          )
          .catch(() => null);

    if (!messaggio) {
      await interaction.editReply(
        idScelto
          ? 'Non trovo quel messaggio in quel canale.'
          : 'Non trovo nessuna copia pubblicata in quel canale.',
      );
      return;
    }

    const allegato = messaggio.attachments.first();
    if (!allegato) {
      await interaction.editReply('Quel messaggio non ha allegati.');
      return;
    }
    if (allegato.size > LIMITE_BYTE) {
      await interaction.editReply('Quel file è troppo grande per essere una copia leggera.');
      return;
    }

    const testo = await fetch(allegato.url)
      .then((risposta) => (risposta.ok ? risposta.text() : null))
      .catch(() => null);

    if (testo === null) {
      await interaction.editReply('Non sono riuscito a scaricare la copia. Riprova.');
      return;
    }

    const { documento, problemi } = accettaDocumento(testo, {
      // Qui sta il controllo che conta, e lo risponde Discord, non chi comanda.
      autoreBot: messaggio.author.id === interaction.client.user?.id,
      guildId: guild.id,
    });

    if (!documento) {
      await interaction.editReply(`⚠️ Copia non accettata.\n• ${problemi.join('\n• ')}`);
      return;
    }

    if (!documento.configurazione) {
      await interaction.editReply(
        'Quella copia non contiene la configurazione — era stata pubblicata con ' +
          '«Includi la configurazione» spento. Ruoli, canali ed elenchi li trovi ' +
          'dentro il file, da rimettere a mano.',
      );
      return;
    }

    /*
     * La configurazione si rilegge con lo schema prima di salvarla.
     *
     * Il file viene da un messaggio del bot, quindi in teoria è nostro. Ma
     * «in teoria è nostro» non è una garanzia su cui appoggiare la
     * configurazione di sicurezza di un server: lo schema è l'ultima
     * occasione per accorgersi di un campo storto, e costa una chiamata.
     */
    const letta = GuildConfigSchema.safeParse(documento.configurazione);
    if (!letta.success) {
      await interaction.editReply(
        `⚠️ La configurazione dentro quella copia non è valida: ${letta.error.issues[0]?.message ?? 'forma inattesa'}. Non l’ho applicata.`,
      );
      return;
    }

    await saveGuildConfig(guild.id, letta.data, {
      id: interaction.user.id,
      source: 'command',
    });

    await recordEvent(interaction.client, {
      guildId: guild.id,
      type: 'CONFIG_CHANGED',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      severity: 40,
      summary: `Configurazione rimessa dalla copia leggera del ${documento.creatoIl.slice(0, 10)}`,
      payload: { creatoIl: documento.creatoIl, angel: documento.angel },
    });

    const avvisi = problemi.length > 0 ? `\n\n⚠️ ${problemi.join('\n⚠️ ')}` : '';
    await interaction.editReply(
      `✅ Configurazione rimessa dalla copia del **${documento.creatoIl.slice(0, 10)}** ` +
        `(ANGEL ${documento.angel}).\n` +
        'Ruoli e canali **non** sono stati ricreati: quelli stanno nella copia per ' +
        'riconoscerli e rifarli a mano.' +
        avvisi,
    );
  },
};

export const copiaLeggeraCommands: Command[] = [copiaLeggera];

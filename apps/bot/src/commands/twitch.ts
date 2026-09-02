/* ═══════════════════════════════════════════════════════════════════════
   /twitch bot — il lato Discord del bot di chat

   Non un comando proprio: un **gruppo dentro `/twitch`**, che esisteva già per
   gli annunci di diretta. Discord non consente due comandi con lo stesso nome,
   ma la ragione per unirli non è tecnica: chi cerca «le cose di Twitch» le
   deve trovare in un posto solo, e `/twitch` e `/twitch-bot` affiancati
   sarebbero una domanda in più a ogni uso.

   Qui c'è poco e mirato. Il bot Twitch si configura dal proprio pannello, e
   riprodurre trenta soglie dentro dei comandi slash avrebbe prodotto due
   interfacce per la stessa cosa — con la certezza che una delle due sarebbe
   rimasta indietro. Resta quello che riguarda *Discord*: dove finiscono gli
   avvisi, e quali canali Twitch parlano con questo server.

   ── Perché non c'è un comando che collega un canale ────────────────────

   Sarebbe comodo: `/twitch bot collega yayadoppia` e via. Sarebbe anche il
   modo perché chiunque amministri un server qualsiasi dirotti gli avvisi di
   moderazione di un canale che non è suo — nomi degli spettatori sanzionati,
   testo dei messaggi rimossi — verso un posto che controlla lui.

   Il collegamento parte quindi dall'altra parte, dal pannello Twitch, dove chi
   lo fa ha dimostrato di possedere il canale entrando con Twitch. Da qui si
   legge l'identificativo del server e lo si incolla là.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  ChannelType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandGroupBuilder,
  type TextChannel,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import { TwitchChannelConfigSchema } from '@angel/shared';
import { childLogger } from '../core/logger.js';

const log = childLogger('twitch-bot');

/** Viola di Twitch, spostato: riconoscibile senza fingere di esserlo. */
const VIOLA = 0xa970ff;

/** Il gruppo `bot` da agganciare al comando `/twitch`. */
export function gruppoBotTwitch(
  gruppo: SlashCommandSubcommandGroupBuilder,
): SlashCommandSubcommandGroupBuilder {
  return gruppo
    .setName('bot')
    .setDescription('Il bot di chat Twitch: stato, collegamento, canale del registro')
    .addSubcommand((sotto) =>
      sotto.setName('stato').setDescription('Quali canali Twitch sono collegati a questo server'),
    )
    .addSubcommand((sotto) =>
      sotto.setName('collega').setDescription('Come collegare un canale Twitch a questo server'),
    )
    .addSubcommand((sotto) =>
      sotto
        .setName('registro')
        .setDescription('Dove pubblicare gli avvisi di un canale Twitch collegato')
        .addStringOption((opzione) =>
          opzione
            .setName('canale-twitch')
            .setDescription('Il nome del canale Twitch, senza @')
            .setRequired(true),
        )
        .addChannelOption((opzione) =>
          opzione
            .setName('registro')
            .setDescription('Dove finisce tutto quello che succede')
            .addChannelTypes(ChannelType.GuildText),
        )
        .addChannelOption((opzione) =>
          opzione
            .setName('avvisi')
            .setDescription('Dove finisce solo quello che è grave (gravità 50 o più)')
            .addChannelTypes(ChannelType.GuildText),
        ),
    );
}

/**
 * Esegue un sottocomando del gruppo.
 *
 * Chi chiama ha già risposto con `deferReply`: qui si usa sempre `editReply`.
 */
export async function gestisciBotTwitch(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  switch (interaction.options.getSubcommand()) {
    case 'collega':
      return spiegaCollegamento(interaction, guildId);
    case 'stato':
      return mostraStato(interaction, guildId);
    default:
      return impostaRegistro(interaction, guildId);
  }
}

/* ── collega ──────────────────────────────────────────────────────────── */

async function spiegaCollegamento(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const indirizzo = process.env.TWITCH_PUBLIC_URL ?? '(pannello Twitch non configurato)';

  const embed = new EmbedBuilder()
    .setColor(VIOLA)
    .setTitle('Collegare un canale Twitch a questo server')
    .setDescription(
      'Il collegamento si fa dal pannello Twitch e non da qui: chi lo fa deve aver dimostrato ' +
        'di possedere il canale entrando con Twitch. Altrimenti chiunque amministri un server ' +
        'potrebbe dirottare altrove gli avvisi di moderazione di un canale che non è suo.',
    )
    .addFields(
      { name: '1. Apri il pannello', value: `${indirizzo} → scheda **Collegamenti**` },
      { name: '2. Incolla questo identificativo di server', value: `\`\`\`\n${guildId}\n\`\`\`` },
      {
        name: '3. Torna qui',
        value: 'Con `/twitch bot registro` scegli in quale canale far arrivare gli avvisi.',
      },
    );

  await interaction.editReply({ embeds: [embed] });
}

/* ── stato ────────────────────────────────────────────────────────────── */

async function mostraStato(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const canali = await getPrisma()
    .twitchChannel.findMany({
      where: { guildId, enabled: true },
      select: {
        login: true,
        displayName: true,
        connected: true,
        tokenFailedAt: true,
        config: true,
      },
    })
    .catch((errore: unknown) => {
      log.warn({ err: errore, guildId }, 'canali Twitch non letti');
      return null;
    });

  if (canali === null) {
    await interaction.editReply(
      '⚠️ Non riesco a leggere i canali Twitch: il database non risponde. Prova `/salute`.',
    );
    return;
  }

  if (canali.length === 0) {
    await interaction.editReply(
      'Nessun canale Twitch collegato a questo server. `/twitch bot collega` spiega come farlo.',
    );
    return;
  }

  const righe = canali.map((canale) => {
    // La configurazione è un JSON: se una versione futura la cambia, meglio i
    // valori predefiniti che un comando che si rompe.
    const config = TwitchChannelConfigSchema.safeParse(canale.config);
    const livello = config.success ? config.data.livello.toLowerCase() : 'sconosciuto';
    const prova = config.success && config.data.modalitaProva ? ' · **prova**' : '';
    const registro =
      config.success && config.data.registro.canaleRegistroId
        ? ` · <#${config.data.registro.canaleRegistroId}>`
        : ' · *nessun canale di registro*';

    const stato = canale.tokenFailedAt
      ? '🔴 da riautorizzare'
      : canale.connected
        ? '🟢'
        : '⚪ non collegato';

    return `${stato} **${canale.displayName ?? canale.login}** — ${livello}${prova}${registro}`;
  });

  const embed = new EmbedBuilder()
    .setColor(VIOLA)
    .setTitle(`Canali Twitch (${canali.length})`)
    .setDescription(righe.join('\n'))
    .setFooter({ text: 'Le soglie e i comandi si configurano dal pannello Twitch.' });

  await interaction.editReply({ embeds: [embed] });
}

/* ── registro ─────────────────────────────────────────────────────────── */

async function impostaRegistro(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const login = interaction.options
    .getString('canale-twitch', true)
    .trim()
    .toLowerCase()
    .replace(/^@/, '');

  const canale = await getPrisma()
    .twitchChannel.findUnique({ where: { login } })
    .catch(() => null);

  /*
   * Il controllo che rende sicuro il comando.
   *
   * Un canale collegato a un altro server risponde come se non esistesse. Non
   * è cortesia: dire «esiste ma non è tuo» permetterebbe a chiunque di
   * scoprire quali streamer usano il bot provando i nomi uno per uno.
   */
  if (!canale || canale.guildId !== guildId) {
    await interaction.editReply(
      `Non c'è nessun canale Twitch **${login}** collegato a questo server. ` +
        'Il collegamento si fa dal pannello Twitch: `/twitch bot collega` spiega come.',
    );
    return;
  }

  const registro = interaction.options.getChannel('registro') as TextChannel | null;
  const avvisi = interaction.options.getChannel('avvisi') as TextChannel | null;
  const config = TwitchChannelConfigSchema.parse(canale.config);

  if (!registro && !avvisi) {
    await interaction.editReply(
      `**${login}** — registro: ${
        config.registro.canaleRegistroId ? `<#${config.registro.canaleRegistroId}>` : 'nessuno'
      }, avvisi: ${
        config.registro.canaleAvvisiId ? `<#${config.registro.canaleAvvisiId}>` : 'nessuno'
      }. Indica un canale per cambiarli.`,
    );
    return;
  }

  if (registro) config.registro.canaleRegistroId = registro.id;
  if (avvisi) config.registro.canaleAvvisiId = avvisi.id;
  config.registro.guildId = guildId;
  config.registro.suDiscord = true;

  await getPrisma().twitchChannel.update({ where: { id: canale.id }, data: { config } });

  /*
   * Una prova di scrittura subito, non alla prima sanzione.
   *
   * Il caso tipico è un canale in cui il bot non può scrivere: senza questo
   * controllo lo si scopre giorni dopo, guardando un registro rimasto vuoto e
   * concludendo che il bot Twitch non funzioni.
   */
  const bersaglio = registro ?? avvisi!;
  const scritto = await bersaglio
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(VIOLA)
          .setAuthor({ name: `Twitch · ${login}` })
          .setDescription('Da adesso quello che succede nella chat di questo canale arriva qui.'),
      ],
    })
    .then(() => true)
    .catch(() => false);

  await interaction.editReply(
    scritto
      ? `✅ **${login}** — avvisi impostati.`
      : `⚠️ Salvato, ma non riesco a scrivere in ${bersaglio}. Controlla i permessi del bot: ` +
          'senza, il registro resterà vuoto senza dire perché.',
  );
}

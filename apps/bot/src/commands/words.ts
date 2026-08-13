/* ═══════════════════════════════════════════════════════════════════════
   ELENCO DELLE PAROLE, DA DISCORD

   Il momento in cui serve aggiungere una parola è quello in cui è appena
   comparsa in chat. Se per farlo bisogna aprire il browser, entrare nel
   pannello, trovare la sezione e cercare il campo, la parola non viene
   aggiunta: si chiude Discord e ci si dimentica.

   Da qui si aggiunge in dieci secondi, restando dove è successo.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  analizzaConfigurazione,
  GuildConfigSchema,
  leggiElenco,
  paroleMancanti,
  scriviElenco,
  unisciElenchi,
  type GuildConfig,
} from '@angel/shared';
import type { Command } from './types.js';
import { getGuildConfig, saveGuildConfig } from '../core/config.js';
import { recordEvent } from '../logging/auditLogger.js';

const CATEGORIE = [
  { name: 'Volgarità', value: 'VOLGARITA' },
  { name: 'Insulto', value: 'INSULTO' },
  { name: 'Discriminazione', value: 'DISCRIMINAZIONE' },
  { name: 'Minaccia', value: 'MINACCIA' },
  { name: 'Autolesionismo', value: 'AUTOLESIONISMO' },
  { name: 'Bestemmia', value: 'BESTEMMIA' },
  { name: 'Sessuale', value: 'SESSUALE' },
] as const;

const GRAVITA = [
  { name: 'lieve', value: 'LIEVE' },
  { name: 'media', value: 'MEDIA' },
  { name: 'grave', value: 'GRAVE' },
] as const;

const parole: Command = {
  data: new SlashCommandBuilder()
    .setName('parole')
    .setDescription('Elenco delle parole non ammesse: aggiungi, togli, cerca')
    .addSubcommand((sub) =>
      sub
        .setName('aggiungi')
        .setDescription('Aggiunge una parola o una frase all\'elenco')
        .addStringOption((option) =>
          option
            .setName('parola')
            .setDescription('Anche più parole insieme, separate da virgola')
            .setRequired(true)
            .setMaxLength(500),
        )
        .addStringOption((option) =>
          option
            .setName('categoria')
            .setDescription('Dove classificarla. Predefinita: insulto')
            .addChoices(...CATEGORIE),
        )
        .addStringOption((option) =>
          option
            .setName('gravita')
            .setDescription('Quanto pesa. Predefinita: media')
            .addChoices(...GRAVITA),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('togli')
        .setDescription('Toglie una parola dall\'elenco')
        .addStringOption((option) =>
          option.setName('parola').setDescription('Quale togliere').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('consenti')
        .setDescription('Parola legittima che il filtro non deve mai bloccare')
        .addStringOption((option) =>
          option
            .setName('parola')
            .setDescription('Es. «cazzuola», «Cagliari»')
            .setRequired(true)
            .setMaxLength(60),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('cerca')
        .setDescription('Cerca fra le parole dell\'elenco')
        .addStringOption((option) =>
          option.setName('testo').setDescription('Anche solo un pezzo').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('elenco').setDescription('Quante parole ci sono, categoria per categoria'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('importa')
        .setDescription('Importa un file di parole nel formato di ANGEL')
        .addAttachmentOption((option) =>
          option
            .setName('file')
            .setDescription('File di testo: una parola per riga, o parola | categoria | gravità')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('aggiorna')
        .setDescription('Aggiunge le parole predefinite del bot che mancano al tuo elenco'),
    )
    .addSubcommand((sub) =>
      sub.setName('esporta').setDescription('Scarica il tuo elenco come file, per portarlo altrove'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageMessages],
  async execute({ client, interaction }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand();

    // Si rilegge dal database e non dalla copia passata al comando: quella ha
    // già l'interruttore generale applicato, e risalvarla scriverebbe «tutto
    // spento» in modo permanente.
    const config = GuildConfigSchema.parse(structuredClone(await getGuildConfig(guildId)));
    const settings = config.security.language;

    if (sub === 'elenco') {
      const conteggio = new Map<string, number>();
      for (const voce of settings.terms) {
        conteggio.set(voce.category, (conteggio.get(voce.category) ?? 0) + 1);
      }

      const embed = new EmbedBuilder()
        .setTitle('Parole non ammesse')
        .setColor(0x6f8a95)
        .setDescription(
          CATEGORIE.map((categoria) => {
            const attiva = settings.categories[categoria.value];
            return `${attiva ? '🟢' : '⚪'} **${categoria.name}**: ${conteggio.get(categoria.value) ?? 0}${
              attiva ? '' : ' _(categoria spenta)_'
            }`;
          }).join('\n'),
        )
        .setFooter({
          text: `${settings.terms.length} voci in tutto · ${settings.allowlist.length} eccezioni`,
        });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'esporta') {
      const file = scriviElenco(
        settings.terms,
        `Elenco di ${interaction.guild?.name ?? 'questo server'}\n` +
          `${settings.terms.length} voci, esportate il ${new Date().toLocaleDateString('it-IT')}.\n` +
          'Formato: elenchi/LEGGIMI.md nel repository di ANGEL.',
      );

      await interaction.editReply({
        content: `📄 ${settings.terms.length} voci. Si reimporta con \`/parole importa\`.`,
        files: [
          new AttachmentBuilder(Buffer.from(file, 'utf8'), {
            name: `parole-${interaction.guildId}.elenco`,
          }),
        ],
      });
      return;
    }

    if (sub === 'aggiorna') {
      // Il caso concreto: server configurato mesi fa, elenco fermo a com'era
      // allora. I valori predefiniti valgono solo per le configurazioni nuove,
      // quindi le voci aggiunte al bot nel frattempo non arrivano mai.
      const mancanti = paroleMancanti(settings.terms);

      if (mancanti.length === 0) {
        await interaction.editReply(
          `✅ Il tuo elenco ha già tutte le ${settings.terms.length} voci predefinite del bot.`,
        );
        return;
      }

      const esito = unisciElenchi(settings.terms, mancanti);
      settings.terms = esito.voci;
      await salva(config, guildId, interaction.user.id, ['security.language.terms']);

      await interaction.editReply(
        `✅ **${esito.aggiunte}** parole aggiunte, portando l'elenco a **${settings.terms.length}** voci.\n` +
          'Le tue restano come le avevi: non è stata cambiata nessuna gravità né categoria.',
      );

      await recordEvent(client, {
        guildId,
        type: 'CONFIG_CHANGED',
        actorId: interaction.user.id,
        summary: `Elenco parole allineato ai predefiniti: ${esito.aggiunte} aggiunte`,
        payload: { aggiunte: esito.aggiunte, totale: settings.terms.length },
      });
      return;
    }

    if (sub === 'importa') {
      const allegato = interaction.options.getAttachment('file', true);

      if (allegato.size > 512_000) {
        await interaction.editReply('Il file è troppo grande: il limite è 500 KB.');
        return;
      }

      const testo = await fetch(allegato.url)
        .then((risposta) => (risposta.ok ? risposta.text() : null))
        .catch(() => null);

      if (testo === null) {
        await interaction.editReply('Non sono riuscito a scaricare il file. Riprova.');
        return;
      }

      const letto = leggiElenco(testo);
      if (letto.voci.length === 0) {
        await interaction.editReply(
          'Nessuna parola valida nel file.' +
            (letto.errori.length > 0
              ? `\nPrimo problema, riga ${letto.errori[0]!.riga}: ${letto.errori[0]!.motivo}.`
              : '\nIl formato è spiegato in `elenchi/LEGGIMI.md`.'),
        );
        return;
      }

      const esito = unisciElenchi(settings.terms, letto.voci);
      settings.terms = esito.voci;
      await salva(config, guildId, interaction.user.id, ['security.language.terms']);

      const righeErrore = letto.errori
        .slice(0, 5)
        .map((errore) => `• riga ${errore.riga}: ${errore.motivo}`)
        .join('\n');

      await interaction.editReply(
        `✅ **${esito.aggiunte}** aggiunte` +
          (esito.gia > 0 ? `, ${esito.gia} già presenti` : '') +
          `. L'elenco ora ha **${settings.terms.length}** voci.` +
          (letto.errori.length > 0
            ? `\n\n⚠️ ${letto.errori.length} righe saltate:\n${righeErrore}` +
              (letto.errori.length > 5 ? `\n…e altre ${letto.errori.length - 5}` : '')
            : ''),
      );

      await recordEvent(client, {
        guildId,
        type: 'CONFIG_CHANGED',
        actorId: interaction.user.id,
        summary: `Elenco parole importato da file: ${esito.aggiunte} aggiunte`,
        payload: { aggiunte: esito.aggiunte, saltate: letto.errori.length, file: allegato.name },
      });
      return;
    }

    if (sub === 'cerca') {
      const query = interaction.options.getString('testo', true).trim().toLowerCase();
      const trovate = settings.terms.filter((voce) => voce.term.includes(query)).slice(0, 40);

      if (trovate.length === 0) {
        await interaction.editReply(`Nessuna voce contiene «${query}».`);
        return;
      }

      await interaction.editReply(
        `**${trovate.length}** voci con «${query}»:\n` +
          trovate
            .map((voce) => `\`${voce.term}\` — ${voce.category.toLowerCase()} · ${voce.severity.toLowerCase()}`)
            .join('\n')
            .slice(0, 1900),
      );
      return;
    }

    if (sub === 'consenti') {
      const parola = interaction.options.getString('parola', true).trim().toLowerCase();
      if (settings.allowlist.includes(parola)) {
        await interaction.editReply(`«${parola}» è già fra le eccezioni.`);
        return;
      }

      settings.allowlist = [...settings.allowlist, parola];
      await salva(config, guildId, interaction.user.id, ['security.language.allowlist']);
      await interaction.editReply(
        `✅ «${parola}» non verrà più bloccata, nemmeno se contiene una voce dell'elenco.`,
      );
      return;
    }

    if (sub === 'togli') {
      const parola = interaction.options.getString('parola', true).trim().toLowerCase();
      const prima = settings.terms.length;
      settings.terms = settings.terms.filter((voce) => voce.term !== parola);

      if (settings.terms.length === prima) {
        await interaction.editReply(
          `«${parola}» non è nell'elenco. Cercala con \`/parole cerca\`: le frasi vanno tolte per intero.`,
        );
        return;
      }

      await salva(config, guildId, interaction.user.id, ['security.language.terms']);
      await interaction.editReply(`✅ «${parola}» tolta dall'elenco.`);
      return;
    }

    /* aggiungi */
    const categoria = (interaction.options.getString('categoria') ??
      'INSULTO') as (typeof CATEGORIE)[number]['value'];
    const gravita = (interaction.options.getString('gravita') ??
      'MEDIA') as (typeof GRAVITA)[number]['value'];

    // Più parole in una volta: chi sta ripulendo dopo un raid ne ha venti da
    // mettere, non una.
    const richieste = interaction.options
      .getString('parola', true)
      .split(',')
      .map((voce) => voce.trim().toLowerCase())
      .filter((voce) => voce.length >= 2);

    const esistenti = new Set(settings.terms.map((voce) => voce.term));
    const nuove = richieste.filter((voce, indice) => richieste.indexOf(voce) === indice && !esistenti.has(voce));

    if (nuove.length === 0) {
      await interaction.editReply('Erano già tutte nell\'elenco.');
      return;
    }

    settings.terms = [
      ...nuove.map((term) => ({ term, severity: gravita, category: categoria, substring: false })),
      ...settings.terms,
    ];

    await salva(config, guildId, interaction.user.id, ['security.language.terms']);

    await interaction.editReply(
      `✅ ${nuove.length === 1 ? 'Aggiunta' : `${nuove.length} aggiunte`}: ` +
        nuove.map((voce) => `\`${voce}\``).join(', ') +
        `\nCategoria **${categoria.toLowerCase()}**, gravità **${gravita.toLowerCase()}**.` +
        (settings.categories[categoria]
          ? ''
          : `\n⚠️ La categoria **${categoria.toLowerCase()}** è spenta: finché resta così, queste parole non vengono cercate.`),
    );

    await recordEvent(client, {
      guildId,
      type: 'CONFIG_CHANGED',
      actorId: interaction.user.id,
      summary: `${nuove.length} parole aggiunte all'elenco (${categoria.toLowerCase()})`,
      payload: { termini: nuove, categoria, gravita },
    });
  },
};

async function salva(
  config: GuildConfig,
  guildId: string,
  actorId: string,
  percorsi: string[],
): Promise<void> {
  await saveGuildConfig(guildId, config, { id: actorId, source: 'command', paths: percorsi });
}

/* ═══════════════════════════════════════════════════════════════════════
   DIAGNOSI

   Risponde alla domanda che si pone quando qualcosa non funziona e non si
   capisce perché: «il modulo è acceso, e allora?». Le cause sono quasi sempre
   fra i moduli e non dentro uno — un campo che manca, una dipendenza spenta,
   due impostazioni che si annullano — e nessuna di queste si vede guardando
   la sezione del modulo che sembra rotto.
   ═══════════════════════════════════════════════════════════════════════ */
const diagnosi: Command = {
  data: new SlashCommandBuilder()
    .setName('diagnosi')
    .setDescription('Controlla che i moduli accesi possano davvero funzionare')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.ManageGuild],
  async execute({ interaction, config }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const problemi = analizzaConfigurazione(config);

    if (problemi.length === 0) {
      await interaction.editReply('✅ Tutto coerente: ogni modulo acceso ha ciò che gli serve.');
      return;
    }

    const icona = { errore: '🔴', avviso: '🟠', nota: '⚪' } as const;
    const errori = problemi.filter((problema) => problema.livello === 'errore').length;

    const embed = new EmbedBuilder()
      .setTitle('Diagnosi della configurazione')
      .setColor(errori > 0 ? 0xe05263 : 0xd8b45f)
      .setDescription(
        problemi
          .slice(0, 15)
          .map(
            (problema) =>
              `${icona[problema.livello]} **${problema.titolo}** — \`${problema.modulo}\`\n` +
              problema.dettaglio.replace(/\*\*/g, ''),
          )
          .join('\n\n')
          .slice(0, 4000),
      )
      .setFooter({
        text:
          errori > 0
            ? `${errori} da sistemare · le altre voci sono avvisi e note`
            : 'Nessun blocco: solo cose che vale la pena sapere',
      });

    await interaction.editReply({ embeds: [embed] });
  },
};

export const wordCommands: Command[] = [parole, diagnosi];

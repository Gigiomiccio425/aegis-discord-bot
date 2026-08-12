/* ═══════════════════════════════════════════════════════════════════════
   ELENCO DELLE PAROLE, DA DISCORD

   Il momento in cui serve aggiungere una parola è quello in cui è appena
   comparsa in chat. Se per farlo bisogna aprire il browser, entrare nel
   pannello, trovare la sezione e cercare il campo, la parola non viene
   aggiunta: si chiude Discord e ci si dimentica.

   Da qui si aggiunge in dieci secondi, restando dove è successo.
   ═══════════════════════════════════════════════════════════════════════ */

import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { GuildConfigSchema, type GuildConfig } from '@angel/shared';
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

export const wordCommands: Command[] = [parole];

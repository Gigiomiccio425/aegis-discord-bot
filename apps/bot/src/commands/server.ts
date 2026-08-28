/* ═══════════════════════════════════════════════════════════════════════
   COSTRUZIONE DEL SERVER

   Un comando solo che porta un server vuoto a essere una community pronta:
   ruoli, categorie, canali, modalità community, verifica, ticket, e la
   configurazione già compilata per ogni funzione del bot — comprese quelle
   spente, perché un canale che esiste si accende con una spunta mentre un
   canale che manca richiede di ricordarsi che serviva.

   Una cosa che il bot **non** può fare, e va detta invece di lasciarla
   scoprire: creare il server. L'API permetterebbe a un bot presente in meno di
   dieci server di crearne uno, ma il proprietario risulterebbe il bot, e la
   proprietà non è trasferibile a una persona. Un server di cui non sei
   padrone non è tuo: quello si crea a mano in dieci secondi, e da lì in poi
   fa tutto questo comando.
   ═══════════════════════════════════════════════════════════════════════ */

import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { getGuildConfig } from '../core/config.js';
import { provisionGuild } from '../security/provision.js';
import { costruisciModello } from '../security/modello.js';
import { recordEvent } from '../logging/auditLogger.js';

const creaServer: Command = {
  data: new SlashCommandBuilder()
    .setName('crea-server')
    .setDescription('Costruisce il server: ruoli, canali, community, verifica, ticket')
    .addBooleanOption((option) =>
      option
        .setName('solo-modello')
        .setDescription('Salta la predisposizione tecnica e crea solo la parte visibile'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.Administrator],
  async execute({ client, interaction }) {
    // La costruzione crea decine di canali: Discord chiuderebbe l'interazione
    // molto prima della fine.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild!;
    const soloModello = interaction.options.getBoolean('solo-modello') ?? false;

    const config = await getGuildConfig(guild.id);
    const righe: string[] = [];

    if (!soloModello) {
      const base = await provisionGuild(client, guild, config);
      righe.push(
        `**Predisposizione** — ${base.ruoliCreati.length} ruoli, ${base.canaliCreati.length} canali, ` +
          `${base.campiCompilati} campi compilati` +
          (base.canaliIsolati > 0 ? `, ${base.canaliIsolati} canali chiusi a chi non ha verificato` : ''),
      );
      if (base.errori.length > 0) righe.push(`⚠️ ${base.errori.join(', ')}`);
    }

    // La configurazione si rilegge: la predisposizione ha appena scritto ruoli
    // e canali, e il modello ha bisogno di quelli — in particolare dei ruoli
    // staff, che decidono chi vede la categoria riservata.
    const aggiornata = await getGuildConfig(guild.id);
    const esito = await costruisciModello(client, guild, aggiornata, interaction.user.id);

    righe.push(
      `**Modello** — ${esito.categorieCreate.length} categorie, ${esito.canaliCreati.length} canali, ` +
        `${esito.ruoliCreati.length} ruoli`,
    );

    const community = {
      attivata: '✅ Modalità community **attivata**: regolamento, annunci e forum ora disponibili.',
      'già attiva': '✅ Modalità community già attiva.',
      'non riuscita':
        '⚠️ Modalità community non attivata. Serve che il bot abbia **Amministratore**; ' +
        'in alternativa si accende a mano da Impostazioni server → Abilita Community.',
      saltata: '',
    }[esito.community];

    if (community) righe.push(community);
    if (esito.errori.length > 0) righe.push(`⚠️ Non riuscito: ${esito.errori.join(', ')}`);

    const embed = new EmbedBuilder()
      .setTitle('☁️ Server costruito')
      .setColor(0xffd1dc)
      .setDescription(righe.join('\n\n'))
      .setFooter({
        text: 'Si può rieseguire quando si vuole: cerca per nome e non duplica nulla.',
      });

    await interaction.editReply({ embeds: [embed] });

    await recordEvent(client, {
      guildId: guild.id,
      type: 'PANEL_ACTION',
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      severity: 20,
      summary:
        `🏗️ Server costruito da <@${interaction.user.id}>: ` +
        `${esito.categorieCreate.length} categorie, ${esito.canaliCreati.length} canali, ` +
        `${esito.ruoliCreati.length} ruoli, community ${esito.community}`,
      payload: { ...esito },
    });
  },
};

export const serverCommands: Command[] = [creaServer];

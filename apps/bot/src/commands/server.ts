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
import { riparaRuoli } from '../security/riparaRuoli.js';
import { STILI, type StileRuoli } from '../security/ruoli.js';
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
      `**Modello** — ${esito.categorieCreate.length} categorie, ${esito.canaliCreati.length} canali` +
        (esito.ruoliCreati.length > 0 ? `, ${esito.ruoliCreati.length} ruoli creati` : ''),
    );

    /*
     * I ruoli rinominati si dicono, uno per uno.
     *
     * È la parte che sorprende: chi lancia il comando si aspetta ruoli nuovi
     * e ne trova gli stessi con un nome diverso. Elencare i cambi rende
     * evidente che `ANGEL · Staff` **è** `☾ Ali Guardiane` — stesso ruolo,
     * stesse persone dentro — invece di lasciar credere che il vecchio sia
     * sparito.
     */
    if (esito.ruoliRinominati.length > 0) {
      righe.push(
        '**Ruoli rivestiti** — stessi ruoli, nome nuovo: nessuno ha perso niente.\n' +
          esito.ruoliRinominati
            .map((cambio) => `\u00a0\u00a0${cambio.da} → **${cambio.a}**`)
            .join('\n'),
      );
    }

    if (esito.ruoliConPermessi.length > 0) {
      righe.push(
        '**Permessi assegnati** — ' +
          esito.ruoliConPermessi.map((voce) => `${voce.ruolo} (+${voce.quanti})`).join(', ') +
          '.\nAmministratore, Gestire i ruoli e Gestire i canali restano da dare a mano: ' +
          'sono le tre chiavi con cui si prende il controllo di un server.',
      );
    }

    if (esito.ruoliSaltati.length > 0) {
      righe.push(
        '⚠️ Non ho potuto toccare: ' +
          esito.ruoliSaltati.map((voce) => `${voce.ruolo} (${voce.motivo})`).join(', '),
      );
    }

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


/* ═══════════════════════════════════════════════════════════════════════
   /ripara-ruoli

   Per i server costruiti prima che i due elenchi di ruoli diventassero uno:
   là fuori esistono installazioni con `ANGEL · Staff` **e**
   `☾ Ali Guardiane`, che significano la stessa cosa e non fanno la stessa
   cosa.

   Guarda e basta, finché non gli si dice `applica: true`. Cancellare un
   ruolo porta via ogni permesso che qualcuno gli aveva dato sui canali, uno
   per uno, senza avviso: quell'anteprima è l'unica occasione di accorgersi
   che uno dei doppioni non era un doppione.
   ═══════════════════════════════════════════════════════════════════════ */

const riparaRuoliComando: Command = {
  data: new SlashCommandBuilder()
    .setName('ripara-ruoli')
    .setDescription('Unisce i ruoli doppi del bot e rimette a posto la configurazione')
    .addBooleanOption((option) =>
      option
        .setName('applica')
        .setDescription('Senza, mostra solo cosa farebbe. Con, lo fa davvero.'),
    )
    .addStringOption((option) =>
      option
        .setName('stile')
        .setDescription('Come devono chiamarsi i ruoli alla fine')
        .addChoices(...STILI.map((voce) => ({ name: voce.nome, value: voce.chiave }))),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  requiredPermissions: [PermissionFlagsBits.Administrator],

  async execute({ client, interaction }) {
    // Il conteggio dei membri richiede di scaricarli tutti: su un server
    // grande Discord chiuderebbe l'interazione molto prima della fine.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild!;
    const applica = interaction.options.getBoolean('applica') ?? false;
    const stile = (interaction.options.getString('stile') ?? undefined) as StileRuoli | undefined;

    const config = await getGuildConfig(guild.id);
    const esito = await riparaRuoli(guild, config, {
      applica,
      ...(stile ? { stile } : {}),
      attore: interaction.user.id,
    });

    const righe: string[] = [];

    if (esito.doppioni.length === 0 && esito.mancanti.length === 0) {
      righe.push('Nessun ruolo doppio: è già tutto a posto.');
    }

    for (const doppione of esito.doppioni) {
      const persi = doppione.toglie
        .map(
          (voce) =>
            `\u00a0\u00a0~~${voce.nome}~~ (${voce.membri} persone)` +
            (voce.motivo ? ` — ${voce.motivo}` : ''),
        )
        .join('\n');

      righe.push(
        `**${doppione.chiave}** → tiene **${doppione.tiene.nome}** (${doppione.tiene.membri} persone)\n${persi}`,
      );
    }

    if (esito.mancanti.length > 0) {
      righe.push(
        `**Mancano** — ${esito.mancanti.join(', ')}` +
          (applica ? ' (creati adesso)' : ' (verrebbero creati)'),
      );
    }

    if (applica) {
      const fatto: string[] = [];
      if (esito.membriSpostati > 0) fatto.push(`${esito.membriSpostati} persone spostate`);
      if (esito.ruoliEliminati.length > 0) {
        fatto.push(`${esito.ruoliEliminati.length} ruoli doppi eliminati`);
      }
      if (esito.rinominati.length > 0) fatto.push(`${esito.rinominati.length} ruoli rinominati`);
      if (esito.permessiDati.length > 0) {
        fatto.push(`permessi dati a ${esito.permessiDati.length} ruoli`);
      }
      if (esito.campiCorretti.length > 0) {
        fatto.push(`${esito.campiCorretti.length} campi di configurazione corretti`);
      }
      if (fatto.length > 0) righe.push(`**Fatto** — ${fatto.join(', ')}.`);
    } else if (esito.doppioni.length > 0 || esito.mancanti.length > 0) {
      righe.push(
        'Niente è stato toccato. Per farlo davvero: `/ripara-ruoli applica:true`.\n' +
          'I ruoli doppi vengono svuotati e cancellati, e chi li aveva riceve prima quello ' +
          'che resta — mai il contrario, così nessuno resta senza nemmeno uno dei due.',
      );
    }

    if (esito.avvisi.length > 0) righe.push(`⚠️ ${esito.avvisi.slice(0, 8).join('\n⚠️ ')}`);

    const embed = new EmbedBuilder()
      .setTitle(applica ? '🔧 Ruoli riparati' : '🔍 Cosa farei ai ruoli')
      .setColor(applica ? 0x5fbf8b : 0xd8b45f)
      .setDescription(righe.join('\n\n').slice(0, 4000));

    await interaction.editReply({ embeds: [embed] });

    if (applica) {
      await recordEvent(client, {
        guildId: guild.id,
        type: 'PANEL_ACTION',
        actorId: interaction.user.id,
        actorTag: interaction.user.tag,
        severity: 30,
        summary:
          `🔧 Ruoli unificati da <@${interaction.user.id}>: ` +
          `${esito.ruoliEliminati.length} doppioni eliminati, ` +
          `${esito.membriSpostati} persone spostate`,
        payload: { ...esito },
      });
    }
  },
};

export const serverCommands: Command[] = [creaServer, riparaRuoliComando];

/* ═══════════════════════════════════════════════════════════════════════
   PREDISPOSIZIONE DEL SERVER

   Alla prima entrata il bot crea tutto ciò che serve alle sue funzioni —
   ruoli e canali — e ne scrive gli identificatori nella propria
   configurazione.

   La ragione è che senza questo passaggio un bot di sicurezza appena
   installato non protegge nulla, e non per un difetto: la quarantena ha
   bisogno di un ruolo che isoli, il registro di un canale dove scrivere, le
   segnalazioni di un posto riservato. Sono una dozzina di campi da riempire a
   mano, ciascuno preceduto dal creare l'oggetto corrispondente e dal copiarne
   l'ID. Il risultato prevedibile è che quasi nessuno arriva in fondo, e il bot
   resta acceso ma cieco.

   Si crea anche ciò che serve a moduli spenti — il ruolo per chi è in diretta,
   quello di chi partecipa a un evento — perché il costo è un ruolo inutilizzato
   e il guadagno è che accendere un'integrazione mesi dopo non richiede di
   ricominciare da capo con la preparazione.

   Tutto è idempotente e per nome: eseguirla dieci volte non produce dieci
   copie, e ciò che è stato eliminato di proposito viene ricreato solo se lo si
   chiede esplicitamente.
   ═══════════════════════════════════════════════════════════════════════ */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type CategoryChannel,
  type Client,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { GuildConfigSchema, type GuildConfig } from '@angel/shared';
import { childLogger } from '../core/logger.js';
import { saveGuildConfig } from '../core/config.js';
import { recordEvent } from '../logging/auditLogger.js';
import { publishTicketPanel } from '../integrations/tickets.js';

const log = childLogger('predisposizione');

/** Ruoli creati, con il percorso di configurazione che li riceve. */
interface RoleSpec {
  chiave: string;
  nome: string;
  colore: `#${string}`;
  /** Mostra chi lo ha in una sezione separata della lista membri. */
  hoist?: boolean;
  descrizione: string;
  /** Dove finisce l'ID. Un ruolo può servire a più campi. */
  percorsi: string[];
  /** Il ruolo isola: nasce senza alcun permesso e viene negato ovunque. */
  isolante?: boolean;
}

const RUOLI: RoleSpec[] = [
  {
    chiave: 'quarantena',
    nome: 'ANGEL · Quarantena',
    colore: '#8a8578',
    descrizione: 'Isola chi è sospettato: può leggere, non può scrivere da nessuna parte.',
    percorsi: ['general.quarantineRoleId', 'security.verification.quarantineRoleId'],
    isolante: true,
  },
  {
    chiave: 'verificato',
    nome: 'ANGEL · Verificato',
    colore: '#5fbf8b',
    descrizione: 'Assegnato a chi supera il controllo d\'ingresso.',
    percorsi: ['security.verification.verifiedRoleId'],
  },
  {
    chiave: 'allerta',
    nome: 'ANGEL · Allerta',
    colore: '#e05263',
    hoist: true,
    descrizione: 'Menzionato quando succede qualcosa di grave. Dàllo a chi vuoi svegliare.',
    percorsi: ['general.alertRoleId'],
  },
  {
    chiave: 'staff',
    nome: 'ANGEL · Staff',
    colore: '#d8b45f',
    hoist: true,
    descrizione:
      'Chi lo ha è esente dai moduli, può gestire sondaggi, eventi, giveaway e ticket.',
    percorsi: [
      'general.staffRoleIds',
      'security.accountGuard.staffRoleIds',
      'integrations.polls.creatorRoleIds',
      'integrations.events.managerRoleIds',
      'integrations.giveaways.hostRoleIds',
      'integrations.tickets.supportRoleIds',
    ],
  },
  {
    chiave: 'diretta',
    nome: 'ANGEL · In diretta',
    colore: '#9146ff',
    descrizione: 'Assegnato agli streamer mentre trasmettono. Serve al modulo Twitch.',
    percorsi: [],
  },
  {
    chiave: 'evento',
    nome: 'ANGEL · Partecipa',
    colore: '#6f8a95',
    descrizione: 'Assegnato a chi conferma la presenza a un evento programmato.',
    percorsi: ['integrations.events.rsvpRoleId'],
  },
];

/** Canali creati dentro una categoria riservata allo staff. */
interface ChannelSpec {
  chiave: string;
  nome: string;
  topic: string;
  percorsi: string[];
}

const CANALI: ChannelSpec[] = [
  {
    chiave: 'registro',
    nome: 'angel-registro',
    topic: 'Ogni azione tracciata sul server. Scritto da ANGEL.',
    percorsi: ['logging.defaultChannelId'],
  },
  {
    chiave: 'allerta',
    nome: 'angel-allerta',
    topic: 'Raid, nuke, quarantene e utenti attenzionati. Solo ciò che non può aspettare.',
    percorsi: ['general.alertChannelId'],
  },
  {
    chiave: 'segnalazioni',
    nome: 'angel-segnalazioni',
    topic: 'Segnalazioni degli utenti, con le prove congelate prima dell\'eliminazione.',
    percorsi: ['security.safety.reportChannelId'],
  },
];

export interface ProvisionResult {
  ruoliCreati: string[];
  canaliCreati: string[];
  campiCompilati: number;
  /** Canali su cui è stata negata la vista a chi non ha verificato. */
  canaliIsolati: number;
  errori: string[];
}

/**
 * Crea il mancante e compila la configurazione.
 *
 * `soloMancanti` a false ricrea anche ciò che era stato eliminato; a true —
 * il default — rispetta le eliminazioni deliberate e si limita a riempire i
 * campi vuoti.
 */
export async function provisionGuild(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  options: { ricreaEliminati?: boolean } = {},
): Promise<ProvisionResult> {
  const risultato: ProvisionResult = {
    ruoliCreati: [],
    canaliCreati: [],
    campiCompilati: 0,
    canaliIsolati: 0,
    errori: [],
  };

  const me = await guild.members.fetchMe().catch(() => null);
  if (!me) {
    risultato.errori.push('impossibile leggere i propri permessi nel server');
    return risultato;
  }

  const bozza = GuildConfigSchema.parse(structuredClone(config));
  const modificati: string[] = [];

  /* ── Ruoli ─────────────────────────────────────────────────── */
  if (me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    for (const spec of RUOLI) {
      const esistente = guild.roles.cache.find((role) => role.name === spec.nome);
      let id = esistente?.id ?? null;

      // Un campo già compilato con un ruolo vivo non si tocca: chi ha scelto
      // un proprio ruolo di quarantena non deve ritrovarselo sostituito.
      const giaConfigurato = spec.percorsi.some((percorso) => {
        const valore = leggi(bozza, percorso);
        const riferito = Array.isArray(valore) ? valore[0] : valore;
        return typeof riferito === 'string' && guild.roles.cache.has(riferito);
      });

      if (!id && (!giaConfigurato || options.ricreaEliminati)) {
        const creato = await guild.roles
          .create({
            name: spec.nome,
            color: spec.colore,
            hoist: spec.hoist ?? false,
            mentionable: false,
            // Nessun permesso: questi ruoli servono a marcare e a isolare, non
            // a concedere. I permessi si aggiungono a mano, sapendo cosa si fa.
            permissions: [],
            reason: 'Predisposizione automatica di ANGEL',
          })
          .catch((error: unknown) => {
            log.warn({ err: error, ruolo: spec.nome }, 'creazione ruolo fallita');
            risultato.errori.push(`ruolo ${spec.nome}`);
            return null;
          });

        if (creato) {
          id = creato.id;
          risultato.ruoliCreati.push(spec.nome);
          if (spec.isolante) await isolaRuolo(guild, creato.id);
        }
      }

      if (!id) continue;
      for (const percorso of spec.percorsi) {
        if (scrivi(bozza, percorso, id)) {
          modificati.push(percorso);
          risultato.campiCompilati += 1;
        }
      }
    }
  } else {
    risultato.errori.push('permesso «Gestire i ruoli» mancante: nessun ruolo creato');
  }

  /* ── Canali ────────────────────────────────────────────────── */
  if (me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    const categoria = await assicuraCategoria(guild, bozza);
    if (categoria) {
      for (const spec of CANALI) {
        const esistente = guild.channels.cache.find(
          (channel) => channel.name === spec.nome && channel.parentId === categoria.id,
        );
        let id = esistente?.id ?? null;

        const giaConfigurato = spec.percorsi.some((percorso) => {
          const valore = leggi(bozza, percorso);
          return typeof valore === 'string' && guild.channels.cache.has(valore);
        });

        if (!id && (!giaConfigurato || options.ricreaEliminati)) {
          const creato = await guild.channels
            .create({
              name: spec.nome,
              type: ChannelType.GuildText,
              parent: categoria.id,
              topic: spec.topic,
              reason: 'Predisposizione automatica di ANGEL',
            })
            .catch((error: unknown) => {
              log.warn({ err: error, canale: spec.nome }, 'creazione canale fallita');
              risultato.errori.push(`canale ${spec.nome}`);
              return null;
            });

          if (creato) {
            id = creato.id;
            risultato.canaliCreati.push(spec.nome);
          }
        }

        if (!id) continue;
        for (const percorso of spec.percorsi) {
          if (scrivi(bozza, percorso, id)) {
            modificati.push(percorso);
            risultato.campiCompilati += 1;
          }
        }
      }
    }
  } else {
    risultato.errori.push('permesso «Gestire i canali» mancante: nessun canale creato');
  }

  /* ── Assistenza, ticket e verifica ─────────────────────────── */
  if (me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await creaAssistenza(client, guild, bozza, modificati, risultato).catch((errore: unknown) => {
      log.warn({ err: errore, guildId: guild.id }, 'assistenza non predisposta');
      risultato.errori.push('assistenza');
    });

    await creaVerifica(client, guild, bozza, modificati, risultato).catch((errore: unknown) => {
      log.warn({ err: errore, guildId: guild.id }, 'verifica non predisposta');
      risultato.errori.push('verifica');
    });
  }

  /* ── Salvataggio ───────────────────────────────────────────── */
  if (modificati.length > 0) {
    await saveGuildConfig(guild.id, bozza, {
      id: client.user?.id ?? 'system',
      source: 'system',
      paths: modificati,
    });
  }

  await recordEvent(client, {
    guildId: guild.id,
    type: 'CONFIG_CHANGED',
    actorId: client.user?.id,
    severity: 30,
    summary:
      '🪶 **Predisposizione automatica**\n' +
      `Ruoli creati: ${risultato.ruoliCreati.length ? risultato.ruoliCreati.join(', ') : 'nessuno'}\n` +
      `Canali creati: ${risultato.canaliCreati.length ? risultato.canaliCreati.join(', ') : 'nessuno'}\n` +
      `Campi compilati: ${risultato.campiCompilati}\n` +
      `Canali isolati a chi non ha verificato: ${risultato.canaliIsolati}` +
      (risultato.errori.length ? `\n⚠️ Non riuscito: ${risultato.errori.join(', ')}` : ''),
    payload: { ...risultato },
  });

  return risultato;
}

/* ═══════════════════════════════════════════════════════════════════════
   ASSISTENZA

   Una categoria visibile a tutti con tre cose: una sala d'attesa vocale dove
   chiunque può entrare, due stanze vocali dove solo lo staff può portare
   qualcuno, e il canale con il pulsante per aprire un ticket.

   Il flusso è quello che si usa nei server veri: chi ha bisogno entra in
   attesa, lo staff lo sposta in una stanza riservata. Le stanze negano
   `Connect` a `@everyone` e lo consentono allo staff — nessuno ci entra da
   solo, ma chiunque può esservi spostato, perché spostare un membro richiede
   il permesso di chi sposta, non di chi viene spostato.
   ═══════════════════════════════════════════════════════════════════════ */
async function creaAssistenza(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  modificati: string[],
  risultato: ProvisionResult,
): Promise<void> {
  const staff = config.general.staffRoleIds.filter((id) => guild.roles.cache.has(id));
  const nomeCategoria = 'Assistenza';

  let categoria = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === nomeCategoria,
  ) as CategoryChannel | undefined;

  if (!categoria) {
    const creata = await guild.channels
      .create({
        name: nomeCategoria,
        type: ChannelType.GuildCategory,
        reason: 'Predisposizione automatica di ANGEL',
      })
      .catch(() => null);
    if (!creata) {
      risultato.errori.push('categoria Assistenza');
      return;
    }
    categoria = creata;
    risultato.canaliCreati.push(nomeCategoria);
  }

  /* Sala d'attesa: aperta a chiunque. */
  if (!trovaCanale(guild, 'Sala d\'attesa', categoria.id)) {
    const attesa = await guild.channels
      .create({
        name: 'Sala d\'attesa',
        type: ChannelType.GuildVoice,
        parent: categoria.id,
        reason: 'Predisposizione automatica di ANGEL',
      })
      .catch(() => null);
    if (attesa) risultato.canaliCreati.push('Sala d\'attesa');
  }

  /* Stanze riservate: si entra solo se ci si viene spostati. */
  for (const nome of ['Assistenza 1', 'Assistenza 2']) {
    if (trovaCanale(guild, nome, categoria.id)) continue;
    const stanza = await guild.channels
      .create({
        name: nome,
        type: ChannelType.GuildVoice,
        parent: categoria.id,
        reason: 'Predisposizione automatica di ANGEL',
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] },
          ...staff.map((id) => ({
            id,
            allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers],
          })),
        ],
      })
      .catch(() => null);
    if (stanza) risultato.canaliCreati.push(nome);
  }

  /* Canale dei ticket, con il pannello già pubblicato. */
  let ticket = trovaCanale(guild, 'apri-un-ticket', categoria.id);
  if (!ticket) {
    const creato = await guild.channels
      .create({
        name: 'apri-un-ticket',
        type: ChannelType.GuildText,
        parent: categoria.id,
        topic: 'Premi il pulsante per aprire una richiesta privata con lo staff.',
        reason: 'Predisposizione automatica di ANGEL',
        permissionOverwrites: [
          // Si legge ma non si scrive: il canale contiene un pulsante, e i
          // messaggi degli utenti lo spingerebbero fuori dalla vista.
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] },
        ],
      })
      .catch(() => null);

    if (creato) {
      ticket = creato;
      risultato.canaliCreati.push('apri-un-ticket');
      await publishTicketPanel(guild, creato, config).catch(() => undefined);
    }
  }

  if (ticket) {
    if (scrivi(config, 'integrations.tickets.panelChannelId', ticket.id)) {
      modificati.push('integrations.tickets.panelChannelId');
      risultato.campiCompilati += 1;
    }
    if (scrivi(config, 'integrations.tickets.categoryId', categoria.id)) {
      modificati.push('integrations.tickets.categoryId');
      risultato.campiCompilati += 1;
    }
  }

  void client;
}

/* ═══════════════════════════════════════════════════════════════════════
   VERIFICA E ISOLAMENTO

   Il canale della verifica è l'unico che chi non ha ancora verificato può
   vedere. Tutto il resto gli viene negato.

   **La parte che conta è come viene negato.** Si aggiunge una negazione al
   ruolo di quarantena, canale per canale — non si tocca `@everyone` e non si
   concede mai nulla a nessuno. Una negazione non può rendere visibile ciò che
   era nascosto: qualunque canale già riservato agli amministratori resta
   esattamente com'era, perché aggiungere un divieto a un ruolo che comunque
   non lo vedeva non cambia niente.

   È il motivo per cui questa funzione non legge nemmeno i permessi esistenti:
   non le servono. L'operazione inversa — nascondere tutto a `@everyone` e poi
   riconcedere ai verificati — avrebbe richiesto di distinguere i canali
   pubblici da quelli privati, sbagliare una volta, ed esporre un canale
   riservato. Qui quel rischio non esiste per costruzione.
   ═══════════════════════════════════════════════════════════════════════ */
async function creaVerifica(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  modificati: string[],
  risultato: ProvisionResult,
): Promise<void> {
  const isolante =
    config.security.verification.quarantineRoleId ?? config.general.quarantineRoleId;
  if (!isolante || !guild.roles.cache.has(isolante)) return;

  /* Il canale, visibile a chi deve ancora verificare. */
  let verifica = guild.channels.cache.find(
    (channel) => channel.name === 'verifica' && channel.type === ChannelType.GuildText,
  );

  if (!verifica) {
    const creato = await guild.channels
      .create({
        name: 'verifica',
        type: ChannelType.GuildText,
        // In cima: è il primo e per un po' l'unico canale che il nuovo
        // arrivato vede, e cercarlo in fondo all'elenco è già un ostacolo.
        position: 0,
        topic: 'Premi il pulsante per accedere al server.',
        reason: 'Predisposizione automatica di ANGEL',
        permissionOverwrites: [
          {
            id: isolante,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages],
          },
        ],
      })
      .catch(() => null);

    if (!creato) {
      risultato.errori.push('canale verifica');
      return;
    }
    verifica = creato;
    risultato.canaliCreati.push('verifica');
    await pubblicaVerifica(client, guild, creato, config).catch(() => undefined);
  }

  if (scrivi(config, 'security.verification.verifyChannelId', verifica.id)) {
    modificati.push('security.verification.verifyChannelId');
    risultato.campiCompilati += 1;
  }

  risultato.canaliIsolati = await isolaNonVerificati(guild, isolante, verifica.id);
}

/**
 * Nega la vista al ruolo di quarantena ovunque tranne che nella verifica.
 *
 * Solo negazioni: nessun canale può risultare più visibile di prima. Si salta
 * chi ha già la negazione, così eseguirla a ogni avvio non produce centinaia
 * di chiamate inutili né voci nel registro di controllo del server.
 */
export async function isolaNonVerificati(
  guild: Guild,
  roleId: string,
  eccezioneCanaleId: string,
): Promise<number> {
  const canali = await guild.channels.fetch().catch(() => null);
  let isolati = 0;

  for (const canale of canali?.values() ?? []) {
    if (!canale || canale.id === eccezioneCanaleId) continue;
    if (!('permissionOverwrites' in canale)) continue;

    // Un canale dentro una categoria eredita da essa: negare sulla categoria
    // basta, e negare anche sui figli moltiplicherebbe le chiamate senza
    // aggiungere nulla. Si agisce quindi sulle categorie e sui canali che non
    // ne hanno una.
    //
    // Con una riserva: un canale figlio che ha già permessi propri non eredita
    // più dalla categoria, e va trattato singolarmente. È il caso frequente
    // dei canali riservati allo staff dentro una categoria pubblica.
    const eredita = canale.parentId !== null && canale.permissionOverwrites.cache.size === 0;
    if (eredita) continue;

    const attuale = canale.permissionOverwrites.cache.get(roleId);
    if (attuale?.deny.has(PermissionFlagsBits.ViewChannel)) continue;

    const fatto = await canale.permissionOverwrites
      .edit(roleId, { ViewChannel: false }, { reason: 'Isolamento di chi non ha verificato' })
      .then(() => true)
      .catch(() => false);

    if (fatto) isolati += 1;
  }

  return isolati;
}

/** Pubblica il pannello con il pulsante di verifica. */
async function pubblicaVerifica(
  client: Client,
  guild: Guild,
  channel: TextChannel,
  config: GuildConfig,
): Promise<void> {
  const settings = config.security.verification;

  const embed = new EmbedBuilder()
    .setTitle(`Benvenuto in ${guild.name}`)
    .setColor(0xd8b45f)
    .setDescription(
      'Premi il pulsante qui sotto per accedere al server.\n\n' +
        'Finché non lo fai vedi solo questo canale. Serve a fermare gli account ' +
        'automatici, che premono all\'istante o non premono affatto.',
    )
    .setFooter({
      text:
        settings.minDelaySec > 0
          ? `Il pulsante è attivo dopo ${settings.minDelaySec} secondi dal tuo ingresso.`
          : 'Premi il pulsante per accedere.',
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('aegis:verify')
      .setLabel('Verifica')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
  );

  const message = await channel.send({ embeds: [embed], components: [row] });

  await recordEvent(client, {
    guildId: guild.id,
    type: 'PANEL_ACTION',
    actorId: client.user?.id,
    channelId: channel.id,
    messageId: message.id,
    summary: `Pannello di verifica pubblicato in <#${channel.id}>`,
  });
}

function trovaCanale(guild: Guild, nome: string, parentId: string) {
  return guild.channels.cache.find(
    (channel) => channel.name === nome && channel.parentId === parentId,
  );
}

/**
 * La categoria che contiene i canali di servizio, riservata allo staff.
 *
 * I permessi si impostano alla creazione e non dopo: un canale di registro
 * visibile a tutti anche per pochi secondi ha già mostrato a chiunque quali
 * difese sono attive e cosa hanno visto.
 */
async function assicuraCategoria(
  guild: Guild,
  config: GuildConfig,
): Promise<CategoryChannel | null> {
  const nome = 'ANGEL';
  const esistente = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === nome,
  );
  if (esistente) return esistente as CategoryChannel;

  const staff = config.general.staffRoleIds.filter((id) => guild.roles.cache.has(id));

  return guild.channels
    .create({
      name: nome,
      type: ChannelType.GuildCategory,
      reason: 'Predisposizione automatica di ANGEL',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...staff.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel] })),
      ],
    })
    .catch((error: unknown) => {
      log.warn({ err: error }, 'creazione della categoria fallita');
      return null;
    });
}

/**
 * Nega la parola al ruolo di quarantena in ogni canale esistente.
 *
 * Un ruolo senza permessi non isola: su Discord i permessi si sommano, e chi
 * ha `@everyone` che consente di scrivere continua a scrivere anche con un
 * ruolo vuoto addosso. Serve una negazione esplicita, canale per canale.
 */
async function isolaRuolo(guild: Guild, roleId: string): Promise<void> {
  const canali = await guild.channels.fetch().catch(() => null);
  const bloccabili = [...(canali?.values() ?? [])].filter(
    (channel) =>
      channel !== null &&
      [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildForum,
        ChannelType.GuildVoice,
      ].includes(channel.type),
  );

  for (const channel of bloccabili) {
    await channel!.permissionOverwrites
      ?.edit(
        roleId,
        {
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          AddReactions: false,
          Speak: false,
          Connect: false,
        },
        { reason: 'Ruolo di quarantena di ANGEL' },
      )
      .catch(() => undefined);
  }
}

/* ── Accesso ai campi per percorso ──────────────────────────────────────
   La configurazione è un oggetto annidato e i percorsi sono stringhe come
   `security.verification.verifiedRoleId`. Scrivere venti accessi espliciti
   sarebbe più veloce da leggere ma andrebbe aggiornato a ogni campo nuovo,
   che è esattamente il tipo di manutenzione che si dimentica. */

function leggi(oggetto: unknown, percorso: string): unknown {
  return percorso.split('.').reduce<unknown>((valore, chiave) => {
    if (valore && typeof valore === 'object' && chiave in valore) {
      return (valore as Record<string, unknown>)[chiave];
    }
    return undefined;
  }, oggetto);
}

/**
 * Scrive l'ID nel campo, rispettando ciò che c'è già.
 *
 * Restituisce true solo se ha davvero cambiato qualcosa: serve a registrare
 * nello storico i soli percorsi toccati, e a non salvare affatto quando non
 * c'è nulla di nuovo.
 */
function scrivi(oggetto: Record<string, unknown>, percorso: string, id: string): boolean {
  const chiavi = percorso.split('.');
  const ultima = chiavi.pop();
  if (!ultima) return false;

  let cursore: Record<string, unknown> = oggetto;
  for (const chiave of chiavi) {
    const prossimo = cursore[chiave];
    if (typeof prossimo !== 'object' || prossimo === null) return false;
    cursore = prossimo as Record<string, unknown>;
  }

  const attuale = cursore[ultima];

  // Campo a elenco: si aggiunge, non si sostituisce. Sovrascrivere i ruoli
  // staff di un server già avviato sarebbe un danno, non una comodità.
  if (Array.isArray(attuale)) {
    if (attuale.includes(id)) return false;
    cursore[ultima] = [...attuale, id];
    return true;
  }

  if (attuale) return false;
  cursore[ultima] = id;
  return true;
}

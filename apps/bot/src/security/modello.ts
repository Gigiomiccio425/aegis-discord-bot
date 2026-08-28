import {
  ChannelType,
  GuildVerificationLevel,
  GuildExplicitContentFilter,
  PermissionFlagsBits,
  type CategoryChannel,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type TextChannel,
} from 'discord.js';
import { GuildConfigSchema, type GuildConfig } from '@angel/shared';
import { childLogger } from '../core/logger.js';
import { saveGuildConfig } from '../core/config.js';

const log = childLogger('modello');

/* ═══════════════════════════════════════════════════════════════════════
   IL MODELLO DEL SERVER

   La predisposizione crea ciò che serve al bot: registro, allerta,
   segnalazioni, verifica, ticket. È la parte di servizio, e da sola non fa un
   server — fa un pannello di controllo con una chat attaccata.

   Questo modello aggiunge la parte che la gente vede: dove si presenta, dove
   chiacchiera, dove trova gli annunci, dove finiscono i messaggi più belli. È
   costruito sulla struttura che ricorre in ogni guida seria alle community
   Discord, e che regge perché segue il percorso di chi arriva:

     1. **Prima si capisce dove si è**: regolamento, annunci, ruoli, verifica.
        In cima, perché sono le uniche cose che servono nei primi trenta
        secondi e non serviranno mai più.
     2. **Poi si parla**: pochi canali generali. Un server nuovo con venti
        canali tematici è venti canali vuoti, e il vuoto scoraggia più di una
        chat affollata.
     3. **Poi le cose specifiche**: dirette, clip, eventi.
     4. **In fondo lo staff e l'assistenza**, che ai membri non servono.

   ── Lo stile ─────────────────────────────────────────────────────────

   Segue l'immagine di yayadoppia: un angioletto bianco mutaforma. Bianco,
   nuvole, piume, luce; colori pastello vivaci invece del solito grigio scuro;
   nomi con caratteri decorativi ed emoji, perché su Discord la barra dei
   canali *è* l'identità visiva del server — è la prima cosa che si vede e
   l'unica sempre visibile.

   Il decoro resta però leggibile: i separatori tipografici vanno nelle
   categorie e nei vocali, dove Discord conserva maiuscole e spazi, mentre nei
   canali testuali — che vengono forzati in minuscolo con i trattini — si usa
   una sola emoji davanti e una parola chiara dietro. Un canale che non si
   riesce a leggere di sfuggita è un canale in cui non si scrive.
   ═══════════════════════════════════════════════════════════════════════ */

interface CanaleModello {
  /** Nome finale. Per i testuali: emoji + separatore + parola. */
  nome: string;
  tipo: 'testo' | 'vocale' | 'annunci' | 'forum';
  argomento?: string;
  /** Percorsi di configurazione da compilare con l'ID del canale. */
  percorsi?: string[];
  /** Solo staff: `@everyone` non lo vede. */
  riservato?: boolean;
  /** Nessuno scrive tranne lo staff: regolamento, annunci. */
  soloLettura?: boolean;
  /** Secondi di modalità lenta. */
  lento?: number;
}

interface CategoriaModello {
  nome: string;
  descrizione: string;
  canali: CanaleModello[];
  riservata?: boolean;
}

/** I ruoli d'identità: non danno poteri, dicono chi sei e cosa vuoi ricevere. */
interface RuoloModello {
  nome: string;
  colore: number;
  separato: boolean;
  descrizione: string;
}

const RUOLI_MODELLO: RuoloModello[] = [
  {
    nome: '⋆｡°✩ Angelo Maggiore',
    colore: 0xfff6d5,
    separato: true,
    descrizione: 'Chi guida il server. Sopra tutti nella gerarchia, sotto nessuno.',
  },
  {
    nome: '☾ Ali Guardiane',
    colore: 0xbfd8ff,
    separato: true,
    descrizione: 'Moderazione: silenzia, espelle, bandisce, gestisce i ticket.',
  },
  {
    nome: '✿ Piume',
    colore: 0xc8f7dc,
    separato: true,
    descrizione: 'Aiutanti: rispondono, accolgono, segnalano. Nessun potere di sanzione.',
  },
  {
    nome: '♡ Nuvola d’oro',
    colore: 0xffd1dc,
    separato: true,
    descrizione: 'Chi ha potenziato il server. Riconoscenza, non permessi.',
  },
  {
    nome: '˚ʚ♡ɞ˚ Piumette',
    colore: 0xe6ccff,
    separato: false,
    descrizione: 'La community. Si ottiene con la verifica.',
  },
  {
    nome: '⋆ Avviso diretta',
    colore: 0x9146ff,
    separato: false,
    descrizione: 'Menzionato quando comincia una diretta. Si prende e si lascia da soli.',
  },
  {
    nome: '✦ Avviso video',
    colore: 0xff6b6b,
    separato: false,
    descrizione: 'Menzionato quando esce un video nuovo.',
  },
  {
    nome: '✧ Avviso eventi',
    colore: 0xffe9a8,
    separato: false,
    descrizione: 'Menzionato per eventi, giochi insieme, serate a tema.',
  },
];

const MODELLO: CategoriaModello[] = [
  {
    nome: '｡ﾟ☁︎ INIZIA DA QUI ☁︎ﾟ｡',
    descrizione: 'Le uniche cose che servono nei primi trenta secondi.',
    canali: [
      {
        nome: '📜│regolamento',
        tipo: 'testo',
        soloLettura: true,
        argomento: 'Poche regole, scritte chiare. Restare qui significa accettarle.',
      },
      {
        nome: '🕊│verifica',
        tipo: 'testo',
        argomento: 'Un pulsante, e il server si apre. Serve a tenere fuori i bot.',
        percorsi: ['security.verification.verifyChannelId'],
      },
      {
        nome: '📣│annunci',
        tipo: 'annunci',
        soloLettura: true,
        argomento: 'Novità importanti. Si può seguire da altri server.',
      },
      {
        nome: '🎀│prendi-i-ruoli',
        tipo: 'testo',
        soloLettura: true,
        argomento: 'Scegli cosa vuoi che ti venga notificato.',
      },
      {
        nome: '👋│presentati',
        tipo: 'testo',
        lento: 30,
        argomento: 'Chi sei, cosa ti piace, come sei arrivato qui.',
      },
    ],
  },
  {
    nome: '˚₊‧ ୨୧ NUVOLE ୨୧ ‧₊˚',
    descrizione: 'Pochi canali, e pieni. Venti canali vuoti scoraggiano più di una chat affollata.',
    canali: [
      { nome: '☁️│chiacchiere', tipo: 'testo', argomento: 'Il canale principale. Si parla di tutto.' },
      { nome: '🍰│fuori-tema', tipo: 'testo', argomento: 'Quando la conversazione va altrove.' },
      {
        nome: '📸│scatti-e-arte',
        tipo: 'testo',
        argomento: 'Disegni, foto, fan art. Metti il credito a chi l’ha fatto.',
      },
      { nome: '🎮│giochi', tipo: 'testo', argomento: 'Cosa state giocando, e con chi.' },
      { nome: '🎵│musica', tipo: 'testo', argomento: 'Quello che avete in cuffia adesso.' },
    ],
  },
  {
    nome: '✧ﾟ･: LUCI ACCESE :･ﾟ✧',
    descrizione: 'Tutto ciò che il bot pubblica da solo: dirette, clip, video, eventi.',
    canali: [
      {
        nome: '🔴│in-diretta',
        tipo: 'annunci',
        soloLettura: true,
        argomento: 'Quando la diretta comincia, l’avviso arriva qui.',
      },
      {
        nome: '🎬│clip',
        tipo: 'testo',
        soloLettura: true,
        argomento: 'I momenti migliori, raccolti automaticamente.',
      },
      {
        nome: '📺│video-nuovi',
        tipo: 'annunci',
        soloLettura: true,
        argomento: 'Ogni caricamento su YouTube.',
      },
      {
        nome: '📰│dal-web',
        tipo: 'testo',
        soloLettura: true,
        argomento: 'Feed seguiti: blog, novità, uscite.',
      },
      {
        nome: '🗓│eventi',
        tipo: 'testo',
        soloLettura: true,
        argomento: 'Serate insieme, giochi, ospiti. Con promemoria.',
      },
    ],
  },
  {
    nome: '♡ ｡ﾟ COMUNITÀ ﾟ｡ ♡',
    descrizione: 'Le cose che la community fa, non che le vengono dette.',
    canali: [
      {
        nome: '⭐│bacheca',
        tipo: 'testo',
        soloLettura: true,
        argomento: 'I messaggi più apprezzati finiscono qui, scelti da voi con una reazione.',
        percorsi: ['integrations.starboard.channelId'],
      },
      { nome: '🗳│sondaggi', tipo: 'testo', argomento: 'Domande alla community.' },
      {
        nome: '🎁│giveaway',
        tipo: 'testo',
        soloLettura: true,
        argomento: 'Regali e sorteggi. Si partecipa con un pulsante.',
      },
      {
        nome: '💡│suggerimenti',
        tipo: 'forum',
        argomento: 'Idee per il server. Ogni proposta è una discussione a sé.',
      },
    ],
  },
  {
    nome: '₊˚ ✧ VOCI ✧ ˚₊',
    descrizione: 'Vocali, dal salotto al palco.',
    canali: [
      { nome: '☁️ Salotto', tipo: 'vocale' },
      { nome: '🎧 Ascolti', tipo: 'vocale' },
      { nome: '🎮 Partita', tipo: 'vocale' },
      { nome: '🛋 Pausa', tipo: 'vocale' },
    ],
  },
  {
    nome: '♱ STAFF ♱',
    descrizione: 'Riservata. I membri non la vedono.',
    riservata: true,
    canali: [
      {
        nome: '🔔│aggiornamenti-server',
        tipo: 'testo',
        riservato: true,
        argomento: 'Discord scrive qui le comunicazioni per i server community.',
      },
      { nome: '💬│staff', tipo: 'testo', riservato: true, argomento: 'Coordinamento fra moderatori.' },
      { nome: '🗒│note-interne', tipo: 'testo', riservato: true, argomento: 'Decisioni, casi aperti, promemoria.' },
      { nome: '🔒 Riunione', tipo: 'vocale', riservato: true },
    ],
  },
];

/** Il modello appiattito: serve ai test, che devono poterlo esaminare voce per voce. */
export const CANALI_MODELLO = MODELLO.flatMap((categoria) =>
  categoria.canali.map((canale) => ({ ...canale, categoria: categoria.nome })),
);

/** I nomi dei ruoli del modello, per il controllo dei doppioni. */
export const RUOLI_MODELLO_NOMI = RUOLI_MODELLO.map((ruolo) => ruolo.nome);

export interface EsitoModello {
  categorieCreate: string[];
  canaliCreati: string[];
  ruoliCreati: string[];
  community: 'attivata' | 'già attiva' | 'non riuscita' | 'saltata';
  campiCompilati: number;
  errori: string[];
}

/**
 * Costruisce il modello nel server, senza duplicare nulla.
 *
 * Idempotente per costruzione: tutto si cerca per nome prima di crearlo. Si
 * può rieseguire dopo aver cancellato un canale per riaverlo, e rieseguire
 * senza aver cancellato niente non produce nessuna modifica — che è la
 * proprietà che rende il comando premibile senza paura.
 */
export async function costruisciModello(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  attore: string,
): Promise<EsitoModello> {
  const esito: EsitoModello = {
    categorieCreate: [],
    canaliCreati: [],
    ruoliCreati: [],
    community: 'saltata',
    campiCompilati: 0,
    errori: [],
  };

  const me = await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    esito.errori.push('manca il permesso di gestire i canali');
    return esito;
  }

  const bozza = GuildConfigSchema.parse(structuredClone(config));
  const modificati: string[] = [];

  /* ── Ruoli d'identità ──────────────────────────────────────── */
  if (me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    for (const spec of RUOLI_MODELLO) {
      if (guild.roles.cache.some((role) => role.name === spec.nome)) continue;

      const creato = await guild.roles
        .create({
          name: spec.nome,
          color: spec.colore,
          hoist: spec.separato,
          mentionable: false,
          reason: `Modello del server, richiesto da ${attore}`,
        })
        .catch((errore: unknown) => {
          log.warn({ err: errore, ruolo: spec.nome }, 'ruolo del modello non creato');
          return null;
        });

      if (creato) esito.ruoliCreati.push(spec.nome);
    }
  }

  /* ── Categorie e canali ────────────────────────────────────── */
  const staff = bozza.general.staffRoleIds.filter((id) => guild.roles.cache.has(id));

  for (const categoria of MODELLO) {
    const contenitore = await assicuraCategoria(guild, categoria, staff, esito, attore);
    if (!contenitore) continue;

    for (const canale of categoria.canali) {
      const creato = await assicuraCanale(guild, contenitore, canale, staff, esito, attore);
      if (!creato) continue;

      for (const percorso of canale.percorsi ?? []) {
        if (scriviSeVuoto(bozza, percorso, creato.id)) {
          modificati.push(percorso);
          esito.campiCompilati += 1;
        }
      }
    }
  }

  /* ── Modalità community ────────────────────────────────────── */
  esito.community = await attivaCommunity(guild, esito);

  if (modificati.length > 0) {
    await saveGuildConfig(guild.id, bozza, { id: attore, source: 'system', paths: modificati });
  }

  log.info(
    {
      guildId: guild.id,
      categorie: esito.categorieCreate.length,
      canali: esito.canaliCreati.length,
      ruoli: esito.ruoliCreati.length,
      community: esito.community,
    },
    'modello applicato',
  );

  return esito;
}

/* ── Costruzione ──────────────────────────────────────────────── */

async function assicuraCategoria(
  guild: Guild,
  categoria: CategoriaModello,
  staff: string[],
  esito: EsitoModello,
  attore: string,
): Promise<CategoryChannel | null> {
  const esistente = guild.channels.cache.find(
    (canale) => canale.type === ChannelType.GuildCategory && canale.name === categoria.nome,
  );
  if (esistente) return esistente as CategoryChannel;

  const creata = await guild.channels
    .create({
      name: categoria.nome,
      type: ChannelType.GuildCategory,
      reason: `Modello del server, richiesto da ${attore}`,
      permissionOverwrites: categoria.riservata
        ? [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            ...staff.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel] })),
          ]
        : undefined,
    })
    .catch((errore: unknown) => {
      log.warn({ err: errore, categoria: categoria.nome }, 'categoria non creata');
      esito.errori.push(`categoria ${categoria.nome}`);
      return null;
    });

  if (creata) esito.categorieCreate.push(categoria.nome);
  return creata;
}

/**
 * Il canale, se non c'è già.
 *
 * Il confronto sul nome tiene conto di come Discord riscrive i nomi dei canali
 * testuali: minuscole, spazi in trattini. Senza questa accortezza ogni
 * riesecuzione creerebbe un doppione del canale appena creato — che è
 * esattamente ciò che un comando idempotente non deve fare.
 */
async function assicuraCanale(
  guild: Guild,
  categoria: CategoryChannel,
  modello: CanaleModello,
  staff: string[],
  esito: EsitoModello,
  attore: string,
): Promise<GuildBasedChannel | null> {
  const atteso = normalizzaNome(modello.nome, modello.tipo);

  const esistente = guild.channels.cache.find(
    (canale) =>
      canale.parentId === categoria.id && normalizzaNome(canale.name, modello.tipo) === atteso,
  );
  if (esistente) return esistente;

  const tipo =
    modello.tipo === 'vocale'
      ? ChannelType.GuildVoice
      : modello.tipo === 'annunci'
        ? ChannelType.GuildAnnouncement
        : modello.tipo === 'forum'
          ? ChannelType.GuildForum
          : ChannelType.GuildText;

  const permessi = [];
  if (modello.riservato) {
    permessi.push({ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] });
    permessi.push(...staff.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel] })));
  } else if (modello.soloLettura) {
    // Legge chiunque, scrive solo lo staff. È la differenza fra un canale di
    // annunci e una bacheca che diventa una chat entro due giorni.
    permessi.push({ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] });
    permessi.push(...staff.map((id) => ({ id, allow: [PermissionFlagsBits.SendMessages] })));
  }

  const creato = await guild.channels
    .create({
      name: modello.nome,
      type: tipo,
      parent: categoria.id,
      topic: modello.tipo === 'vocale' ? undefined : modello.argomento,
      rateLimitPerUser: modello.lento,
      permissionOverwrites: permessi.length > 0 ? permessi : undefined,
      reason: `Modello del server, richiesto da ${attore}`,
    })
    .catch((errore: unknown) => {
      // I canali annunci e forum esistono solo nei server community: se la
      // modalità non è ancora attiva, si riprova come canale testuale invece
      // di lasciare un buco nella struttura.
      log.debug({ err: errore, canale: modello.nome }, 'creazione fallita, riprovo come testuale');
      return null;
    });

  if (creato) {
    esito.canaliCreati.push(modello.nome);
    return creato;
  }

  if (modello.tipo === 'annunci' || modello.tipo === 'forum') {
    const ripiego = await guild.channels
      .create({
        name: modello.nome,
        type: ChannelType.GuildText,
        parent: categoria.id,
        topic: modello.argomento,
        permissionOverwrites: permessi.length > 0 ? permessi : undefined,
        reason: `Modello del server (ripiego testuale), richiesto da ${attore}`,
      })
      .catch(() => null);

    if (ripiego) {
      esito.canaliCreati.push(`${modello.nome} (come testuale)`);
      return ripiego;
    }
  }

  esito.errori.push(`canale ${modello.nome}`);
  return null;
}

/**
 * Accende la modalità community.
 *
 * Discord la concede via API a un bot con Amministratore, ma pretende tre cose
 * nella stessa richiesta e non lo dice: il canale del regolamento, il canale
 * degli aggiornamenti per lo staff, e le due impostazioni di sicurezza minime
 * — verifica almeno bassa e filtro dei contenuti su tutti. Mandandone anche
 * una sola in meno, la risposta è un 403 «funzione temporaneamente
 * disabilitata» che non c'entra nulla con la causa vera.
 */
async function attivaCommunity(guild: Guild, esito: EsitoModello): Promise<EsitoModello['community']> {
  if (guild.features.includes('COMMUNITY')) return 'già attiva';

  const me = await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.Administrator)) {
    esito.errori.push('modalità community: serve il permesso Amministratore');
    return 'non riuscita';
  }

  const regolamento = trovaTestuale(guild, 'regolamento');
  const aggiornamenti = trovaTestuale(guild, 'aggiornamenti-server');

  if (!regolamento || !aggiornamenti) {
    esito.errori.push('modalità community: mancano il canale regolamento o quello aggiornamenti');
    return 'non riuscita';
  }

  const fatto = await guild
    .edit({
      features: [...guild.features, 'COMMUNITY'],
      rulesChannel: regolamento,
      publicUpdatesChannel: aggiornamenti,
      verificationLevel: GuildVerificationLevel.Low,
      explicitContentFilter: GuildExplicitContentFilter.AllMembers,
      reason: 'Modello del server: modalità community',
    })
    .then(() => true)
    .catch((errore: unknown) => {
      log.warn({ err: errore, guildId: guild.id }, 'attivazione community fallita');
      esito.errori.push('modalità community rifiutata da Discord');
      return false;
    });

  return fatto ? 'attivata' : 'non riuscita';
}

/* ── Utilità ──────────────────────────────────────────────────── */

/** Come Discord riscrive un nome di canale: minuscole e trattini al posto degli spazi. */
function normalizzaNome(nome: string, tipo: CanaleModello['tipo']): string {
  if (tipo === 'vocale') return nome.trim();
  return nome.trim().toLowerCase().replace(/\s+/g, '-');
}

function trovaTestuale(guild: Guild, frammento: string): TextChannel | null {
  const trovato = guild.channels.cache.find(
    (canale) => canale.type === ChannelType.GuildText && canale.name.includes(frammento),
  );
  return (trovato as TextChannel | undefined) ?? null;
}

/**
 * Scrive un percorso solo se vuoto.
 *
 * Non sovrascrive mai: chi ha già scelto il proprio canale degli annunci lo ha
 * fatto apposta, e un modello che rimette tutto «a posto» è un modello che si
 * esegue una volta sola e poi si teme.
 */
function scriviSeVuoto(oggetto: Record<string, unknown>, percorso: string, id: string): boolean {
  const chiavi = percorso.split('.');
  const ultima = chiavi.pop();
  if (!ultima) return false;

  let cursore: Record<string, unknown> = oggetto;
  for (const chiave of chiavi) {
    const prossimo = cursore[chiave];
    if (typeof prossimo !== 'object' || prossimo === null) return false;
    cursore = prossimo as Record<string, unknown>;
  }

  if (cursore[ultima] !== null && cursore[ultima] !== undefined) return false;
  cursore[ultima] = id;
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   I RUOLI, IN UN POSTO SOLO

   Prima erano due elenchi che non si conoscevano: la predisposizione creava
   `ANGEL · Staff`, il modello creava `☾ Ali Guardiane`, e un moderatore
   doveva averli tutti e due — uno perché il bot lo esentasse, l'altro perché
   si vedesse nella lista membri. Due ruoli per la stessa persona, e nessuno
   dei due che facesse da solo il proprio lavoro.

   Adesso c'è un ruolo per concetto. Nasce con il nome tecnico — `ANGEL ·
   Staff` — e quando si sceglie uno stile **cambia nome, colore e permessi
   restando lo stesso ruolo**. L'identificativo non cambia mai, quindi la
   configurazione non va riscritta, i permessi sui canali restano dove sono,
   e chi lo aveva continua ad averlo.

   ── Perché lo stile non ricrea niente ──────────────────────────────────

   Ricreare sarebbe stato più semplice da scrivere e sbagliato in tre modi: i
   membri perderebbero il ruolo, ogni permesso impostato a mano sui canali
   punterebbe a un ruolo morto, e la configurazione conserverebbe un
   identificativo che non esiste più. Rinominare costa una chiamata e non
   rompe niente.

   ── Sui permessi, che il bot prima non dava mai ────────────────────────

   Fino alla 1.26 questi ruoli nascevano tutti senza permessi, di proposito:
   un bot che distribuisce poteri che nessuno ha chiesto è il modo classico
   per regalare mezzo server a qualcuno. Adesso li assegna, ma con tre regole
   che restano non negoziabili:

   1. **Solo quando si sceglie uno stile.** L'installazione di base continua a
      creare ruoli inerti; i permessi arrivano quando qualcuno ha detto che
      tipo di server vuole.

   2. **Si aggiungono, non si sostituiscono.** Se hai dato dei permessi a mano
      restano: il bot non toglie mai niente. Chi vuole ridurre un ruolo lo fa
      da Discord, e nessuna riesecuzione glielo rimette come dice questo file.

   3. **Mai `Amministratore`, mai `Gestire i ruoli`, mai `Gestire i canali`.**
      Sono le tre chiavi con cui si prende il controllo di un server, e
      restano una decisione di una persona. Vale anche per la Guida, che è il
      ruolo più alto: gli si dà tutto il resto, e quelle tre si aggiungono a
      mano sapendo cosa si fa.
   ═══════════════════════════════════════════════════════════════════════ */

import { PermissionFlagsBits, type Guild, type Role } from 'discord.js';
import type { GuildConfig } from '@angel/shared';
import { childLogger } from '../core/logger.js';

const log = childLogger('ruoli');

/* ── Stili ────────────────────────────────────────────────────────────── */

/**
 * Come si chiamano i ruoli.
 *
 * `TECNICO` è quello di partenza: nomi espliciti, riconoscibili, brutti
 * apposta — chi li vede capisce che li gestisce il bot e non li rinomina per
 * sbaglio. Gli altri sono i vestiti che si scelgono con `/crea-server`.
 */
export type StileRuoli = 'TECNICO' | 'ANGELICO';

export const STILI: { chiave: StileRuoli; nome: string; descrizione: string }[] = [
  {
    chiave: 'TECNICO',
    nome: 'Tecnico',
    descrizione:
      'Nomi espliciti con il prefisso ANGEL. Si riconoscono a colpo d’occhio come ruoli del bot.',
  },
  {
    chiave: 'ANGELICO',
    nome: 'Angelico',
    descrizione:
      'Nuvole, piume e caratteri speciali. Lo stile del modello di server: bianco, colorato, accogliente.',
  },
];

interface Vestito {
  nome: string;
  colore: `#${string}`;
  separato: boolean;
}

/* ── Permessi ─────────────────────────────────────────────────────────── */

/**
 * Quello che un ruolo riceve quando si applica uno stile.
 *
 * `MODERAZIONE` è lo stesso insieme del ruolo del proprietario: due elenchi
 * diversi per la stessa idea sarebbero divergenti entro un paio di versioni.
 */
const PERMESSI = {
  NESSUNO: [] as bigint[],

  MODERAZIONE: [
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.ManageNicknames,
  ],

  /*
   * La guida del server: moderazione, più quello che serve a tenerlo in ordine.
   *
   * Senza `ManageRoles` e `ManageChannels`, che pure sembrerebbero naturali
   * per «chi guida»: chi può assegnare ruoli può assegnarsi qualunque cosa, e
   * un livello che concede la scalata completa non è un livello. Chi vuole
   * darglieli lo fa da Discord in dieci secondi, e in quel momento sa cosa sta
   * facendo.
   */
  GUIDA: [
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.ManageNicknames,
    PermissionFlagsBits.ManageGuildExpressions,
    PermissionFlagsBits.ManageEvents,
    PermissionFlagsBits.MoveMembers,
    PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.DeafenMembers,
    PermissionFlagsBits.MentionEveryone,
  ],
} as const;

export type LivelloPermessi = keyof typeof PERMESSI;

/* ── Il registro ──────────────────────────────────────────────────────── */

export interface RuoloSpec {
  chiave: string;
  /** Creato già dalla predisposizione, o solo quando si costruisce il server. */
  base: boolean;
  descrizione: string;
  /** Chi dovrebbe averlo, in una riga. Compare nel riepilogo dei comandi. */
  aChiVa: string;
  permessi: LivelloPermessi;
  /** Dove finisce l'identificativo. Un ruolo può servire a più campi. */
  percorsi: string[];
  /** Nasce senza permessi e viene negato ovunque: serve a isolare. */
  isolante?: boolean;
  vestiti: Record<StileRuoli, Vestito>;
}

export const RUOLI: RuoloSpec[] = [
  /*
   * Due ruoli distinti, e la distinzione non è formale.
   *
   * «Non verificato» è la condizione normale di chiunque arrivi: non ha ancora
   * premuto un pulsante. «Quarantena» è un provvedimento. Usare lo stesso
   * ruolo per entrambi significa accogliere ogni nuovo membro con un'etichetta
   * che dice «sospetto», e riempire l'elenco dei quarantenati con persone che
   * non hanno fatto nulla — rendendolo inservibile proprio per ciò a cui
   * serve. Anche gli effetti sono opposti: chi non ha verificato non deve
   * *vedere*, chi è in quarantena vede e non può *scrivere*.
   */
  {
    chiave: 'non-verificato',
    base: true,
    descrizione: 'Vede solo il canale della verifica, finché non la supera.',
    aChiVa: 'a chiunque entri — lo mette il bot, non lo tocchi mai',
    permessi: 'NESSUNO',
    percorsi: ['security.verification.unverifiedRoleId'],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Non verificato', colore: '#6d7c94', separato: false },
      ANGELICO: { nome: '☁︎ In attesa', colore: '#6d7c94', separato: false },
    },
  },
  {
    chiave: 'quarantena',
    base: true,
    descrizione: 'Isola chi è sospettato: legge ovunque, non scrive da nessuna parte.',
    aChiVa: 'lo mette il bot, o un moderatore con /quarantena',
    permessi: 'NESSUNO',
    percorsi: ['general.quarantineRoleId'],
    isolante: true,
    vestiti: {
      TECNICO: { nome: 'ANGEL · Quarantena', colore: '#8a8578', separato: false },
      ANGELICO: { nome: '⛆ Nube grigia', colore: '#8a8578', separato: false },
    },
  },
  {
    chiave: 'verificato',
    base: true,
    descrizione: 'La chiave del server: i canali sono negati a @everyone e concessi a questo.',
    aChiVa: 'a chi supera la verifica — lo mette il bot',
    permessi: 'NESSUNO',
    percorsi: ['security.verification.verifiedRoleId'],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Verificato', colore: '#5fbf8b', separato: false },
      ANGELICO: { nome: '˚ʚ♡ɞ˚ Piumette', colore: '#e6ccff', separato: false },
    },
  },
  {
    chiave: 'guida',
    base: false,
    descrizione: 'Chi guida il server. Sopra tutti nella gerarchia, sotto nessuno.',
    aChiVa: 'a te, e a chi divide con te la responsabilità del server',
    permessi: 'GUIDA',
    percorsi: [],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Guida', colore: '#fff6d5', separato: true },
      ANGELICO: { nome: '⋆｡°✩ Angelo Maggiore', colore: '#fff6d5', separato: true },
    },
  },
  {
    chiave: 'staff',
    base: true,
    descrizione:
      'Esente dai moduli, e abilitato a sondaggi, eventi, giveaway e ticket. Sei campi puntano qui.',
    aChiVa: 'ai moderatori veri, e a nessun altro',
    permessi: 'MODERAZIONE',
    percorsi: [
      'general.staffRoleIds',
      'security.accountGuard.staffRoleIds',
      'integrations.polls.creatorRoleIds',
      'integrations.events.managerRoleIds',
      'integrations.giveaways.hostRoleIds',
      'integrations.tickets.supportRoleIds',
    ],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Staff', colore: '#d8b45f', separato: true },
      ANGELICO: { nome: '☾ Ali Guardiane', colore: '#bfd8ff', separato: true },
    },
  },
  {
    chiave: 'aiutanti',
    base: false,
    descrizione: 'Rispondono, accolgono, segnalano. Nessun potere di sanzione, di proposito.',
    aChiVa: 'a chi dà una mano ma non deve poter bandire nessuno',
    permessi: 'NESSUNO',
    percorsi: [],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Aiutanti', colore: '#c8f7dc', separato: true },
      ANGELICO: { nome: '✿ Piume', colore: '#c8f7dc', separato: true },
    },
  },
  {
    chiave: 'sostenitori',
    base: false,
    descrizione: 'Riconoscenza, non permessi.',
    aChiVa: 'a chi ha potenziato il server',
    permessi: 'NESSUNO',
    percorsi: [],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Sostenitori', colore: '#ffd1dc', separato: true },
      ANGELICO: { nome: '♡ Nuvola d’oro', colore: '#ffd1dc', separato: true },
    },
  },
  {
    chiave: 'allerta',
    base: true,
    descrizione: 'Menzionato quando succede qualcosa di grave. Nessun permesso.',
    aChiVa: 'a chi vuoi svegliare di notte per un raid o un nuke',
    permessi: 'NESSUNO',
    percorsi: ['general.alertRoleId'],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Allerta', colore: '#e05263', separato: true },
      ANGELICO: { nome: '⚡ Sveglia le ali', colore: '#e05263', separato: true },
    },
  },
  {
    chiave: 'diretta',
    base: true,
    descrizione: 'Assegnato allo streamer mentre trasmette. Richiede l’account Discord collegato.',
    aChiVa: 'lo mette e lo toglie il bot',
    permessi: 'NESSUNO',
    percorsi: [],
    vestiti: {
      TECNICO: { nome: 'ANGEL · In diretta', colore: '#9146ff', separato: false },
      ANGELICO: { nome: '✧ Luci accese', colore: '#9146ff', separato: false },
    },
  },
  {
    chiave: 'partecipa',
    base: true,
    descrizione: 'Serve ai promemoria degli eventi programmati.',
    aChiVa: 'a chi conferma la presenza — lo mette il bot',
    permessi: 'NESSUNO',
    percorsi: ['integrations.events.rsvpRoleId'],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Partecipa', colore: '#6f8a95', separato: false },
      ANGELICO: { nome: '✿ Ci sarò', colore: '#6f8a95', separato: false },
    },
  },

  /* ── Avvisi: si prendono e si lasciano da soli ────────────────────────
     Non hanno un campo di configurazione perché non li assegna il bot: si
     collegano ai ruoli con reazione nel canale «prendi-i-ruoli», e chi non
     usa quel canale non ne ha bisogno. */
  {
    chiave: 'avviso-diretta',
    base: false,
    descrizione: 'Menzionato quando comincia una diretta.',
    aChiVa: 'se lo prende chi vuole, da «prendi-i-ruoli»',
    permessi: 'NESSUNO',
    percorsi: [],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Avviso diretta', colore: '#9146ff', separato: false },
      ANGELICO: { nome: '⋆ Avviso diretta', colore: '#9146ff', separato: false },
    },
  },
  {
    chiave: 'avviso-video',
    base: false,
    descrizione: 'Menzionato quando esce un video nuovo.',
    aChiVa: 'se lo prende chi vuole, da «prendi-i-ruoli»',
    permessi: 'NESSUNO',
    percorsi: [],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Avviso video', colore: '#ff6b6b', separato: false },
      ANGELICO: { nome: '✦ Avviso video', colore: '#ff6b6b', separato: false },
    },
  },
  {
    chiave: 'avviso-eventi',
    base: false,
    descrizione: 'Menzionato per eventi, giochi insieme, serate a tema.',
    aChiVa: 'se lo prende chi vuole, da «prendi-i-ruoli»',
    permessi: 'NESSUNO',
    percorsi: [],
    vestiti: {
      TECNICO: { nome: 'ANGEL · Avviso eventi', colore: '#ffe9a8', separato: false },
      ANGELICO: { nome: '✧ Avviso eventi', colore: '#ffe9a8', separato: false },
    },
  },
];

/** Il registro per chiave, per chi deve cercarne uno solo. */
export const PER_CHIAVE = new Map(RUOLI.map((spec) => [spec.chiave, spec]));

/** Tutti i nomi che un ruolo ha avuto in un qualsiasi stile. */
export function nomiConosciuti(spec: RuoloSpec): string[] {
  return [...new Set(Object.values(spec.vestiti).map((vestito) => vestito.nome))];
}

/**
 * Ritrova un ruolo, comunque si chiami adesso.
 *
 * Tre tentativi, in ordine di affidabilità: l'identificativo scritto nella
 * configurazione, il nome in uno qualsiasi degli stili, il nome
 * *normalizzato* — che copre chi ha rinominato a mano cambiando solo
 * maiuscole o spazi.
 *
 * È il pezzo che rende possibile riparare i server già costruiti: un
 * `☾ Ali Guardiane` creato dalla vecchia versione viene riconosciuto come il
 * ruolo `staff`, invece di essere un estraneo accanto a un `ANGEL · Staff`
 * vuoto.
 */
export function trovaRuolo(guild: Guild, spec: RuoloSpec, config: GuildConfig): Role | null {
  for (const percorso of spec.percorsi) {
    const valore = leggiPercorso(config, percorso);
    const id = Array.isArray(valore) ? valore.find((v) => typeof v === 'string') : valore;
    if (typeof id === 'string') {
      const trovato = guild.roles.cache.get(id);
      if (trovato) return trovato;
    }
  }

  const nomi = nomiConosciuti(spec);
  const esatto = guild.roles.cache.find((role) => nomi.includes(role.name));
  if (esatto) return esatto;

  const normalizzati = nomi.map(appiattisci);
  return guild.roles.cache.find((role) => normalizzati.includes(appiattisci(role.name))) ?? null;
}

/** Tutti i ruoli del server che corrispondono a una chiave: serve a trovare i doppioni. */
export function trovaTutti(guild: Guild, spec: RuoloSpec): Role[] {
  const normalizzati = nomiConosciuti(spec).map(appiattisci);
  return [...guild.roles.cache.values()].filter((role) =>
    normalizzati.includes(appiattisci(role.name)),
  );
}

/**
 * Riduce un nome alla sua forma confrontabile.
 *
 * Via i caratteri decorativi, gli spazi ripetuti e le maiuscole: `☾ Ali
 * Guardiane` e `ali guardiane` devono risultare la stessa cosa, perché chi ha
 * tolto il simbolo a mano non ha creato un ruolo diverso.
 */
export function appiattisci(nome: string): string {
  return nome
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Si tiene solo lettere, numeri e spazi: tutto il resto è decorazione.
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Applicazione di uno stile ────────────────────────────────────────── */

export interface EsitoStile {
  stile: StileRuoli;
  rinominati: { da: string; a: string }[];
  permessiDati: { ruolo: string; quanti: number }[];
  creati: string[];
  saltati: { ruolo: string; motivo: string }[];
}

export interface OpzioniStile {
  /** Crea i ruoli che mancano, invece di limitarsi a rivestire quelli che ci sono. */
  crea?: boolean;
  /** Assegna anche i permessi. Senza, cambia solo l'aspetto. */
  permessi?: boolean;
  /** Solo i ruoli di base, o anche quelli del modello. */
  soloBase?: boolean;
  attore?: string;
}

/**
 * Riveste i ruoli: nome, colore, posizione nella lista, permessi.
 *
 * Non ne ricrea nessuno di quelli che esistono. È tutto il punto: lo stesso
 * identificativo attraversa il cambio, quindi la configurazione resta valida,
 * i permessi sui canali continuano a puntare al ruolo giusto, e chi lo aveva
 * non perde niente.
 */
export async function applicaStile(
  guild: Guild,
  config: GuildConfig,
  stile: StileRuoli,
  opzioni: OpzioniStile = {},
): Promise<EsitoStile> {
  const esito: EsitoStile = {
    stile,
    rinominati: [],
    permessiDati: [],
    creati: [],
    saltati: [],
  };

  const io = await guild.members.fetchMe().catch(() => null);
  if (!io?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    esito.saltati.push({ ruolo: 'tutti', motivo: 'manca il permesso «Gestire i ruoli»' });
    return esito;
  }

  for (const spec of RUOLI) {
    if (opzioni.soloBase && !spec.base) continue;

    const vestito = spec.vestiti[stile];
    let ruolo = trovaRuolo(guild, spec, config);

    if (!ruolo) {
      if (!opzioni.crea) continue;

      const creato = await guild.roles
        .create({
          name: vestito.nome,
          color: vestito.colore,
          hoist: vestito.separato,
          mentionable: false,
          // Alla creazione mai permessi, nemmeno con lo stile: un ruolo appena
          // nato non ha ancora nessuno dentro, e darglieli qui significa
          // crearlo già pericoloso. Li riceve al passaggio successivo, dopo
          // che chi guarda ha visto comparire il nome.
          permissions: [],
          reason: `Stile ${stile}${opzioni.attore ? `, richiesto da ${opzioni.attore}` : ''}`,
        })
        .catch((errore: unknown) => {
          log.warn({ err: errore, ruolo: vestito.nome }, 'ruolo non creato');
          esito.saltati.push({ ruolo: vestito.nome, motivo: 'creazione rifiutata da Discord' });
          return null;
        });

      if (!creato) continue;
      esito.creati.push(vestito.nome);
      ruolo = creato;
    }

    /*
     * Un ruolo più alto del bot non si può toccare.
     *
     * Succede spesso su server già avviati, dove lo staff sta in cima: la
     * chiamata fallirebbe con un errore generico di permessi, e il vero
     * motivo — «il mio ruolo sta sotto» — non comparirebbe da nessuna parte.
     */
    if (ruolo.position >= (io.roles.highest.position ?? 0)) {
      esito.saltati.push({
        ruolo: ruolo.name,
        motivo: 'sta più in alto del ruolo del bot: spostami sopra di lui',
      });
      continue;
    }

    const modifiche: Parameters<Role['edit']>[0] = {};
    const rinomina = ruolo.name !== vestito.nome;

    if (rinomina) modifiche.name = vestito.nome;
    if (ruolo.hexColor.toLowerCase() !== vestito.colore.toLowerCase()) {
      modifiche.color = vestito.colore;
    }
    if (ruolo.hoist !== vestito.separato) modifiche.hoist = vestito.separato;

    /*
     * I permessi si sommano, non si sostituiscono.
     *
     * Chi ha aggiunto qualcosa a mano lo tiene: il bot aggiunge quello che
     * secondo lui serve e non toglie mai niente. Una riesecuzione non riporta
     * quindi indietro un ruolo che qualcuno aveva ridotto di proposito — e
     * ridurlo resta una cosa che si fa da Discord, non discutendo con il bot.
     */
    if (opzioni.permessi && !spec.isolante) {
      const voluti = PERMESSI[spec.permessi];
      const mancanti = voluti.filter((permesso) => !ruolo!.permissions.has(permesso));
      if (mancanti.length > 0) {
        modifiche.permissions = ruolo.permissions.add(mancanti);
        esito.permessiDati.push({ ruolo: vestito.nome, quanti: mancanti.length });
      }
    }

    if (Object.keys(modifiche).length === 0) continue;

    const primaSiChiamava = ruolo.name;
    const cambiato = await ruolo
      .edit({ ...modifiche, reason: `Stile ${stile}` })
      .then(() => true)
      .catch((errore: unknown) => {
        log.warn({ err: errore, ruolo: ruolo!.name }, 'ruolo non modificato');
        esito.saltati.push({ ruolo: ruolo!.name, motivo: 'modifica rifiutata da Discord' });
        return false;
      });

    if (cambiato && rinomina) esito.rinominati.push({ da: primaSiChiamava, a: vestito.nome });
  }

  return esito;
}

/* ── Lettura dei percorsi ─────────────────────────────────────────────── */

function leggiPercorso(oggetto: unknown, percorso: string): unknown {
  return percorso.split('.').reduce<unknown>((valore, chiave) => {
    if (valore && typeof valore === 'object' && chiave in valore) {
      return (valore as Record<string, unknown>)[chiave];
    }
    return undefined;
  }, oggetto);
}

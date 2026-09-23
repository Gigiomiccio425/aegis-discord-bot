import { NAVIGAZIONE } from './navigazione.js';
import { posizioneSezione, raggruppaSezioni, type Sezione } from './sezioni.js';

/* ═══════════════════════════════════════════════════════════════════════
   LA RICERCA DEL PANNELLO

   Le impostazioni sono qualche centinaio, divise in ventisette sezioni.
   Chi cerca «la soglia degli ingressi» non sa che sta dentro Anti-Raid, e
   non dovrebbe doverlo sapere: scrive quello che ha in mente e arriva al
   campo, con la sezione aperta e il campo illuminato.

   Qui c'è solo la parte che non dipende da React — cosa si cerca e come si
   ordina — così si prova senza un browser. Le descrizioni dei campi entrano
   da fuori: sono le stesse che la pagina della configurazione mostra sotto
   ogni controllo, e cercare con parole diverse da quelle che poi si leggono
   sarebbe il modo più sicuro di non trovare niente.
   ═══════════════════════════════════════════════════════════════════════ */

export type TipoVoce = 'pagina' | 'sezione' | 'impostazione';

export interface VoceRicerca {
  /** Unico nell'indice: serve da chiave e da id nell'elenco dei risultati. */
  id: string;
  tipo: TipoVoce;
  titolo: string;
  descrizione?: string;
  /** Dove si trova: «Configurazione › Sicurezza › Attacchi». */
  dove: string;
  /** Il percorso dopo `/g/<server>/`, con i parametri. */
  destinazione: string;
  /** Altre parole con cui la si cercherebbe. */
  parole?: string[];
  /** Per le impostazioni: il campo nella configurazione, per mostrarne il valore. */
  percorso?: string;
}

/** Le spiegazioni, prese dalla stessa fonte che usa la pagina. */
export interface Descrittori {
  campo: (percorso: string) => { label: string; help: string } | null;
  sezione: (chiave: string) => { summary: string } | undefined;
}

/**
 * Il testo come lo confronta la ricerca: minuscolo, senza accenti, senza
 * punteggiatura. «perché» e «perche», «Anti-Raid» e «anti raid» devono
 * trovarsi a vicenda: nessuno scrive gli accenti in una casella di ricerca.
 */
export function normalizza(testo: string): string {
  return testo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Le pagine del pannello. */
export function vociPagine(): VoceRicerca[] {
  return NAVIGAZIONE.flatMap((gruppo) =>
    gruppo.voci.map((voce) => ({
      id: `pagina:${voce.to}`,
      tipo: 'pagina' as const,
      titolo: voce.label,
      descrizione: voce.descrizione,
      dove: gruppo.titolo,
      destinazione: voce.to,
      parole: voce.parole,
    })),
  );
}

type Json = Record<string, unknown>;

function oggettoSemplice(valore: unknown): valore is Json {
  return typeof valore === 'object' && valore !== null && !Array.isArray(valore);
}

/** `joinBurst` → «Join burst»: lo stesso ripiego della pagina. */
function umanizza(chiave: string): string {
  const spaziato = chiave.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaziato.charAt(0).toUpperCase() + spaziato.slice(1);
}

/** Il valore a un percorso con i punti: `security.antiRaid.enabled`. */
export function leggi(sorgente: Json, percorso: string): unknown {
  return percorso.split('.').reduce<unknown>((valore, chiave) => {
    return oggettoSemplice(valore) ? valore[chiave] : undefined;
  }, sorgente);
}

/** Il link che apre la configurazione su una sezione, e magari su un campo. */
export function destinazioneConfigurazione(sezione: string, campo?: string): string {
  const parametri = new URLSearchParams({ sezione });
  if (campo) parametri.set('campo', campo);
  return `impostazioni?${parametri.toString()}`;
}

/**
 * Le sezioni della configurazione e ogni campo al loro interno.
 *
 * I campi si leggono dalla configurazione vera del server e non da un elenco
 * scritto a mano: così la ricerca trova esattamente quello che la pagina
 * mostra, anche l'opzione aggiunta ieri. Gli elenchi si fermano all'elenco
 * stesso — «Streamer seguiti» sì, «Streamer seguiti › 3 › login» no: il terzo
 * elemento di oggi è un altro domani.
 */
export function vociConfigurazione(
  config: Json,
  sezioni: readonly Sezione[],
  descrittori: Descrittori,
): VoceRicerca[] {
  const gruppi = raggruppaSezioni(sezioni);
  const voci: VoceRicerca[] = [];

  for (const sezione of sezioni) {
    const posizione = posizioneSezione(sezione.key, gruppi);
    const doveSezione = ['Configurazione', posizione].filter(Boolean).join(' › ');

    voci.push({
      id: `sezione:${sezione.key}`,
      tipo: 'sezione',
      titolo: sezione.label,
      descrizione: descrittori.sezione(sezione.key)?.summary,
      dove: doveSezione,
      destinazione: destinazioneConfigurazione(sezione.key),
    });

    const contenuto = leggi(config, sezione.key);
    if (!oggettoSemplice(contenuto)) continue;

    const percorri = (oggetto: Json, percorso: string, antenati: string[]): void => {
      for (const [chiave, valore] of Object.entries(oggetto)) {
        const pieno = `${percorso}.${chiave}`;
        const descrizione = descrittori.campo(pieno);
        const titolo = descrizione?.label ?? umanizza(chiave);

        voci.push({
          id: `campo:${pieno}`,
          tipo: 'impostazione',
          titolo,
          descrizione: descrizione?.help,
          dove: ['Configurazione', sezione.label, ...antenati].join(' › '),
          destinazione: destinazioneConfigurazione(sezione.key, pieno),
          percorso: pieno,
        });

        if (oggettoSemplice(valore)) percorri(valore, pieno, [...antenati, titolo]);
      }
    };
    percorri(contenuto, sezione.key, []);
  }

  return voci;
}

/* ── Il confronto ─────────────────────────────────────────────────────── */

interface VoceIndicizzata {
  voce: VoceRicerca;
  posizione: number;
  titolo: string;
  paroleTitolo: string[];
  parole: string[];
  dove: string[];
  descrizione: string;
  paroleDescrizione: string[];
}

export interface Indice {
  voci: VoceIndicizzata[];
}

/** Il testo normalizzato una volta sola, non a ogni tasto premuto. */
export function preparaIndice(voci: readonly VoceRicerca[]): Indice {
  return {
    voci: voci.map((voce, posizione) => {
      const titolo = normalizza(voce.titolo);
      const descrizione = normalizza(voce.descrizione ?? '');
      return {
        voce,
        posizione,
        titolo,
        paroleTitolo: titolo.split(' ').filter(Boolean),
        parole: (voce.parole ?? []).flatMap((parola) => normalizza(parola).split(' ')).filter(Boolean),
        dove: normalizza(voce.dove).split(' ').filter(Boolean),
        descrizione,
        paroleDescrizione: descrizione.split(' ').filter(Boolean),
      };
    }),
  };
}

/**
 * Quanto una parola cercata corrisponde a una voce. Zero: non corrisponde.
 *
 * Il titolo pesa più di tutto, poi le parole chiave, poi il posto, poi la
 * spiegazione: chi scrive «soglia» vuole prima i campi che si chiamano
 * soglia, e solo dopo quelli che ne parlano.
 */
function punteggioParola(indicizzata: VoceIndicizzata, parola: string): number {
  const inizia = (parole: string[]) => parole.some((candidata) => candidata.startsWith(parola));

  if (indicizzata.paroleTitolo[0]?.startsWith(parola)) return 70;
  if (inizia(indicizzata.paroleTitolo)) return 60;
  // Dentro una parola solo da tre lettere in su: «ra» dentro «ingressi
  // straordinari» non è quello che nessuno cercava.
  if (parola.length >= 3 && indicizzata.titolo.includes(parola)) return 35;
  if (inizia(indicizzata.parole)) return 30;
  if (inizia(indicizzata.dove)) return 15;
  if (inizia(indicizzata.paroleDescrizione)) return 10;
  if (parola.length >= 4 && indicizzata.descrizione.includes(parola)) return 5;
  return 0;
}

const PESO_TIPO: Record<TipoVoce, number> = { pagina: 8, sezione: 5, impostazione: 0 };

export interface Risultato {
  voce: VoceRicerca;
  punteggio: number;
  /** La voce contiene solo una parte delle parole cercate. */
  parziale: boolean;
}

/**
 * Le voci che corrispondono, le migliori prima.
 *
 * Prima si cercano le voci che contengono ogni parola scritta: «soglia
 * ingressi» non deve restituire ogni campo che contenga solo «soglia». Ma
 * chi cerca scrive con parole sue, e non sempre una voce le ha tutte: in quel
 * caso, invece del vuoto, arrivano le voci che ne hanno almeno metà, segnate
 * come parziali perché la casella possa dirlo.
 */
export function cerca(indice: Indice, domanda: string, limite = 40): Risultato[] {
  const intera = normalizza(domanda);
  if (!intera) return [];
  const parole = intera.split(' ');

  const trovati: { voce: VoceRicerca; punteggio: number; trovate: number; posizione: number }[] = [];
  for (const indicizzata of indice.voci) {
    let punteggio = 0;
    let trovate = 0;
    for (const parola of parole) {
      const parziale = punteggioParola(indicizzata, parola);
      if (parziale > 0) trovate += 1;
      punteggio += parziale;
    }
    if (trovate === 0) continue;

    if (indicizzata.titolo === intera) punteggio += 200;
    else if (indicizzata.titolo.startsWith(intera)) punteggio += 50;
    else if (parole.length > 1 && indicizzata.titolo.includes(intera)) punteggio += 30;
    punteggio += PESO_TIPO[indicizzata.voce.tipo];

    trovati.push({ voce: indicizzata.voce, punteggio, trovate, posizione: indicizzata.posizione });
  }

  const complete = trovati.filter((trovato) => trovato.trovate === parole.length);
  const parziale = complete.length === 0;
  const minimo = Math.max(1, Math.ceil(parole.length / 2));
  const scelti = parziale ? trovati.filter((trovato) => trovato.trovate >= minimo) : complete;

  return scelti
    .sort(
      (a, b) =>
        b.trovate - a.trovate ||
        b.punteggio - a.punteggio ||
        a.voce.titolo.length - b.voce.titolo.length ||
        a.posizione - b.posizione,
    )
    .slice(0, limite)
    .map(({ voce, punteggio }) => ({ voce, punteggio, parziale }));
}

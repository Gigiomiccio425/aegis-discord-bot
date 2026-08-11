/* ═══════════════════════════════════════════════════════════════════════
   FILTRO DEL LINGUAGGIO

   Riconosce parolacce e insulti, compresi i tentativi di aggirare l'elenco.

   Il problema non è avere una lista di parole: è che nessuno scrive la parola
   in chiaro quando sa che c'è un filtro. Scrive `c4zz0`, `c a z z o`,
   `cazzooooo`, `c-a-z-z-o`, o mette un carattere cirillico al posto di una
   latina. Un confronto letterale non trova nessuna di queste, e il filtro
   diventa un ostacolo per chi non stava provando ad aggirarlo.

   Quindi si normalizza prima di confrontare: si tolgono accenti, si
   riconducono i numeri alle lettere che imitano, si comprimono le ripetizioni,
   si eliminano i separatori inseriti in mezzo.

   ── Il problema opposto, che è peggiore ──────────────────────────────────

   Normalizzando e cercando sottostringhe si finisce per bloccare parole
   legittime che ne contengono un'altra. È un errore con un nome, «Scunthorpe»,
   dal comune inglese che per anni non poté registrarsi online. In italiano
   capita con «cazzuola» (un attrezzo da muratore), «merletto», «arsenale»,
   «Cagliari».

   Un filtro che blocca chi parla di edilizia insegna in un pomeriggio che il
   bot va ignorato, e a quel punto non serve più a niente. Per questo:

     • le voci si confrontano **per parola intera** salvo indicazione contraria;
     • esiste un elenco di eccezioni verificate, che vince sempre;
     • ogni voce dichiara la propria gravità, perché «cazzo» detto per stizza e
       un insulto rivolto a una persona non sono la stessa cosa.
   ═══════════════════════════════════════════════════════════════════════ */

import { normalize } from '@angel/shared';

/** Gravità di una voce dell'elenco. */
export type LanguageSeverity = 'LIEVE' | 'MEDIA' | 'GRAVE';

/*
 * Categorie.
 *
 * La distinzione serve perché i server non sono tutti uguali e non lo sono
 * nemmeno le offese. Su un server di gioco la volgarità fa parte del tono e
 * vietarla significa moderare una comunità che non esiste; l'attacco
 * all'identità di qualcuno invece non è tono, è la ragione per cui le persone
 * se ne vanno e non tornano.
 *
 * Un elenco unico costringe a scegliere fra tollerare tutto e vietare tutto.
 * Con le categorie si spegne ciò che nel proprio server non è un problema e
 * si tiene il resto — che è l'unico modo perché il filtro resti acceso.
 *
 * La ripartizione riprende la struttura di HurtLex (Università di Torino,
 * 17 categorie a partire dal lessico di De Mauro) e le attribuzioni di
 * Perspective API, semplificate a ciò che uno staff sa decidere guardando
 * una spunta.
 */
export type LanguageCategory =
  /** Imprecazioni e volgarità non rivolte a nessuno. */
  | 'VOLGARITA'
  /** Insulti rivolti a una persona: il nucleo del flame. */
  | 'INSULTO'
  /** Attacchi all'identità: origine, orientamento, disabilità, genere, religione. */
  | 'DISCRIMINAZIONE'
  /** Minacce e incitazioni alla violenza. */
  | 'MINACCIA'
  /** Incitazioni all'autolesionismo. Categoria a sé: la risposta non è punire. */
  | 'AUTOLESIONISMO'
  /** Bestemmie. In molti server italiani è la sola regola davvero non negoziabile. */
  | 'BESTEMMIA'
  /** Contenuto sessuale esplicito. */
  | 'SESSUALE';

export interface LanguageTerm {
  /** La parola o l'espressione, in minuscolo e senza accenti. */
  term: string;
  severity: LanguageSeverity;
  category: LanguageCategory;
  /**
   * Cerca anche dentro altre parole.
   *
   * Da usare con parsimonia e solo dove la sequenza non compare in nessuna
   * parola legittima: è precisamente l'opzione che produce i falsi positivi.
   */
  substring?: boolean;
}

export interface LanguageConfig {
  terms: LanguageTerm[];
  /** Categorie attive. Le voci delle categorie spente non vengono cercate. */
  categories: Record<LanguageCategory, boolean>;
  /** Parole legittime che contengono una voce dell'elenco. Vincono sempre. */
  allowlist: string[];
  /** Punti per gravità, sommati fino al punteggio finale. */
  weights: { LIEVE: number; MEDIA: number; GRAVE: number };
  /** Punti aggiuntivi se il messaggio menziona qualcuno o risponde a qualcuno. */
  targetedBonus: number;
}

export interface LanguageMatch {
  term: string;
  severity: LanguageSeverity;
  category: LanguageCategory;
  /** Come compariva nel testo, prima della normalizzazione. */
  found: string;
}

export interface LanguageResult {
  matches: LanguageMatch[];
  /** Categorie effettivamente incontrate: serve a scegliere come rispondere. */
  categories: LanguageCategory[];
  score: number;
  /** Il messaggio era rivolto a qualcuno in particolare. */
  targeted: boolean;
}

/*
 * Sostituzioni tipiche della scrittura elusiva.
 *
 * Solo quelle che imitano una lettera per forma: `0`→`o`, `4`→`a`. Non si
 * spinge oltre — `9`→`g` esiste ma è raro, e ogni sostituzione in più aumenta
 * la probabilità di trasformare una parola innocua in una segnalata.
 */
const OMOFONI: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '€': 'e',
};

/**
 * Riduce il testo alla forma su cui si confronta.
 *
 * L'ordine conta: prima si tolgono gli accenti, poi si sostituiscono i
 * caratteri che imitano lettere, poi si comprimono le ripetizioni. Invertendo
 * gli ultimi due, `c4444zzo` resterebbe con quattro `a`.
 */
export function normalizeForLanguage(input: string): string {
  // `normalize` di @angel/shared toglie già diacritici, caratteri invisibili e
  // omoglifi cirillici o greci: sono le tre evasioni che qui servivano e che
  // riscrivere daccapo avrebbe significato mantenerle in due posti, con la
  // certezza che uno dei due sarebbe rimasto indietro.
  const base = normalize(input);

  const conLettere = [...base].map((carattere) => OMOFONI[carattere] ?? carattere).join('');

  return (
    conLettere
      // Tutto ciò che non è lettera o cifra diventa uno spazio: copre i
      // separatori inseriti apposta (`c-a-z-z-o`, `c.a.z.z.o`) e la
      // punteggiatura normale, che qui non serve a nulla.
      .replace(/[^a-z0-9]+/g, ' ')
      // Tre o più lettere uguali di fila diventano due: `cazzooooo` e
      // `caaaazzo` collassano, ma `bello` resta `bello`.
      .replace(/(.)\1{2,}/g, '$1$1')
      .trim()
  );
}

/**
 * Variante senza spazi, per riconoscere `c a z z o`.
 *
 * Si cerca anche qui, ma **solo per parola intera** non è possibile: gli spazi
 * sono spariti. Per questo la ricerca compattata si applica alle sole voci
 * abbastanza lunghe da non comparire per caso dentro un'altra parola.
 */
function compatta(testo: string): string {
  return testo.replace(/\s+/g, '');
}

/** Lunghezza sotto la quale non si cerca nella forma compattata. */
const MIN_COMPATTA = 5;

export function scanLanguage(
  text: string,
  config: LanguageConfig,
  options: { targeted?: boolean } = {},
): LanguageResult {
  const normalizzato = normalizeForLanguage(text);
  if (!normalizzato) return { matches: [], categories: [], score: 0, targeted: false };

  const parole = normalizzato.split(' ');

  // Le eccezioni si valutano sul testo normalizzato: chi scrive «cazzuola»
  // deve passare anche se lo scrive «c4zzuola».
  const eccezioni = config.allowlist.map((voce) => normalizeForLanguage(voce)).filter(Boolean);
  const paroleAmmesse = new Set(parole.filter((parola) => eccezioni.includes(parola)));

  /*
   * Testo compattato, con le parole ammesse tolte di mezzo.
   *
   * Toglierle è indispensabile e non è un dettaglio: «scazzottata» contiene
   * la sequenza «cazzo», e senza rimozione basterebbe una parola legittima
   * nel messaggio per far scattare il filtro. Il primo tentativo disattivava
   * del tutto la ricerca compattata quando un'eccezione conteneva il termine,
   * il che spegneva il riconoscimento delle lettere spaziate per tutti i
   * messaggi — la difesa annullata da un caso che non era nemmeno presente.
   */
  let compattato = compatta(normalizzato);
  for (const eccezione of eccezioni) {
    const compatta_ = compatta(eccezione);
    if (compatta_) compattato = compattato.split(compatta_).join(' ');
  }

  const matches: LanguageMatch[] = [];
  const gia = new Set<string>();

  for (const voce of config.terms) {
    if (config.categories[voce.category] === false) continue;
    const termine = normalizeForLanguage(voce.term);
    if (!termine || gia.has(termine)) continue;

    let trovato: string | null = null;

    if (termine.includes(' ')) {
      // Espressione di più parole: si cerca nella frase normalizzata.
      if (normalizzato.includes(termine)) trovato = termine;
    } else if (voce.substring) {
      if (normalizzato.includes(termine)) trovato = termine;
    } else {
      const parolaEsatta = parole.find(
        (parola) => parola === termine && !paroleAmmesse.has(parola),
      );
      if (parolaEsatta) trovato = parolaEsatta;
    }

    // Ultima possibilità: la forma compattata, per chi ha spaziato le lettere.
    // Le parole ammesse sono già state tolte sopra, quindi qui non possono
    // più produrre una corrispondenza. Solo per voci abbastanza lunghe da non
    // comparire per caso dentro un'altra parola.
    if (!trovato && !voce.substring && termine.length >= MIN_COMPATTA) {
      if (compattato.includes(termine)) trovato = termine;
    }

    if (!trovato) continue;
    gia.add(termine);
    matches.push({
      term: voce.term,
      severity: voce.severity,
      category: voce.category,
      found: trovato,
    });
  }

  if (matches.length === 0) return { matches: [], categories: [], score: 0, targeted: false };

  const targeted = options.targeted ?? false;
  const base = matches.reduce((somma, match) => somma + config.weights[match.severity], 0);

  return {
    matches,
    categories: [...new Set(matches.map((match) => match.category))],
    // Rivolgere l'insulto a qualcuno è ciò che lo trasforma da sfogo in
    // aggressione: pesa di più, ma solo se qualcosa è stato trovato.
    score: Math.min(100, base + (targeted ? config.targetedBonus : 0)),
    targeted,
  };
}

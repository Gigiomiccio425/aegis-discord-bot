/* ═══════════════════════════════════════════════════════════════════════
   LA COPIA LEGGERA, DENTRO DISCORD

   La copia di sicurezza vera sta su disco: database intero, allegati,
   trascrizioni. Serve, ed è quella che va custodita. Ma ha un punto debole
   che non dipende da com'è scritta: **sta sulla stessa macchina**. Se quella
   macchina si rompe, o l'app viene disinstallata, sparisce insieme a ciò che
   proteggeva. È già successo qui.

   Questa copia è un'altra cosa, e le due non si sostituiscono a vicenda: un
   file di testo pubblicato in un canale Discord. Discord non è la nostra
   macchina, e questo è tutto il punto. Il giorno in cui il server non c'è
   più, quel file è ancora lì, e da lì si riparte.

   ── Cosa ci sta dentro, e cosa no ──────────────────────────────────────

   Ci sta quello che costa ore rifare a mano: la configurazione, i ruoli, i
   canali, i comandi personalizzati, le parole vietate, chi è sorvegliato.

   Non ci stanno i messaggi (sono gigabyte), non gli allegati, e soprattutto
   **nessun segreto**. Non è una raccomandazione: c'è un controllo che
   rifiuta di comporre il documento se ci trova dentro qualcosa che somiglia
   a un token. Un backup che pubblica le credenziali in una chat è peggio di
   nessun backup.

   ── Perché Markdown con dentro un blocco JSON ──────────────────────────

   Due lettori diversi, due bisogni opposti.

   Una persona che ritrova questo file fra un anno deve capirlo aprendolo,
   senza strumenti: per lei c'è il testo, con le tabelle e i conteggi.

   Il ripristino invece non deve *interpretare* niente: leggere il Markdown
   con un'espressione regolare significa che una riga scritta in modo un po'
   diverso cambia la configurazione di un server in modo silenzioso. Per lui
   c'è un solo blocco JSON, ed è quello l'originale. Il testo intorno è una
   spiegazione, e se i due non combaciassero vince il blocco.

   ── Quello che questo formato NON fa ───────────────────────────────────

   L'impronta in fondo serve a riconoscere un file troncato a metà o
   modificato per sbaglio. **Non** rende sicuro ripristinare un file
   qualsiasi: chiunque sappia il formato può ricalcolarla. La protezione vera
   sta altrove — si accettano solo i file che ha pubblicato il bot stesso —
   e va tenuta lì, perché qui non può stare.
   ═══════════════════════════════════════════════════════════════════════ */

/** Versione del formato. Cambia solo se il blocco JSON cambia forma. */
export const FORMATO_LEGGERO = 1;

/** Dove comincia e dove finisce il blocco che conta. */
const APERTURA = '```json';
const CHIUSURA = '```';

export interface RuoloLeggero {
  id: string;
  nome: string;
  colore: number;
  posizione: number;
  /** I permessi come stringa di bit, la forma che usa Discord. */
  permessi: string;
}

export interface CanaleLeggero {
  id: string;
  nome: string;
  tipo: number;
  categoria: string | null;
}

export interface ComandoLeggero {
  nome: string;
  risposta: string;
  persona?: string;
}

export interface DocumentoLeggero {
  formato: number;
  /** Versione di ANGEL che l'ha scritto: serve a chi lo rilegge fra due anni. */
  angel: string;
  guildId: string;
  guildNome: string;
  /** ISO 8601, in UTC. */
  creatoIl: string;
  configurazione: unknown;
  ruoli: RuoloLeggero[];
  canali: CanaleLeggero[];
  comandi: ComandoLeggero[];
  paroleVietate: string[];
  dominiAmmessi: string[];
  sorvegliati: string[];
}

/*
 * I nomi che non devono comparire, e il perché di ognuno.
 *
 * Non è un elenco di parole "sospette": è l'elenco esatto delle cose che
 * darebbero a chi legge il canale il controllo del bot, del database o degli
 * account collegati. Se una di queste finisce nel documento, non si pubblica
 * — meglio nessuna copia che una copia che regala le chiavi.
 */
const CHIAVI_VIETATE = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'REDIS_URL',
  'TWITCH_CLIENT_SECRET',
  'TWITCH_BOT_ACCESS_TOKEN',
  'TWITCH_BOT_REFRESH_TOKEN',
  'GOOGLE_SAFE_BROWSING_KEY',
  'ABUSECH_AUTH_KEY',
] as const;

/**
 * Un token del bot Discord ha una forma riconoscibile: tre parti separate da
 * punti. Cercarla serve a fermare il caso in cui un token finisce nel
 * documento **senza** il nome della variabile accanto — per esempio dentro la
 * risposta di un comando personalizzato, scritta da qualcuno che non ci ha
 * pensato.
 */
const FORMA_TOKEN = /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/;

/**
 * Quello che non deve uscire di qui. Elenco vuoto significa che si può
 * pubblicare.
 */
export function segretiTrovati(testo: string): string[] {
  const trovati: string[] = CHIAVI_VIETATE.filter((chiave) => testo.includes(chiave));
  if (FORMA_TOKEN.test(testo)) trovati.push('qualcosa con la forma di un token');
  return trovati;
}

/**
 * Impronta del contenuto, per riconoscere un file troncato o ritoccato.
 *
 * Non è una firma e non pretende di esserlo: chi conosce il formato la
 * ricalcola. Serve al caso frequente e noioso — un file scaricato a metà, un
 * copia-e-incolla che ha perso l'ultima riga — non a quello ostile.
 */
export function impronta(testo: string): string {
  // FNV-1a a 32 bit: poche righe, nessuna dipendenza, e per riconoscere un
  // troncamento è più che sufficiente.
  let h = 0x811c9dc5;
  for (let i = 0; i < testo.length; i += 1) {
    h ^= testo.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const numero = (valore: number): string => valore.toLocaleString('it-IT');

/**
 * Compone il documento. Lancia se ci trova dentro un segreto.
 *
 * Lancia invece di ripulire: ripulire in silenzio significherebbe pubblicare
 * un documento che sembra completo e non lo è, e nessuno saprebbe cosa manca.
 */
export function componiDocumento(documento: DocumentoLeggero): string {
  const corpo = JSON.stringify(documento, null, 2);

  const segreti = segretiTrovati(corpo);
  if (segreti.length > 0) {
    throw new Error(
      `copia leggera non composta: ci sono finiti dentro ${segreti.join(', ')}. ` +
        'Pubblicarla in una chat significherebbe regalarli a chi la legge.',
    );
  }

  const data = documento.creatoIl.slice(0, 10);
  const righe = [
    `# ANGEL — copia leggera di ${documento.guildNome}`,
    '',
    `**${data}** · ANGEL ${documento.angel} · formato ${documento.formato}`,
    '',
    'Questo file è una copia **leggera**: contiene quello che costerebbe ore',
    'rifare a mano, non i messaggi né gli allegati. La copia completa sta su',
    'disco, sulla macchina che esegue ANGEL — e proprio per questo esiste',
    "anche questa: se quella macchina non c'è più, questa è ancora qui.",
    '',
    "## Cosa c'è dentro",
    '',
    '| | |',
    '|---|---|',
    `| Ruoli | ${numero(documento.ruoli.length)} |`,
    `| Canali | ${numero(documento.canali.length)} |`,
    `| Comandi personalizzati | ${numero(documento.comandi.length)} |`,
    `| Parole vietate | ${numero(documento.paroleVietate.length)} |`,
    `| Domini ammessi | ${numero(documento.dominiAmmessi.length)} |`,
    `| Utenti sorvegliati | ${numero(documento.sorvegliati.length)} |`,
    '',
    '## Come si rimette',
    '',
    'Dal pannello, oppure con il comando di ripristino della copia leggera,',
    'allegando questo file. ANGEL accetta solo i file che ha pubblicato lui:',
    'un documento arrivato da qualcun altro viene rifiutato, perché rimettere',
    'una configurazione è come cambiarla — e cambiarla significa poter',
    'spegnere le difese.',
    '',
    'Il ripristino **non** ricrea ruoli e canali cancellati: quelli stanno qui',
    'per riconoscerli e rifarli, e perché i loro identificativi servono a',
    'capire cosa puntava a cosa. Quello che rimette davvero è la',
    'configurazione, i comandi, le parole e gli elenchi.',
    '',
    '## I dati',
    '',
    "Qui sotto c'è l'originale. Il testo qui sopra lo racconta; se i due non",
    'combaciassero, vale questo.',
    '',
    APERTURA,
    corpo,
    CHIUSURA,
    '',
    `<!-- impronta:${impronta(corpo)} -->`,
    '',
  ];

  return righe.join('\n');
}

export interface LetturaLeggera {
  documento: DocumentoLeggero | null;
  problemi: string[];
}

/**
 * Rilegge un documento. Non lancia: i problemi si elencano.
 *
 * Chi chiama deve poter dire **cosa** non andava — un file troncato, un
 * formato più nuovo, un blocco mancante sono tre cose diverse con tre
 * risposte diverse, e un'eccezione sola le appiattirebbe.
 */
export function leggiDocumento(testo: string): LetturaLeggera {
  const problemi: string[] = [];

  const inizio = testo.indexOf(APERTURA);
  if (inizio === -1) {
    return {
      documento: null,
      problemi: ['non è una copia leggera di ANGEL: manca il blocco dei dati'],
    };
  }

  const daCapo = testo.indexOf('\n', inizio);
  const fine = daCapo === -1 ? -1 : testo.indexOf(`\n${CHIUSURA}`, daCapo);
  if (daCapo === -1 || fine === -1) {
    return {
      documento: null,
      problemi: ['il blocco dei dati non è chiuso: il file sembra troncato'],
    };
  }

  const corpo = testo.slice(daCapo + 1, fine);

  const attesa = /<!-- impronta:([0-9a-f]{8}) -->/.exec(testo)?.[1];
  if (attesa && attesa !== impronta(corpo)) {
    problemi.push(
      'l’impronta non combacia: il file è stato modificato dopo essere stato ' +
        'scritto, o scaricato a metà',
    );
  }

  let grezzo: unknown;
  try {
    grezzo = JSON.parse(corpo);
  } catch {
    return { documento: null, problemi: [...problemi, 'il blocco dei dati non è JSON valido'] };
  }

  const documento = grezzo as DocumentoLeggero;
  if (typeof documento?.guildId !== 'string' || typeof documento?.formato !== 'number') {
    return { documento: null, problemi: [...problemi, 'il blocco dei dati non ha la forma attesa'] };
  }

  /*
   * Un formato più nuovo si rifiuta, non si indovina. Leggerlo comunque
   * significherebbe applicare metà di quello che c'è scritto e ignorare il
   * resto — cioè una configurazione che nessuno ha mai deciso.
   */
  if (documento.formato > FORMATO_LEGGERO) {
    return {
      documento: null,
      problemi: [
        ...problemi,
        `questo file è nel formato ${documento.formato}, questa versione di ANGEL ` +
          `arriva al ${FORMATO_LEGGERO}. Aggiorna ANGEL prima di rimetterlo.`,
      ],
    };
  }

  return { documento, problemi };
}

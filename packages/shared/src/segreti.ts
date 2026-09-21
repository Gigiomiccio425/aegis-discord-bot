/* ═══════════════════════════════════════════════════════════════════════
   I SEGRETI FUORI DAL COMPOSE

   Su umbrelOS il file `docker-compose.yml` dell'app **appartiene al
   repository**: a ogni aggiornamento viene riscritto da lì, e tutto quello
   che era stato messo a mano sparisce. Token, segreto di sessione, chiave di
   cifratura, password del database: sei righe da reinserire ogni volta,
   ricordandosi quali — e nel frattempo il bot gira senza collegarsi.

   La via d'uscita non passa da umbrelOS: passa dal supervisore. All'avvio
   legge un file di testo che sta **dentro i dati dell'app**, che nessun
   aggiornamento tocca perché non viene dal repository, e ne mette il
   contenuto nell'ambiente dei processi. Il compose può restare pieno di
   segnaposto.

   Qui c'è la parte che si può sbagliare — leggere il formato — separata da
   quella che tocca il disco, che vive in `docker/segreti.mjs`.
   ═══════════════════════════════════════════════════════════════════════ */

/** Il nome del file, dentro la cartella dei dati. */
export const FILE_SEGRETI = 'segreti.env';

/**
 * Legge un file in formato `.env`.
 *
 * Accetta quello che si scrive davvero in un file del genere: righe vuote,
 * commenti, `export` davanti, valori fra virgolette, e il segno `=` dentro
 * il valore — che in una password capita, ed è il modo più facile per
 * ritrovarsi con una password troncata senza capire perché.
 */
export function leggiSegreti(testo: string): Map<string, string> {
  const valori = new Map<string, string>();

  for (const riga of testo.split(/\r?\n/)) {
    const pulita = riga.trim();
    if (!pulita || pulita.startsWith('#')) continue;

    const senzaExport = pulita.startsWith('export ') ? pulita.slice(7).trim() : pulita;
    const uguale = senzaExport.indexOf('=');
    if (uguale <= 0) continue;

    const nome = senzaExport.slice(0, uguale).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nome)) continue;

    let valore = senzaExport.slice(uguale + 1).trim();
    const primo = valore[0];
    if ((primo === '"' || primo === "'") && valore.endsWith(primo) && valore.length > 1) {
      valore = valore.slice(1, -1);
      // Solo fra virgolette doppie si interpretano le sequenze: fra apici
      // singoli un `\n` è un `\n`, come in qualsiasi shell.
      if (primo === '"') valore = valore.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // Fuori dalle virgolette, un cancelletto preceduto da uno spazio apre
      // un commento: `PASSWORD=abc # quella vecchia`.
      const commento = valore.search(/\s#/);
      if (commento >= 0) valore = valore.slice(0, commento).trim();
    }

    valori.set(nome, valore);
  }

  return valori;
}

/**
 * Quelli che il supervisore si genera da solo.
 *
 * Sono numeri casuali: nessuno deve inventarli, nessuno deve custodirli
 * altrove, e chiederli a chi installa significherebbe solo dargli il modo di
 * sbagliarli. Si generano una volta, finiscono nel file, e restano lì.
 *
 * `ENCRYPTION_KEY` cifra i token dentro il database: generarla è sicuro
 * finché il database è nuovo. Chi riporta un database da un'altra macchina
 * deve portarsi dietro anche la sua, o quei token diventano illeggibili — ed
 * è l'unico caso in cui questo valore si scrive a mano.
 */
export const SEGRETI_GENERABILI = ['SESSION_SECRET', 'ENCRYPTION_KEY'] as const;

/**
 * Quelli che **deve** dare una persona, e senza cui il bot non parte.
 *
 * Il token lo dà Discord, l'indirizzo dipende dalla macchina: non c'è modo
 * di indovinarli. Finché mancano, il supervisore aspetta invece di far
 * ripartire in ciclo un bot che non può collegarsi.
 */
export const SEGRETI_RICHIESTI = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'PUBLIC_URL',
  'OWNER_IDS',
] as const;

/** Tutti quelli che il riepilogo all'avvio guarda. */
export const SEGRETI_ATTESI = [
  ...SEGRETI_RICHIESTI,
  ...SEGRETI_GENERABILI,
  'DATABASE_URL',
] as const;

/* ═══════════════════════════════════════════════════════════════════════
   IL FILE NASCE GIÀ SCRITTO, CON I CAMPI DA RIEMPIRE

   Prima il file non esisteva finché qualcuno non lo creava, e il bot si
   limitava a dire quali valori mancavano. Chi installava doveva aprire un
   file vuoto e ricordarsi i nomi esatti delle variabili — o tornare a
   leggerli altrove, che è il momento in cui si sbaglia una maiuscola e si
   passa mezz'ora a capire perché il token «non funziona».

   Adesso il file lo scrive ANGEL al primo avvio: i campi ci sono già, uno
   per riga, con accanto dove si prende quel valore. Restano da riempire i
   vuoti.

   I facoltativi stanno commentati. Se fossero righe vuote, un
   `TWITCH_CLIENT_ID=` senza valore sarebbe indistinguibile da uno
   dimenticato, e il bot Twitch direbbe «credenziali mancanti» a chi non le
   ha mai volute.
   ═══════════════════════════════════════════════════════════════════════ */

/** Dove si prende ogni valore. Quello che serve sapere, non cosa significa. */
const DOVE_SI_TROVA: Record<string, string> = {
  DISCORD_TOKEN:
    'Developer Portal → la tua applicazione → Bot → Reset Token.\n# Si vede una volta sola: se lo perdi, lo rigeneri.',
  DISCORD_CLIENT_ID:
    'Developer Portal → General Information → Application ID.\n# Non è segreto, ma serve.',
  DISCORD_CLIENT_SECRET:
    'Developer Portal → OAuth2 → Client Secret.\n# Serve per l’accesso al pannello web, non per il bot.',
  OWNER_IDS:
    'Il tuo ID Discord. Impostazioni → Avanzate → Modalità sviluppatore,\n# poi tasto destro sul tuo nome → Copia ID utente.\n# Più di uno: separali con la virgola, senza spazi.',
  PUBLIC_URL:
    'L’indirizzo con cui apri il pannello, porta compresa.\n# Lo stesso indirizzo, seguito da /api/auth/callback, deve stare su\n# Discord in OAuth2 → Redirects. Tutti e tre uguali: browser, qui, Discord.',
};

/**
 * I valori facoltativi, commentati.
 *
 * Senza, quelle parti restano spente e non disturbano nessuno.
 */
const FACOLTATIVI: { titolo: string; nota: string; nomi: string[] }[] = [
  {
    titolo: 'Twitch — solo se vuoi il bot di chat',
    nota:
      'Applicazione: dev.twitch.tv/console/apps\n' +
      '# Account da cui il bot parla in chat: è un account Twitch normale,\n' +
      '# diverso dall’applicazione. Senza, il bot può leggere ma non scrivere.',
    nomi: [
      'TWITCH_CLIENT_ID',
      'TWITCH_CLIENT_SECRET',
      'TWITCH_BOT_USER_ID',
      'TWITCH_BOT_LOGIN',
      'TWITCH_BOT_ACCESS_TOKEN',
      'TWITCH_BOT_REFRESH_TOKEN',
      'TWITCH_PUBLIC_URL',
    ],
  },
  {
    titolo: 'Scanner — chiavi facoltative',
    nota:
      'Senza, restano le blocklist locali: già centinaia di migliaia di\n' +
      '# domini, aggiornate ogni sei ore. Queste aggiungono un controllo.',
    nomi: ['GOOGLE_SAFE_BROWSING_KEY', 'ABUSECH_AUTH_KEY'],
  },
];

/**
 * Il file come nasce: campi presenti, valori da mettere.
 *
 * Non contiene nessun valore — solo i nomi e dove trovarli. Si scrive una
 * volta sola, al primo avvio, e da lì in poi non si tocca più: quello che
 * ANGEL genera da solo viene aggiunto in fondo.
 */
export function modelloSegreti(): string {
  const righe: string[] = [
    '# ─────────────────────────────────────────────────────────────',
    '#  I SEGRETI DI ANGEL',
    '#',
    '#  Questo file l’ha creato ANGEL al primo avvio, con i campi già',
    '#  pronti: restano da riempire i vuoti.',
    '#',
    '#  Gli aggiornamenti non lo toccano. Si compila una volta.',
    '#',
    '#  Regole del formato, quelle che si sbagliano davvero:',
    '#',
    '#  • una riga per valore, niente spazi intorno all’uguale;',
    '#  • niente virgolette, a meno che il valore contenga uno spazio;',
    '#  • un « #» apre un commento: se il tuo valore contiene uno spazio',
    '#    seguito da un cancelletto, mettilo fra apici singoli;',
    '#  • il segno = dentro il valore va bene, non serve fare niente.',
    '# ─────────────────────────────────────────────────────────────',
    '',
    '# ── Quello che devi dare tu ──────────────────────────────────',
    '#',
    '# Finché uno di questi manca, parte solo il pannello e il bot aspetta:',
    '# ricontrolla da solo e parte appena ci sono, senza riavviare niente.',
    '',
  ];

  for (const nome of SEGRETI_RICHIESTI) {
    const dove = DOVE_SI_TROVA[nome];
    if (dove) righe.push(`# ${dove}`);
    righe.push(`${nome}=`, '');
  }

  righe.push(
    '# ─────────────────────────────────────────────────────────────',
    '#  QUI SOTTO: SOLO SE TI SERVE',
    '#',
    '#  Tutto quello che segue è facoltativo. Senza, ANGEL parte lo stesso.',
    '#  Togli il cancelletto alla riga che vuoi usare.',
    '# ─────────────────────────────────────────────────────────────',
    '',
  );

  for (const gruppo of FACOLTATIVI) {
    righe.push(`# ── ${gruppo.titolo} ──`, `# ${gruppo.nota}`, '');
    for (const nome of gruppo.nomi) righe.push(`# ${nome}=`);
    righe.push('');
  }

  righe.push(
    '# ── Quelli che NON devi scrivere ─────────────────────────────',
    '#',
    '# SESSION_SECRET, ENCRYPTION_KEY e la password del database ANGEL se li',
    '# genera al primo avvio e se li salva qui sotto da solo. Sono numeri',
    '# casuali: scriverli a mano è solo un modo per sbagliarli.',
    '#',
    '# Un’eccezione: se porti qui un database da un’altra installazione,',
    '# scrivi la sua ENCRYPTION_KEY e il suo DATABASE_URL, o i token cifrati',
    '# dentro quel database non si decifrano più.',
    '',
  );

  return righe.join('\n');
}

/** Un valore c'è davvero, o è vuoto, o è un segnaposto lasciato dal compose? */
export function valoreMancante(valore: string | undefined): boolean {
  return !valore || valore.trim() === '' || valore.startsWith('METTI_QUI');
}

/** Cosa manca ancora, fra quelli che deve dare una persona. */
export function segretiDaCompilare(ambiente: Record<string, string | undefined>): string[] {
  return SEGRETI_RICHIESTI.filter((nome) => valoreMancante(ambiente[nome]));
}

/**
 * Mette i valori letti nell'ambiente, e dice cosa resta scoperto.
 *
 * Il file vince su quello che c'è già. Il contrario significherebbe che i
 * segnaposto riscritti dall'aggiornamento continuano a vincere sul file —
 * cioè il guasto che questo meccanismo esiste per togliere.
 */
export function applicaSegreti(
  testo: string,
  ambiente: Record<string, string | undefined>,
): { nomi: string[]; mancanti: string[] } {
  const valori = leggiSegreti(testo);
  for (const [nome, valore] of valori) ambiente[nome] = valore;

  const mancanti = SEGRETI_ATTESI.filter((nome) => valoreMancante(ambiente[nome]));

  return { nomi: [...valori.keys()], mancanti: [...mancanti] };
}

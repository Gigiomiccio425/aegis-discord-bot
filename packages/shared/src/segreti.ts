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

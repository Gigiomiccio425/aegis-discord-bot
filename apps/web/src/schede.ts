/* ═══════════════════════════════════════════════════════════════════════
   UN MODULO DIVISO IN SCHEDE

   Un modulo come l'anti-nuke ha una trentina di opzioni: tutte in una
   pagina sono una colonna che non finisce più, e la cosa che si cerca sta
   sempre in fondo. Diviso in schede — «Principali», «Regole per azione»,
   «Chi non viene valutato» — si vede solo il pezzo che serve, e i nomi
   delle schede dicono da soli di cosa è fatto il modulo.

   La divisione si ricava dalla forma della configurazione, non da un
   elenco scritto a mano: un gruppo di opzioni abbastanza grande diventa una
   scheda, uno piccolo — «5 in 30 secondi» — resta fra le principali, dove si
   legge in una riga.
   ═══════════════════════════════════════════════════════════════════════ */

type Json = Record<string, unknown>;

/** L'id della scheda con le opzioni sciolte del modulo. */
export const PRINCIPALI = 'principali';

export interface Scheda {
  id: string;
  titolo: string;
  /** Il gruppo di opzioni della scheda; `null` per le principali. */
  percorso: string | null;
}

function oggettoSemplice(valore: unknown): valore is Json {
  return typeof valore === 'object' && valore !== null && !Array.isArray(valore);
}

/**
 * Due o tre valori semplici che si leggono insieme: quantità e finestra di
 * tempo, una soglia. Restano sulla stessa pagina di chi li contiene.
 */
export function gruppoPiccolo(valore: unknown): boolean {
  if (!oggettoSemplice(valore)) return false;
  const figli = Object.values(valore);
  return figli.length <= 3 && figli.every((figlio) => figlio === null || typeof figlio !== 'object');
}

/** Un gruppo di opzioni che merita una scheda sua. */
export function gruppoGrande(valore: unknown): boolean {
  return oggettoSemplice(valore) && !gruppoPiccolo(valore);
}

/**
 * Le schede di un modulo. Vuoto quando il modulo è abbastanza piccolo da
 * stare in una pagina sola: una scheda unica è un clic in più per niente.
 *
 * `enabled` non conta fra le principali: l'interruttore del modulo sta in
 * cima alla pagina, fuori dalle schede.
 */
export function schedeDi(
  valore: Json,
  chiaveSezione: string,
  etichetta: (percorso: string, chiave: string) => string,
): Scheda[] {
  const voci = Object.entries(valore);
  const grandi = voci.filter(([, figlio]) => gruppoGrande(figlio));
  if (grandi.length === 0) return [];

  const schede: Scheda[] = [];
  const sciolte = voci.filter(
    ([chiave, figlio]) => !gruppoGrande(figlio) && !(chiave === 'enabled' && typeof figlio === 'boolean'),
  );
  if (sciolte.length > 0) schede.push({ id: PRINCIPALI, titolo: 'Principali', percorso: null });

  for (const [chiave] of grandi) {
    const percorso = `${chiaveSezione}.${chiave}`;
    schede.push({ id: chiave, titolo: etichetta(percorso, chiave), percorso });
  }
  return schede;
}

/**
 * La scheda in cui sta un campo: la ricerca porta a un campo, e la pagina
 * deve aprire la scheda giusta prima di poterlo mostrare.
 */
export function schedaDelCampo(campo: string, chiaveSezione: string, schede: Scheda[]): string | null {
  if (schede.length === 0 || !campo.startsWith(`${chiaveSezione}.`)) return null;
  const primo = campo.slice(chiaveSezione.length + 1).split('.')[0];
  const propria = schede.find((scheda) => scheda.id !== PRINCIPALI && scheda.id === primo);
  if (propria) return propria.id;
  return schede.some((scheda) => scheda.id === PRINCIPALI) ? PRINCIPALI : null;
}

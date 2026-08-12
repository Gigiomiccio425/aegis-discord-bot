import { z } from 'zod';
import { GuildConfigSchema } from './index.js';

/* ═══════════════════════════════════════════════════════════════════════
   FORMA DEI CAMPI

   L'editor del pannello sceglie il controllo guardando il *valore*: una
   stringa diventa una casella di testo, un numero un contatore, un elenco una
   riga di valori separati da virgola.

   Su un elenco vuoto quel criterio non ha niente da guardare, e sbaglia:
   `[]` sembra un elenco di stringhe anche quando è l'elenco degli streamer,
   cioè un elenco di oggetti. Chi apriva la configurazione di Twitch senza
   streamer si trovava una casella di testo, e qualunque cosa ci scrivesse
   veniva rifiutata dal salvataggio.

   La forma va quindi chiesta allo schema, non al valore. Camminare lo schema
   Zod invece di tenere un elenco scritto a mano evita l'unico esito
   prevedibile di quell'elenco: restare indietro rispetto agli schemi.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Toglie gli involucri che non cambiano la forma del dato: `.default()`,
 * `.optional()`, `.nullable()`, `.catch()` e le trasformazioni.
 */
function nucleo(schema: z.ZodTypeAny): z.ZodTypeAny {
  let corrente: z.ZodTypeAny = schema;

  // Gli involucri si annidano — `z.array(...).default([]).optional()` ne ha
  // due — quindi si sbuccia finché si trova qualcosa di diverso.
  for (let giro = 0; giro < 20; giro += 1) {
    const def = corrente._def as { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    switch (def.typeName) {
      case 'ZodDefault':
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodCatch':
      case 'ZodReadonly':
        if (!def.innerType) return corrente;
        corrente = def.innerType;
        break;
      case 'ZodEffects':
        if (!def.schema) return corrente;
        corrente = def.schema;
        break;
      default:
        return corrente;
    }
  }

  return corrente;
}

function tipoDi(schema: z.ZodTypeAny): string {
  return (nucleo(schema)._def as { typeName?: string }).typeName ?? '';
}

/**
 * Percorsi degli elenchi i cui elementi sono oggetti, non valori semplici.
 *
 * Non entra dentro i `z.record()`: le loro chiavi non fanno parte dello
 * schema, e gli elenchi che contengono sono comunque di stringhe.
 */
function raccogli(schema: z.ZodTypeAny, prefisso: string, trovati: string[]): void {
  const base = nucleo(schema);
  const def = base._def as {
    typeName?: string;
    shape?: () => Record<string, z.ZodTypeAny>;
    type?: z.ZodTypeAny;
  };

  if (def.typeName === 'ZodObject' && def.shape) {
    for (const [chiave, campo] of Object.entries(def.shape())) {
      raccogli(campo, prefisso ? `${prefisso}.${chiave}` : chiave, trovati);
    }
    return;
  }

  if (def.typeName === 'ZodArray' && def.type) {
    if (tipoDi(def.type) === 'ZodObject') trovati.push(prefisso);
  }
}

/**
 * Un elemento vuoto ma valido per un elenco di oggetti.
 *
 * Serve al pulsante «Aggiungi» del pannello: davanti a `[]` non si capisce
 * quali campi vadano scritti, e cercarli nel README per poi comporre il JSON a
 * mano è il motivo per cui certe integrazioni non vengono mai configurate.
 *
 * I valori sono quelli predefiniti dello schema dove esistono. Dove non
 * esistono resta un vuoto del tipo giusto: è il campo che l'utente deve
 * riempire, ed è giusto che si veda.
 */
function campione(schema: z.ZodTypeAny): unknown {
  const base = nucleo(schema);
  const def = base._def as {
    typeName?: string;
    shape?: () => Record<string, z.ZodTypeAny>;
    type?: z.ZodTypeAny;
    values?: unknown[];
    defaultValue?: () => unknown;
  };

  // Il valore predefinito, quando c'è, vince su qualunque ricostruzione: è
  // esattamente ciò che lo schema considera un punto di partenza sensato.
  const conDefault = schema._def as { typeName?: string; defaultValue?: () => unknown };
  if (conDefault.typeName === 'ZodDefault' && conDefault.defaultValue) {
    return conDefault.defaultValue();
  }

  switch (def.typeName) {
    case 'ZodObject':
      return def.shape ? campioneOggetto(def.shape()) : {};
    case 'ZodArray':
      return [];
    case 'ZodString':
      return '';
    case 'ZodNumber':
      return 0;
    case 'ZodBoolean':
      return false;
    case 'ZodEnum':
      return def.values?.[0] ?? null;
    default:
      return null;
  }
}

function campioneOggetto(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const risultato: Record<string, unknown> = {};

  for (const [chiave, campo] of Object.entries(shape)) {
    // I campi facoltativi senza valore predefinito restano fuori: metterli a
    // `null` sposterebbe il problema dal «cosa scrivo qui» al «questo posso
    // cancellarlo?».
    const tipo = (campo._def as { typeName?: string }).typeName;
    if (tipo === 'ZodOptional') continue;
    risultato[chiave] = campione(campo);
  }

  return risultato;
}

/**
 * Scheletro di un elemento per ogni elenco di oggetti, indicizzato per
 * percorso.
 */
export function objectArrayTemplates(): Record<string, unknown> {
  const risultato: Record<string, unknown> = {};

  for (const percorso of objectArrayPaths()) {
    const schema = risolvi(percorso);
    const def = schema ? (nucleo(schema)._def as { type?: z.ZodTypeAny }) : null;
    if (def?.type) risultato[percorso] = campione(def.type);
  }

  return risultato;
}

/** Lo schema che sta a un certo percorso, o `null` se il percorso non esiste. */
function risolvi(percorso: string): z.ZodTypeAny | null {
  let corrente: z.ZodTypeAny = GuildConfigSchema;

  for (const chiave of percorso.split('.')) {
    const def = nucleo(corrente)._def as {
      typeName?: string;
      shape?: () => Record<string, z.ZodTypeAny>;
    };
    if (def.typeName !== 'ZodObject' || !def.shape) return null;
    const prossimo = def.shape()[chiave];
    if (!prossimo) return null;
    corrente = prossimo;
  }

  return corrente;
}

let cache: string[] | null = null;

/**
 * Elenco dei percorsi di configurazione che contengono un elenco di oggetti.
 *
 * Calcolato una volta sola: la camminata è veloce ma lo schema non cambia
 * mentre il processo gira.
 */
export function objectArrayPaths(): string[] {
  if (cache) return cache;
  const trovati: string[] = [];
  raccogli(GuildConfigSchema, '', trovati);
  cache = trovati.sort();
  return cache;
}

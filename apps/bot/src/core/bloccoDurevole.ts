import { getPrisma, type Prisma } from '@angel/db';
import { childLogger } from './logger.js';
import type { LockdownState } from './lockdown.js';

const log = childLogger('bloccoDurevole');

/* ═══════════════════════════════════════════════════════════════════════
   LO STATO DEL BLOCCO, IN UN POSTO CHE NON SI PERDE

   Lo stato di un lockdown vive in Redis, ed è giusto: lì si reclama con
   SET NX, e due lockdown lanciati insieme non partono tutti e due. Ma
   dentro ci sono anche i permessi di scrittura tolti ai ruoli per la durata
   del blocco, e l'unico elenco di cosa rimettere alla revoca è quello.

   Redis salva su disco ogni tanto, e allo spegnimento ordinato. Uno
   spegnimento brusco durante un blocco — la corrente, un crash — si porta
   via lo stato, e con lui i permessi dei ruoli: la revoca forzata riapre i
   canali a @everyone, ma quei permessi non tornano, e bisogna rimetterli a
   mano canale per canale.

   Qui c'è la stessa cosa su Postgres. Tre regole:

   • **Redis resta la fonte principale.** Questa è una copia: si scrive dopo
     Redis, e se il database non risponde il blocco va avanti lo stesso. Un
     lockdown che non parte perché Postgres è lento è peggio del rischio
     che questa copia esiste per coprire;

   • **si legge solo quando Redis non ha niente**, e solo dove serve:
     alla revoca, alla scadenza, e per non far partire un secondo blocco
     sopra uno che Redis ha dimenticato;

   • **non la usa il controllo sui messaggi.** Una copia rimasta indietro
     — la cancellazione fallita dopo una revoca — farebbe cancellare i
     messaggi in canali già riaperti. Lì vale solo Redis.
   ═══════════════════════════════════════════════════════════════════════ */

/** Il minimo del database che serve qui. Un test ne passa uno finto. */
export interface DbBlocchi {
  lockdownRecord: {
    upsert(argomenti: {
      where: { guildId: string };
      create: { guildId: string; state: Prisma.InputJsonValue };
      update: { state: Prisma.InputJsonValue };
    }): Promise<unknown>;
    findUnique(argomenti: {
      where: { guildId: string };
    }): Promise<{ state: Prisma.JsonValue } | null>;
    deleteMany(argomenti: { where: { guildId: string } }): Promise<{ count: number }>;
    findMany(argomenti: { select: { guildId: true } }): Promise<{ guildId: string }[]>;
  };
}

export interface ArchivioBlocchi {
  /** Scrive la copia. Non lancia: un database lento non ferma un lockdown. */
  salva(guildId: string, stato: LockdownState): Promise<void>;
  /** La copia, se c'è. `null` anche se il database non risponde. */
  leggi(guildId: string): Promise<LockdownState | null>;
  /** Toglie la copia. Non lancia. */
  cancella(guildId: string): Promise<void>;
  /**
   * I server che hanno una copia. Una query sola: il ciclo delle scadenze
   * gira ogni venti secondi, e chiedere al database server per server anche
   * quando non c'è nessun blocco sarebbe carico per niente.
   */
  elenca(): Promise<Set<string>>;
}

export function archivioBlocchi(db: DbBlocchi = getPrisma()): ArchivioBlocchi {
  return {
    async salva(guildId, stato) {
      const state = stato as unknown as Prisma.InputJsonValue;
      await db.lockdownRecord
        .upsert({ where: { guildId }, create: { guildId, state }, update: { state } })
        .catch((errore: unknown) => {
          log.warn(
            { err: errore, guildId },
            'copia dello stato del lockdown non salvata nel database: resta solo quella in Redis',
          );
        });
    },

    async leggi(guildId) {
      const riga = await db.lockdownRecord
        .findUnique({ where: { guildId } })
        .catch((errore: unknown) => {
          log.warn({ err: errore, guildId }, 'copia dello stato del lockdown non leggibile');
          return null;
        });
      const stato = riga?.state as unknown as LockdownState | null | undefined;
      // Una riga che non ha la forma di uno stato non è uno stato: meglio
      // nessuna copia che una copia da cui rimettere permessi a caso.
      if (!stato || typeof stato !== 'object' || !Array.isArray(stato.channels)) return null;
      return stato;
    },

    async cancella(guildId) {
      await db.lockdownRecord.deleteMany({ where: { guildId } }).catch((errore: unknown) => {
        // Il caso da non tacere: una copia rimasta dopo la revoca verrebbe
        // presa per un blocco ancora in corso alla prossima revoca forzata.
        log.error(
          { err: errore, guildId },
          'copia dello stato del lockdown non cancellata dopo la revoca',
        );
      });
    },

    async elenca() {
      const righe = await db.lockdownRecord
        .findMany({ select: { guildId: true } })
        .catch(() => [] as { guildId: string }[]);
      return new Set(righe.map((riga) => riga.guildId));
    },
  };
}

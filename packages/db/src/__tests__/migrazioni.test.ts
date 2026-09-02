import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/* ═══════════════════════════════════════════════════════════════════════
   LO SCHEMA E LE MIGRAZIONI DICONO LA STESSA COSA?

   Questo test esiste perché il contrario è successo: sette tabelle nuove
   aggiunte a `schema.prisma`, `prisma generate` eseguito, tutto che compila,
   tutti i test verdi — e nessuna migrazione. Il client conosceva le tabelle,
   il database no.

   Il guasto sarebbe stato invisibile fino alla produzione, e lì silenzioso:
   `prisma migrate deploy` non ha niente da applicare, il processo parte, la
   prima query fallisce e viene inghiottita dal ramo che gestisce «database
   non raggiungibile». Il bot sarebbe rimasto acceso senza servire nessun
   canale, senza un errore che spiegasse perché.

   `prisma migrate dev` questo controllo lo fa, ma solo con un database
   davanti. Qui non c'è: si confronta il testo, che è meno preciso e
   funziona sempre — compreso su una macchina senza Docker, che è
   precisamente quella su cui la migrazione è stata dimenticata.
   ═══════════════════════════════════════════════════════════════════════ */

const qui = path.dirname(fileURLToPath(import.meta.url));
const PRISMA = path.resolve(qui, '../../prisma');

const schema = readFileSync(path.join(PRISMA, 'schema.prisma'), 'utf8');

/** Tutte le migrazioni concatenate: l'ordine non conta, la presenza sì. */
const migrazioni = readdirSync(path.join(PRISMA, 'migrations'), { withFileTypes: true })
  .filter((voce) => voce.isDirectory())
  .map((voce) => readFileSync(path.join(PRISMA, 'migrations', voce.name, 'migration.sql'), 'utf8'))
  .join('\n');

/** I modelli dello schema, con le righe dei campi. */
interface Modello {
  nome: string;
  campi: { nome: string; tipo: string }[];
}

function leggiModelli(): Modello[] {
  const modelli: Modello[] = [];

  for (const blocco of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const nome = blocco[1]!;
    const campi: { nome: string; tipo: string }[] = [];

    for (const riga of blocco[2]!.split('\n')) {
      const pulita = riga.trim();
      // Attributi di modello, commenti, righe vuote: non sono colonne.
      if (!pulita || pulita.startsWith('@@') || pulita.startsWith('//')) continue;

      const trovato = /^(\w+)\s+(\w+)/.exec(pulita);
      if (trovato) campi.push({ nome: trovato[1]!, tipo: trovato[2]! });
    }

    modelli.push({ nome, campi });
  }

  return modelli;
}

const modelli = leggiModelli();
const nomiModelli = new Set(modelli.map((m) => m.nome));

describe('migrazioni allineate allo schema', () => {
  it('lo schema contiene modelli da cui partire', () => {
    expect(modelli.length).toBeGreaterThan(30);
  });

  it('esiste almeno una migrazione', () => {
    expect(migrazioni.length).toBeGreaterThan(1000);
  });

  /*
   * Il test che avrebbe fermato il guasto.
   *
   * Un modello senza `CREATE TABLE` è un modello che esiste solo nel client
   * generato: il codice compila, i tipi tornano, e in produzione la tabella
   * non c'è.
   */
  it('ogni modello ha la propria tabella in una migrazione', () => {
    const senzaTabella = modelli
      .filter((modello) => !migrazioni.includes(`CREATE TABLE "${modello.nome}"`))
      .map((modello) => modello.nome);

    expect(senzaTabella).toEqual([]);
  });

  /*
   * Le colonne.
   *
   * Il caso più frequente non è la tabella intera dimenticata: è il campo
   * aggiunto a un modello che c'era già. Compila, il client lo espone, e la
   * prima scrittura fallisce con «column does not exist».
   *
   * I campi di relazione non sono colonne — `channel TwitchChannel` non
   * esiste nel database, esiste `channelId` — e si riconoscono dal tipo, che
   * è il nome di un altro modello.
   */
  it('ogni colonna compare in una migrazione', () => {
    const mancanti: string[] = [];

    for (const modello of modelli) {
      for (const campo of modello.campi) {
        if (nomiModelli.has(campo.tipo)) continue;
        if (!migrazioni.includes(`"${campo.nome}"`)) {
          mancanti.push(`${modello.nome}.${campo.nome}`);
        }
      }
    }

    expect(mancanti).toEqual([]);
  });

  /*
   * E il contrario: una tabella creata da una migrazione e poi tolta dallo
   * schema resta nel database per sempre, occupando spazio e confondendo chi
   * legge. Non è un errore da bloccare — a volte si cancella davvero una
   * tabella — ma va fatto con una migrazione che la elimini, e questo test
   * costringe a scriverla.
   */
  it('nessuna tabella creata dalle migrazioni è sparita dallo schema senza essere eliminata', () => {
    const create = [...migrazioni.matchAll(/CREATE TABLE "(\w+)"/g)].map((t) => t[1]!);
    const orfane = create.filter(
      (tabella) =>
        !nomiModelli.has(tabella) && !migrazioni.includes(`DROP TABLE "${tabella}"`),
    );

    expect(orfane).toEqual([]);
  });
});

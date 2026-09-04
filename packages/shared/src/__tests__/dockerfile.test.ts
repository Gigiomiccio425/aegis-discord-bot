import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/* ═══════════════════════════════════════════════════════════════════════
   IL DOCKERFILE CONOSCE TUTTI I WORKSPACE?

   Questo test esiste perché il contrario è costato tre versioni.

   Il Dockerfile copia i package.json **uno per uno** prima di `npm ci`, per
   riusare il livello delle dipendenze dalla cache: senza, ogni modifica al
   codice farebbe riscaricare mezzo npm. Il prezzo è un elenco scritto a
   mano, e un elenco scritto a mano è un elenco che un giorno resta indietro.

   È successo con `packages/twitch`, `apps/twitch` e `apps/web-twitch`: nati
   dopo, mai aggiunti lì. In locale tutto compilava — i workspace ci sono
   davvero — e dentro Docker `npm ci` produceva un albero senza i loro
   collegamenti. Ogni build da 1.25.0 in poi è morta, e le immagini di
   quattro versioni non sono mai esistite. Il sintomo era un `tsc -b` che
   usciva con codice 1 senza stampare niente, cioè il modo peggiore di
   fallire.

   Il confronto è testuale e non esegue Docker: gira ovunque, in un
   millisecondo, e copre esattamente il caso che si è verificato.
   ═══════════════════════════════════════════════════════════════════════ */

const qui = path.dirname(fileURLToPath(import.meta.url));
const RADICE = path.resolve(qui, '../../../..');

const dockerfile = readFileSync(path.join(RADICE, 'docker/Dockerfile'), 'utf8');

/** I workspace che esistono davvero sul disco. */
function workspaceVeri(): string[] {
  const trovati: string[] = [];

  for (const gruppo of ['packages', 'apps']) {
    for (const voce of readdirSync(path.join(RADICE, gruppo), { withFileTypes: true })) {
      if (!voce.isDirectory()) continue;
      try {
        readFileSync(path.join(RADICE, gruppo, voce.name, 'package.json'));
        trovati.push(`${gruppo}/${voce.name}`);
      } catch {
        /* cartella senza package.json: non è un workspace */
      }
    }
  }

  return trovati;
}

/** I workspace di cui il Dockerfile copia il manifesto. */
function workspaceNelDockerfile(): string[] {
  return [...dockerfile.matchAll(/^COPY\s+((?:packages|apps)\/[\w-]+)\/package\.json/gm)].map(
    (trovato) => trovato[1]!,
  );
}

describe('il Dockerfile e i workspace', () => {
  const veri = workspaceVeri();
  const elencati = workspaceNelDockerfile();

  it('il repository ha dei workspace da confrontare', () => {
    expect(veri.length).toBeGreaterThan(5);
    expect(veri).toContain('packages/shared');
  });

  /*
   * La controprova.
   *
   * Una lettura che non trova niente passerebbe sempre, e passerebbe anche
   * con la regex sbagliata — dando la stessa tranquillità di un controllo
   * vero senza controllare nulla.
   */
  it('la lettura del Dockerfile trova davvero le righe COPY', () => {
    expect(elencati.length, 'nessuna riga COPY riconosciuta').toBeGreaterThan(5);
    expect(elencati).toContain('packages/shared');
  });

  /*
   * Il test che avrebbe fermato il guasto.
   *
   * Un workspace che non compare qui non ottiene i propri collegamenti da
   * `npm ci`, e la build muore dentro Docker mentre in locale passa.
   */
  it('copia il package.json di ogni workspace', () => {
    const dimenticati = veri.filter((workspace) => !elencati.includes(workspace));
    expect(dimenticati).toEqual([]);
  });

  /*
   * E il contrario: una riga che punta a una cartella cancellata fa fallire
   * `docker build` al primo `COPY`, con un errore che parla di un file
   * mancante e non di un workspace rimosso sei mesi prima.
   */
  it('non copia workspace che non esistono più', () => {
    const fantasmi = elencati.filter((workspace) => !veri.includes(workspace));
    expect(fantasmi).toEqual([]);
  });

  /*
   * Il supervisore verifica all'avvio che l'immagine contenga i file dei
   * pacchetti che dichiara. Quell'elenco è un'altra copia scritta a mano
   * della stessa informazione, ed è l'altra metà dello stesso problema: un
   * pacchetto nuovo che non compare lì non viene controllato, e un'immagine
   * costruita a metà parte lo stesso.
   */
  it('il supervisore controlla tutti i pacchetti condivisi', () => {
    const avvio = readFileSync(path.join(RADICE, 'docker/avvio.mjs'), 'utf8');
    const trovato = /const PACCHETTI = \[([^\]]*)\]/.exec(avvio);
    expect(trovato, 'elenco PACCHETTI non trovato in avvio.mjs').not.toBeNull();

    const controllati = [...trovato![1]!.matchAll(/'([\w-]+)'/g)].map((voce) => `packages/${voce[1]!}`);
    const pacchetti = veri.filter((workspace) => workspace.startsWith('packages/'));

    expect(pacchetti.filter((nome) => !controllati.includes(nome))).toEqual([]);
  });
});

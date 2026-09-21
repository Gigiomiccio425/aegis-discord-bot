import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/* ═══════════════════════════════════════════════════════════════════════
   OGNI WORKER LA SUA CONNESSIONE

   Un `Worker` di BullMQ aspetta i lavori con un comando bloccante, e quando
   gli si passa un'istanza di ioredis la usa così com'è — nel suo sorgente,
   `this._client = wrapRedisInstance(opts)`, con `blockingConnection: true`.
   Nessun duplicato.

   ioredis manda i comandi su una socket sola, in ordine. Dieci Worker che
   bloccano a turno sulla stessa connessione fanno aspettare dietro di loro
   ogni altro comando, per decine di secondi.

   Il sintomo non assomigliava alla causa: la chiave `version:worker` scade
   dopo 180 secondi, il battito la riscrive ogni 60, e se le scritture
   arrivano in ritardo la chiave scade — il pannello scriveva «worker: fermo»
   di un processo vivo che stava lavorando.

   Rimettere `connection` condiviso su un Worker solo basta a riaprirlo, e non
   darebbe nessun errore. Per questo è un test e non un commento.
   ═══════════════════════════════════════════════════════════════════════ */

const qui = path.dirname(fileURLToPath(import.meta.url));
const AVVIO = path.resolve(qui, '../index.ts');
const sorgente = readFileSync(AVVIO, 'utf8');

/** Gli argomenti di ogni `new Worker(`, parentesi comprese. */
function costruzioniDiWorker(testo: string): string[] {
  const trovate: string[] = [];
  let da = testo.indexOf('new Worker(');

  while (da !== -1) {
    let livello = 0;
    let i = testo.indexOf('(', da);
    const inizio = i;
    for (; i < testo.length; i += 1) {
      if (testo[i] === '(') livello += 1;
      else if (testo[i] === ')') {
        livello -= 1;
        if (livello === 0) break;
      }
    }
    trovate.push(testo.slice(inizio, i + 1));
    da = testo.indexOf('new Worker(', i);
  }

  return trovate;
}

describe('connessioni Redis del worker', () => {
  const costruzioni = costruzioniDiWorker(sorgente);

  // La controprova: senza, una lettura sbagliata non troverebbe nessun Worker
  // e ogni controllo qui sotto passerebbe su un insieme vuoto.
  it('i Worker si leggono davvero', () => {
    expect(costruzioni.length, 'nessun new Worker( trovato').toBeGreaterThan(5);
  });

  it('nessun Worker condivide la connessione con gli altri', () => {
    const condivisi = costruzioni.filter((pezzo) => !pezzo.includes('connessionePerCoda()'));

    expect(condivisi, 'Worker senza una connessione propria').toEqual([]);
  });

  /*
   * L'errore opposto, altrettanto silenzioso: una connessione creata una volta
   * e passata a due Worker. Il conto le distingue — una chiamata per Worker.
   */
  it('le connessioni sono tante quanti i Worker', () => {
    const chiamate = (sorgente.match(/connessionePerCoda\(\)/g) ?? []).length;
    expect(chiamate).toBe(costruzioni.length);
  });

  /*
   * I produttori invece la condividono, ed è giusto: un `Queue` non blocca
   * niente, e aprire una socket per ognuno sarebbe spreco senza motivo.
   */
  it('i produttori restano sulla connessione condivisa', () => {
    expect(sorgente).toContain('new Queue(');
    expect(sorgente).toContain('new Queue(Queues.snapshot, { connection })');
  });
});

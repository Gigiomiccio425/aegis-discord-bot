import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Queues } from '@angel/shared';

/*
 * UNA CODA SENZA CONSUMATORE NON DÀ ERRORI
 *
 * Chi accoda un lavoro riceve una conferma: il lavoro è in coda. Se nessun
 * processo la legge, resta lì — e con lui tutti quelli dopo. Non c'è un
 * errore da nessuna parte: solo un lavoro che non accade e la memoria di
 * Redis che cresce.
 *
 * `logDelivery` era dichiarata e non letta da nessuno. Nessuno vi accodava
 * niente, quindi non è mai stato un guasto; ma il prossimo che avesse visto
 * il nome nell'elenco avrebbe potuto usarla, e da lì il guasto sarebbe stato
 * silenzioso per settimane.
 */

const qui = path.dirname(fileURLToPath(import.meta.url));
const INDICE = path.resolve(qui, '../index.ts');

describe('code del worker', () => {
  const sorgente = readFileSync(INDICE, 'utf8');
  const consumate = new Set(
    [...sorgente.matchAll(/new Worker\(\s*Queues\.(\w+)/g)].map((trovato) => trovato[1]!),
  );

  it('ogni coda dichiarata ha un consumatore', () => {
    // La controprova: senza, una lettura sbagliata del sorgente farebbe
    // passare qualunque cosa.
    expect(consumate.size, 'nessun Worker trovato nel sorgente').toBeGreaterThan(5);
    expect(consumate.has('deepScan')).toBe(true);

    const orfane = Object.keys(Queues).filter((nome) => !consumate.has(nome));
    expect(orfane, 'code dichiarate e mai lette').toEqual([]);
  });

  it('nessun consumatore legge una coda che non esiste', () => {
    const inventate = [...consumate].filter((nome) => !(nome in Queues));
    expect(inventate).toEqual([]);
  });
});

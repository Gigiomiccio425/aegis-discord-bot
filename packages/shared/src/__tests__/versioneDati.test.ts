import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — modulo JavaScript del contenitore, senza dichiarazioni.
import { consiglioPermessi, registraVersione } from '../../../../docker/versioneDati.mjs';

/* ═══════════════════════════════════════════════════════════════════════
   LA VERSIONE ACCANTO AI DATI

   Da qui ANGEL capisce che c'è appena stato un aggiornamento, e chiede
   subito una copia. Due guasti da non rimettere:

   • al primo avvio dopo un aggiornamento la cartella dei backup era ancora
     di root — il container dei permessi parte insieme ad ANGEL — e la
     copia di quel momento saltava;
   • il consiglio in caso di errore diceva di cambiare proprietario a tutta
     la cartella dei dati, dove c'è anche Postgres, che poi non parte più.
   ═══════════════════════════════════════════════════════════════════════ */

const temporanee: string[] = [];

async function cartellaNuova() {
  const percorso = await fs.mkdtemp(path.join(os.tmpdir(), 'angel-versione-'));
  temporanee.push(percorso);
  return percorso;
}

afterEach(async () => {
  for (const percorso of temporanee.splice(0)) {
    await fs.rm(percorso, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Un errore di permessi, come lo dà Node. */
const negato = () => Object.assign(new Error('permesso negato'), { code: 'EACCES' });

/** Nessuna attesa vera nei test, ma si conta quante ce ne sarebbero state. */
function dormiContato() {
  const attese: number[] = [];
  return { attese, dormi: async (ms: number) => void attese.push(ms) };
}

describe('versione accanto ai dati', () => {
  it('al primo avvio la scrive, e non è un aggiornamento', async () => {
    const cartella = await cartellaNuova();

    const esito = await registraVersione(cartella, '1.31.8');

    expect(esito.aggiornato).toBe(false);
    expect(await fs.readFile(path.join(cartella, 'VERSIONE'), 'utf8')).toMatch(/^1\.31\.8\n/);
  });

  it('con una versione diversa, è un aggiornamento', async () => {
    const cartella = await cartellaNuova();
    await fs.writeFile(path.join(cartella, 'VERSIONE'), '1.31.7\n2026-09-22T04:15:00.000Z\n');

    const esito = await registraVersione(cartella, '1.31.8');

    expect(esito.aggiornato).toBe(true);
    expect(esito.prima).toBe('1.31.7');
  });

  // La controprova: senza, «è un aggiornamento» a ogni riavvio passerebbe.
  it('con la stessa versione, non lo è', async () => {
    const cartella = await cartellaNuova();
    await fs.writeFile(path.join(cartella, 'VERSIONE'), '1.31.8\n2026-09-22T04:15:00.000Z\n');

    expect((await registraVersione(cartella, '1.31.8')).aggiornato).toBe(false);
  });

  /*
   * IL PRIMO AVVIO DOPO UN AGGIORNAMENTO
   *
   * La cartella è ancora di root per qualche istante, finché il container
   * dei permessi non finisce. Si riprova, e l'aggiornamento si vede lo
   * stesso — quindi la copia di quel momento parte.
   */
  it('se la cartella diventa scrivibile poco dopo, aspetta e ci riesce', async () => {
    const { attese, dormi } = dormiContato();
    let rifiuti = 2;
    const disco = {
      mkdir: async () => {
        if (rifiuti-- > 0) throw negato();
      },
      readFile: async () => '1.31.7\n',
      writeFile: async () => undefined,
    };

    const esito = await registraVersione('/backup', '1.31.8', { dormi, disco });

    expect(esito.errore).toBeNull();
    expect(esito.aggiornato, 'l’aggiornamento non deve andare perso').toBe(true);
    expect(attese).toHaveLength(2);
  });

  it('se resta inaccessibile si arrende, senza lanciare', async () => {
    const { attese, dormi } = dormiContato();
    const disco = {
      mkdir: async () => {
        throw negato();
      },
      readFile: async () => null,
      writeFile: async () => undefined,
    };

    const esito = await registraVersione('/backup', '1.31.8', { tentativi: 4, dormi, disco });

    expect(esito.errore?.code).toBe('EACCES');
    expect(esito.aggiornato).toBe(false);
    // Un'attesa fra un tentativo e l'altro, non dopo l'ultimo.
    expect(attese).toHaveLength(3);
  });

  it('un errore che il container dei permessi non risolve non si riprova', async () => {
    const { attese, dormi } = dormiContato();
    const disco = {
      mkdir: async () => {
        throw Object.assign(new Error('disco pieno'), { code: 'ENOSPC' });
      },
      readFile: async () => null,
      writeFile: async () => undefined,
    };

    const esito = await registraVersione('/backup', '1.31.8', { dormi, disco });

    expect(esito.errore?.code).toBe('ENOSPC');
    expect(attese).toEqual([]);
  });
});

describe('il consiglio quando la cartella resta di root', () => {
  const consiglio: string = consiglioPermessi('/backup');

  /*
   * Il consiglio di prima era `chown -R` sulla cartella dei dati dell'app.
   * Dentro c'è anche postgres, che con il proprietario cambiato non parte:
   * chi lo seguiva si ritrovava il database fermo per sistemare un backup.
   */
  it('cambia proprietario solo alla cartella dei backup', () => {
    const comando = /chown -R 1000:1000 (\S+)/.exec(consiglio);
    expect(comando, 'nessun comando nel consiglio').not.toBeNull();
    expect(comando![1]!.replace(/\.$/, '')).toMatch(/\/data\/backup$/);
  });

  it('dice perché non tutta la cartella dei dati', () => {
    expect(consiglio).toContain('postgres');
  });

  it('dice come controllare il container che dovrebbe già averlo fatto', () => {
    expect(consiglio).toContain('preparasegreti');
  });
});

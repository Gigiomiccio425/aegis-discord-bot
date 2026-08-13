import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leggiElenco, paroleMancanti, scriviElenco, unisciElenchi } from '../config/elenchi.js';
import { DEFAULT_WORDLIST } from '../config/wordlist.js';

describe('lettura di un elenco', () => {
  it('legge le direttive e le applica alle righe che seguono', () => {
    const { voci, errori } = leggiElenco(`
# commento
@categoria MINACCIA
@gravita GRAVE
ti ammazzo
ti trovo
`);
    expect(errori).toEqual([]);
    expect(voci).toHaveLength(2);
    expect(voci[0]).toMatchObject({ term: 'ti ammazzo', category: 'MINACCIA', severity: 'GRAVE' });
  });

  it('la riga con le colonne vince sulle direttive', () => {
    const { voci } = leggiElenco(`
@categoria INSULTO
@gravita LIEVE
scemo
porco dio | BESTEMMIA | GRAVE
`);
    expect(voci[0]).toMatchObject({ term: 'scemo', category: 'INSULTO', severity: 'LIEVE' });
    expect(voci[1]).toMatchObject({ term: 'porco dio', category: 'BESTEMMIA', severity: 'GRAVE' });
  });

  it('senza direttive vale insulto di gravità media', () => {
    const { voci } = leggiElenco('cretino');
    expect(voci[0]).toMatchObject({ category: 'INSULTO', severity: 'MEDIA' });
  });

  it('una riga sbagliata non ferma il resto', () => {
    // È la proprietà che rende il formato usabile: un refuso a metà file non
    // deve costare l'intera importazione.
    const { voci, errori } = leggiElenco(`
buona
x
altra | CATEGORIA_INVENTATA | GRAVE
@direttiva strana
ultima
`);
    expect(voci.map((voce) => voce.term)).toEqual(['buona', 'ultima']);
    expect(errori).toHaveLength(3);
    expect(errori[0]).toMatchObject({ riga: 3, motivo: 'termine troppo corto' });
  });

  it('normalizza in minuscolo', () => {
    const { voci } = leggiElenco('SCEMO | INSULTO | media');
    expect(voci[0]).toMatchObject({ term: 'scemo', severity: 'MEDIA' });
  });
});

describe('scrittura e rilettura', () => {
  it('un elenco scritto e riletto resta identico', () => {
    const riletto = leggiElenco(scriviElenco(DEFAULT_WORDLIST, 'prova')).voci;

    expect(riletto).toHaveLength(DEFAULT_WORDLIST.length);
    const prima = new Map(DEFAULT_WORDLIST.map((voce) => [voce.term, voce]));
    for (const voce of riletto) {
      expect(prima.get(voce.term)).toMatchObject({
        category: voce.category,
        severity: voce.severity,
      });
    }
  });
});

describe('unione', () => {
  it('non tocca le voci già presenti, nemmeno se cambiano gravità', () => {
    const esistenti = [{ term: 'cazzo', category: 'VOLGARITA', severity: 'LIEVE' } as const];
    const esito = unisciElenchi([...esistenti], [
      { term: 'cazzo', category: 'VOLGARITA', severity: 'GRAVE' },
      { term: 'scemo', category: 'INSULTO', severity: 'MEDIA' },
    ]);

    expect(esito.aggiunte).toBe(1);
    expect(esito.gia).toBe(1);
    expect(esito.voci.find((voce) => voce.term === 'cazzo')?.severity).toBe('LIEVE');
  });

  it('mette le nuove in cima', () => {
    const esito = unisciElenchi(
      [{ term: 'vecchia', category: 'INSULTO', severity: 'MEDIA' }],
      [{ term: 'nuova', category: 'INSULTO', severity: 'MEDIA' }],
    );
    expect(esito.voci[0]?.term).toBe('nuova');
  });
});

describe('allineamento di un elenco già in uso', () => {
  it('trova le voci predefinite che mancano', () => {
    const parziale = DEFAULT_WORDLIST.slice(0, 100);
    expect(paroleMancanti(parziale)).toHaveLength(DEFAULT_WORDLIST.length - 100);
  });

  it('su un elenco già completo non trova nulla', () => {
    expect(paroleMancanti(DEFAULT_WORDLIST)).toEqual([]);
  });
});

describe('il file pubblicato su GitHub', () => {
  /*
   * Il file in `elenchi/` è generato, quindi può restare indietro rispetto
   * all'elenco vero senza che nessuno se ne accorga — e chi lo importa
   * crederebbe di essersi allineato. Questo test lo impedisce.
   */
  it('contiene tutte le voci predefinite', () => {
    const testo = readFileSync(new URL('../../../../elenchi/italiano-base.elenco', import.meta.url), 'utf8');
    const { voci, errori } = leggiElenco(testo);

    expect(errori).toEqual([]);
    const presenti = new Set(voci.map((voce) => voce.term));
    const mancanti = DEFAULT_WORDLIST.filter((voce) => !presenti.has(voce.term)).map((v) => v.term);
    expect(mancanti).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { MODULE_REGISTRY } from '@angel/shared';
import {
  CATEGORIE,
  SEZIONE_GENERALE,
  categoriaDi,
  posizioneSezione,
  raggruppaSezioni,
  type Sezione,
} from '../sezioni.js';

/* ═══════════════════════════════════════════════════════════════════════
   OGNI MODULO HA IL SUO POSTO

   Le categorie sono scritte a mano, e un elenco scritto a mano resta
   indietro al primo modulo nuovo. Il pannello non lo perde — lo mette in
   «Altre impostazioni» — ma lì le cose si smettono di trovare: il test
   pretende che ogni modulo sia collocato per nome.
   ═══════════════════════════════════════════════════════════════════════ */

const TUTTE: Sezione[] = [SEZIONE_GENERALE, ...MODULE_REGISTRY];
const chiaviScritte = CATEGORIE.flatMap((categoria) => categoria.chiavi);

describe('categorie della configurazione', () => {
  it('colloca per nome ogni modulo del registro', () => {
    const mancanti = TUTTE.map((sezione) => sezione.key).filter((chiave) => !chiaviScritte.includes(chiave));
    expect(mancanti).toEqual([]);
  });

  it('non nomina moduli che non esistono più', () => {
    const esistenti = new Set(TUTTE.map((sezione) => sezione.key));
    expect(chiaviScritte.filter((chiave) => !esistenti.has(chiave))).toEqual([]);
  });

  it('non mette lo stesso modulo in due categorie', () => {
    expect(new Set(chiaviScritte).size).toBe(chiaviScritte.length);
  });

  it('tiene ogni modulo nel gruppo che gli dà il registro', () => {
    const gruppoDi = new Map(TUTTE.map((sezione) => [sezione.key, sezione.group]));
    const fuoriPosto = CATEGORIE.flatMap((categoria) =>
      categoria.chiavi
        .filter((chiave) => gruppoDi.get(chiave) !== categoria.gruppo)
        .map((chiave) => `${chiave} in ${categoria.titolo}, ma è di ${gruppoDi.get(chiave)}`),
    );
    expect(fuoriPosto).toEqual([]);
  });

  // La panoramica si legge senza scorrere solo se nessuna categoria diventa
  // a sua volta un elenco lungo.
  it('non mette più di sei sezioni in una categoria', () => {
    const troppe = CATEGORIE.filter((categoria) => categoria.chiavi.length > 6).map((c) => c.titolo);
    expect(troppe).toEqual([]);
  });

  it('con il registro vero, nessuna sezione finisce fra le altre', () => {
    const categorie = raggruppaSezioni(TUTTE);
    expect(categorie.map((categoria) => categoria.id)).not.toContain('altro');
    expect(categorie.flatMap((categoria) => categoria.sezioni)).toHaveLength(TUTTE.length);
  });

  // Controprova: la rete di sicurezza funziona davvero, il test qui sopra
  // non passa perché la categoria di riserva non esiste.
  it('un modulo sconosciuto finisce in «Altre impostazioni», in fondo', () => {
    const categorie = raggruppaSezioni([...TUTTE, { key: 'economia', label: 'Economia', group: 'Economia' }]);
    const ultima = categorie.at(-1);
    expect(ultima?.id).toBe('altro');
    expect(ultima?.sezioni).toEqual([{ key: 'economia', label: 'Economia', group: 'Economia' }]);
    expect(posizioneSezione('economia', categorie)).toBe('Altre impostazioni');
  });

  it('non mostra le categorie vuote', () => {
    const categorie = raggruppaSezioni([SEZIONE_GENERALE]);
    expect(categorie.map((categoria) => categoria.id)).toEqual(['base']);
  });

  it('dice in quale categoria sta una sezione', () => {
    const categorie = raggruppaSezioni(TUTTE);
    expect(categoriaDi('security.antiRaid', categorie)?.id).toBe('attacchi');
    expect(posizioneSezione('scanner', categorie)).toBe('Controllo dei messaggi');
    expect(categoriaDi('inesistente', categorie)).toBeNull();
    expect(posizioneSezione('inesistente', categorie)).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { AUTOMATICO, TEMI, temaPerScelta, variabili, type Tema } from '../temi.js';

/* ═══════════════════════════════════════════════════════════════════════
   OGNI TEMA SI LEGGE

   Un tema entra solo se il testo si stacca dal fondo abbastanza da leggerlo
   senza sforzo. Le soglie sono quelle delle linee guida WCAG: 4.5:1 per il
   testo normale, 3:1 per gli elementi grafici e per i dettagli minori.

   Il pannello si guarda durante gli incidenti, spesso di fretta: un
   contrasto basso lì non è un difetto estetico, è una riga che non si legge
   nel momento in cui serve.
   ═══════════════════════════════════════════════════════════════════════ */

/** Luminanza relativa, come la definisce WCAG 2. */
function luminanza(esadecimale: string): number {
  const valore = esadecimale.replace('#', '');
  const canali = [0, 2, 4].map((inizio) => parseInt(valore.slice(inizio, inizio + 2), 16) / 255);
  const [r, g, b] = canali.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrasto(a: string, b: string): number {
  const [chiaro, scuro] = [luminanza(a), luminanza(b)].sort((x, y) => y - x);
  return (chiaro! + 0.05) / (scuro! + 0.05);
}

/** Tutte le coppie che non reggono, per un tema. */
function problemi(tema: Tema): string[] {
  const c = tema.colori;
  const fuori: string[] = [];
  const serve = (nome: string, testo: string, fondo: string, minimo: number) => {
    const valore = contrasto(testo, fondo);
    if (valore < minimo) fuori.push(`${tema.id}: ${nome} ${valore.toFixed(2)} < ${minimo}`);
  };

  for (const livello of [100, 200, 300, 400] as const) {
    serve(`testo ${livello} sul fondo`, c.testo[livello], c.base, 4.5);
    serve(`testo ${livello} sulla superficie`, c.testo[livello], c.superficie, 4.5);
    serve(`testo ${livello} sulla superficie 2`, c.testo[livello], c.superficie2, 4.5);
  }
  // Il 500 è quello delle spiegazioni sotto ogni impostazione: tante righe,
  // lette di fila. Deve reggere quanto il testo normale.
  serve('testo 500 sul fondo', c.testo[500], c.base, 4.5);
  serve('testo 500 sulla superficie', c.testo[500], c.superficie, 4.5);
  serve('testo 600 sulla superficie', c.testo[600], c.superficie, 3);

  serve("testo d'accento", c.accentoTesto, c.superficie, 4.5);
  serve('accento come elemento grafico', c.accento, c.superficie, 3);
  serve("testo sul pulsante d'accento", c.sopraAccento, c.accento, 4.5);
  serve('testo sul pulsante di pericolo', c.sopraPericolo, c.pericolo, 4.5);

  for (const [nome, colore] of [
    ['pericolo', c.pericolo],
    ['avviso', c.avviso],
    ['successo', c.successo],
    ['testo di pericolo', c.pericoloTesto],
    ['testo di avviso', c.avvisoTesto],
    ['testo di successo', c.successoTesto],
  ] as const) {
    serve(nome, colore, c.superficie, 4.5);
  }

  return fuori;
}

describe('temi del pannello', () => {
  it('ce ne sono tanti, scuri e chiari', () => {
    expect(TEMI.length).toBeGreaterThanOrEqual(12);
    expect(TEMI.filter((tema) => tema.chiaro).length).toBeGreaterThanOrEqual(4);
    expect(TEMI.filter((tema) => !tema.chiaro).length).toBeGreaterThanOrEqual(8);
  });

  it('ognuno ha un nome suo', () => {
    const id = TEMI.map((tema) => tema.id);
    expect(new Set(id).size).toBe(id.length);
    expect(id).not.toContain(AUTOMATICO);
  });

  it('ognuno si legge', () => {
    expect(TEMI.flatMap(problemi)).toEqual([]);
  });

  /*
   * La controprova del test qui sopra: con un testo grigio su fondo grigio
   * deve trovare il problema. Senza, un calcolo del contrasto sbagliato
   * farebbe passare qualunque tema.
   */
  it('un tema illeggibile viene riconosciuto', () => {
    const grigio: Tema = {
      ...TEMI[0]!,
      id: 'illeggibile',
      colori: { ...TEMI[0]!.colori, testo: { ...TEMI[0]!.colori.testo, 200: '#2a2d36' } },
    };
    expect(problemi(grigio).some((riga) => riga.includes('testo 200'))).toBe(true);
  });

  it('il contrasto si calcola come dice WCAG', () => {
    expect(contrasto('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrasto('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('ogni tema ridefinisce tutta la scala del testo usata dalle pagine', () => {
    for (const tema of TEMI) {
      const nomi = Object.keys(variabili(tema));
      for (const livello of [100, 200, 300, 400, 500, 600]) {
        expect(nomi).toContain(`--color-neutral-${livello}`);
      }
    }
  });
});

describe('scelta del tema', () => {
  it('«Automatico» segue il sistema', () => {
    expect(temaPerScelta(AUTOMATICO, false).chiaro).toBe(false);
    expect(temaPerScelta(AUTOMATICO, true).chiaro).toBe(true);
  });

  it('una scelta esplicita vince sul sistema', () => {
    expect(temaPerScelta('neve', false).id).toBe('neve');
    expect(temaPerScelta('mezzanotte', true).id).toBe('mezzanotte');
  });

  it('un nome sconosciuto ripiega sul tema predefinito', () => {
    expect(temaPerScelta('tema-che-non-esiste', false).id).toBe('notte-oro');
  });
});

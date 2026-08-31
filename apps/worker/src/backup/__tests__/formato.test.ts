import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TABELLE,
  improntaChiave,
  riconosciTipi,
  ripristinaTipi,
  serializza,
} from '../formato.js';

const qui = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(qui, '../../../../../packages/db/prisma/schema.prisma');

/**
 * Tabelle escluse dalla copia, con il motivo.
 *
 * Chi aggiunge un modello e lo esclude deve scriverlo qui: è il punto in cui
 * si è costretti a dire perché, invece di lasciarlo cadere fuori in silenzio.
 */
const ESCLUSE_APPOSTA = new Set([
  // Token OAuth cifrati, che scadono in pochi giorni e si rigenerano da soli:
  // nulla da recuperare, e qualcosa da perdere portandoli fuori dal volume.
  'panelSession',
]);

describe('elenco delle tabelle da copiare', () => {
  const modelli = [...readFileSync(SCHEMA, 'utf8').matchAll(/^model\s+(\w+)\s*\{/gm)].map(
    (trovato) => trovato[1]!,
  );

  const nomePrisma = (modello: string): string =>
    modello.charAt(0).toLowerCase() + modello.slice(1);

  it('lo schema contiene modelli da cui partire', () => {
    expect(modelli.length).toBeGreaterThan(20);
  });

  /*
   * Il test che conta.
   *
   * Il modo in cui una copia di sicurezza fallisce non è esplodendo: è
   * dimenticando una tabella aggiunta sei mesi prima, e accorgendosene il
   * giorno in cui serve. Qui un modello nuovo rompe la build finché qualcuno
   * non decide se va copiato o escluso.
   */
  it('copre ogni modello dello schema, o lo esclude di proposito', () => {
    const coperte = new Set<string>(TABELLE);
    const scoperte = modelli
      .map(nomePrisma)
      .filter((nome) => !coperte.has(nome) && !ESCLUSE_APPOSTA.has(nome));

    expect(scoperte).toEqual([]);
  });

  it('non elenca tabelle che nello schema non esistono', () => {
    const esistenti = new Set(modelli.map(nomePrisma));
    expect(TABELLE.filter((tabella) => !esistenti.has(tabella))).toEqual([]);
  });

  it('non ripete nessuna tabella', () => {
    expect(new Set(TABELLE).size).toBe(TABELLE.length);
  });

  it('mette guild per prima: tutto il resto vi si riferisce', () => {
    expect(TABELLE[0]).toBe('guild');
  });

  it('mette poll prima dei suoi voti e giveaway prima delle sue partecipazioni', () => {
    expect(TABELLE.indexOf('poll')).toBeLessThan(TABELLE.indexOf('pollVote'));
    expect(TABELLE.indexOf('giveaway')).toBeLessThan(TABELLE.indexOf('giveawayEntry'));
  });
});

describe('tipi che JSON non sa rappresentare', () => {
  it('riconosce date e bigint dai valori veri', () => {
    const tipi = riconosciTipi([
      { id: 12n, createdAt: new Date('2026-01-01'), summary: 'ciao', payload: { a: 1 } },
    ]);
    expect(tipi).toEqual({ id: 'bigint', createdAt: 'date' });
  });

  it('non si ferma alla prima riga: un campo nullo può essere valorizzato più avanti', () => {
    const tipi = riconosciTipi([{ expiresAt: null }, { expiresAt: new Date('2026-01-01') }]);
    expect(tipi.expiresAt).toBe('date');
  });

  it('sopravvive a un giro completo di serializzazione e ritorno', () => {
    const originale = {
      id: 9007199254740993n,
      createdAt: new Date('2026-08-31T04:15:00.000Z'),
      expiresAt: null,
      payload: { annidato: { valore: 1 } },
    };

    const tipi = riconosciTipi([originale]);
    const tornata = ripristinaTipi(
      JSON.parse(serializza(originale)) as Record<string, unknown>,
      tipi,
    );

    // Il BigInt è il motivo per cui la copia non può essere un JSON.stringify
    // e basta: 9007199254740993 non è rappresentabile come numero JavaScript,
    // e passando da Number diventerebbe 9007199254740992 senza un errore.
    expect(tornata.id).toBe(9007199254740993n);
    expect(tornata.createdAt).toBeInstanceOf(Date);
    expect((tornata.createdAt as Date).toISOString()).toBe('2026-08-31T04:15:00.000Z');
    expect(tornata.expiresAt).toBeNull();
    expect(tornata.payload).toEqual({ annidato: { valore: 1 } });
  });

  it('lascia stare i campi che il manifesto non elenca', () => {
    const riga = { createdAt: '2026-01-01T00:00:00.000Z' };
    expect(ripristinaTipi({ ...riga }, undefined)).toEqual(riga);
    expect(ripristinaTipi({ ...riga }, {})).toEqual(riga);
  });

  it('non trasforma una data illeggibile in una data sbagliata', () => {
    const tornata = ripristinaTipi({ createdAt: 'non una data' }, { createdAt: 'date' });
    expect(tornata.createdAt).toBe('non una data');
  });
});

describe('impronta della chiave di cifratura', () => {
  it('è stabile e non contiene la chiave', () => {
    const chiave = 'a'.repeat(64);
    const impronta = improntaChiave(chiave);
    expect(impronta).toBe(improntaChiave(chiave));
    expect(impronta).toHaveLength(16);
    expect(impronta).not.toContain(chiave);
    expect(chiave).not.toContain(impronta!);
  });

  it('cambia se cambia la chiave', () => {
    expect(improntaChiave('a'.repeat(64))).not.toBe(improntaChiave('b'.repeat(64)));
  });

  it('è nulla quando non c’è chiave: non si confronta ciò che non esiste', () => {
    expect(improntaChiave(undefined)).toBeNull();
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Posta,
  apriBusta,
  attendiEsito,
  inviaAlBot,
  leggiRisposta,
  scadenzaDi,
  scaduta,
  type RedisPosta,
} from '../posta.js';

/*
 * La posta sostituisce un pub/sub che perdeva i comandi senza dirlo. Le
 * proprietà da tenere sono poche e tutte decisive: il comando arriva nello
 * stream con quello che serve per eseguirlo, un doppione non si accoda due
 * volte, un comando vecchio si riconosce, e una voce rovinata non ferma la
 * coda.
 */

/** Redis finto: registra le chiamate e risponde da una mappa. */
function redisFinto() {
  const valori = new Map<string, string>();
  const chiamate: (string | number)[][] = [];
  const redis: RedisPosta & { valori: typeof valori; chiamate: typeof chiamate } = {
    valori,
    chiamate,
    async call(comando, ...args) {
      chiamate.push([comando, ...args]);
      if (comando === 'SET') {
        const [chiave, valore, nx] = args as string[];
        if (nx === 'NX' && valori.has(chiave!)) return null;
        valori.set(chiave!, valore!);
        return 'OK';
      }
      if (comando === 'XADD') return '1-0';
      return null;
    },
    async get(chiave) {
      return valori.get(chiave) ?? null;
    },
  };
  return redis;
}

describe('invio', () => {
  it('mette nello stream il comando, il momento e la scadenza', async () => {
    const redis = redisFinto();
    const consegna = await inviaAlBot(redis, { action: 'lockdown.enable', guildId: '1' });

    const xadd = redis.chiamate.find((c) => c[0] === 'XADD')!;
    expect(xadd[1]).toBe(Posta.stream);
    // Lo stream ha un tetto: senza, con il bot giù per giorni crescerebbe senza fine.
    expect(xadd).toContain('MAXLEN');

    const campi = xadd.slice(xadd.indexOf('*') + 1).map(String);
    const busta = apriBusta('1-0', campi);
    expect(busta.id).toBe(consegna.id);
    expect(busta.comando).toEqual({ action: 'lockdown.enable', guildId: '1' });
    expect(busta.scadenzaMs).toBe(scadenzaDi('lockdown.enable'));
    expect(Date.now() - busta.creatoIl).toBeLessThan(5_000);
  });

  it('dice se il bot era collegato', async () => {
    const redis = redisFinto();
    expect((await inviaAlBot(redis, { action: 'x', guildId: '1' })).botInLinea).toBe(false);
    redis.valori.set(Posta.pronto, '1');
    expect((await inviaAlBot(redis, { action: 'x', guildId: '1' })).botInLinea).toBe(true);
  });

  /*
   * Il worker ripete le scadenze ogni minuto. Con il bot giù, senza chiave,
   * lo stesso «chiudi il sondaggio» si accoderebbe sessanta volte all'ora.
   */
  it('con la chiave non accoda un doppione', async () => {
    const redis = redisFinto();
    const primo = await inviaAlBot(redis, { action: 'poll.close', guildId: '1' }, { chiave: 'p' });
    const secondo = await inviaAlBot(redis, { action: 'poll.close', guildId: '1' }, { chiave: 'p' });

    expect(redis.chiamate.filter((c) => c[0] === 'XADD')).toHaveLength(1);
    expect(secondo.doppione).toBe(true);
    expect(secondo.id).toBe(primo.id);
  });
});

describe('attesa dell’esito', () => {
  it('restituisce l’esito appena il bot lo scrive', async () => {
    const redis = redisFinto();
    setTimeout(() => {
      redis.valori.set(
        Posta.esito('abc'),
        JSON.stringify({ stato: 'fatto', messaggio: 'ok', guildId: '1', action: 'x', finitoIl: 1 }),
      );
    }, 120);
    const esito = await attendiEsito(redis, 'abc', 3_000);
    expect(esito?.stato).toBe('fatto');
  });

  it('smette di aspettare allo scadere, senza eccezioni', async () => {
    const inizio = Date.now();
    expect(await attendiEsito(redisFinto(), 'mai', 300)).toBeNull();
    expect(Date.now() - inizio).toBeLessThan(1_500);
  });
});

describe('lettura dal lato del bot', () => {
  it('una voce rovinata diventa un comando nullo, non un’eccezione', () => {
    // Tenerla significherebbe rileggerla a ogni riavvio, per sempre.
    expect(apriBusta('1-0', ['c', '{rotto']).comando).toBeNull();
    expect(apriBusta('1-0', ['c', '{"guildId":"1"}']).comando).toBeNull();
    expect(apriBusta('1-0', []).comando).toBeNull();
  });

  it('riconosce un comando scaduto', () => {
    const busta = apriBusta('1-0', ['c', '{"action":"a","guildId":"1"}', 't', '1000', 's', '500']);
    expect(scaduta(busta, 1_400)).toBe(false);
    expect(scaduta(busta, 1_600)).toBe(true);
  });

  it('legge la risposta di XREADGROUP, comprese le voci cancellate', () => {
    expect(leggiRisposta(null)).toEqual([]);
    const voci = leggiRisposta([[Posta.stream, [['1-0', ['c', '{}']], ['2-0', null]]]]);
    expect(voci).toEqual([
      { voce: '1-0', campi: ['c', '{}'] },
      { voce: '2-0', campi: [] },
    ]);
  });

  /*
   * La domanda che decide ogni scadenza: se arrivasse adesso, farebbe ancora
   * la cosa voluta? Un blocco consegnato ore dopo il raid no; una riapertura sì.
   */
  it('un lockdown scade prima della sua revoca', () => {
    expect(scadenzaDi('lockdown.enable')).toBeLessThan(scadenzaDi('lockdown.disable'));
    expect(scadenzaDi('lockdown.enable')).toBeLessThanOrEqual(5 * 60_000);
  });
});

/* ── Mittenti e destinatario parlano la stessa lingua? ─────────────────── */

const qui = path.dirname(fileURLToPath(import.meta.url));
const RADICE = path.resolve(qui, '../../../..');

function sorgenti(cartella: string): string[] {
  const out: string[] = [];
  for (const voce of readdirSync(cartella)) {
    if (voce === 'node_modules' || voce === 'dist' || voce === '__tests__') continue;
    const pieno = path.join(cartella, voce);
    if (statSync(pieno).isDirectory()) out.push(...sorgenti(pieno));
    else if (pieno.endsWith('.ts')) out.push(pieno);
  }
  return out;
}

/** Le azioni mandate con `inviaAlBot` o `sendBotCommand` in una cartella. */
function azioniMandate(cartella: string): Set<string> {
  const trovate = new Set<string>();
  for (const file of sorgenti(cartella)) {
    const testo = readFileSync(file, 'utf8');
    if (!/inviaAlBot|sendBotCommand/.test(testo)) continue;
    for (const m of testo.matchAll(/action:\s*'([a-z]+\.[a-z]+)'/g)) trovate.add(m[1]!);
  }
  return trovate;
}

describe('coerenza fra chi manda e chi esegue', () => {
  const schema = readFileSync(path.join(RADICE, 'apps/bot/src/core/panelCommands.ts'), 'utf8');
  const conosciute = new Set(
    [...schema.matchAll(/z\.literal\('([a-z]+\.[a-z]+)'\)/g)].map((m) => m[1]!),
  );

  /*
   * Un'azione mandata e non conosciuta dal bot arriva, viene rifiutata come
   * «comando non riconosciuto», e chi l'ha mandata — il worker, di notte —
   * non lo scopre mai. È la stessa forma dei guasti già capitati qui: un
   * elenco scritto due volte in file diversi.
   */
  it('ogni azione mandata esiste nello schema del bot', () => {
    const mandate = new Set([
      ...azioniMandate(path.join(RADICE, 'apps/api/src')),
      ...azioniMandate(path.join(RADICE, 'apps/worker/src')),
      ...azioniMandate(path.join(RADICE, 'apps/twitch/src')),
    ]);

    // La controprova: senza, una lettura sbagliata farebbe passare tutto.
    expect(mandate.size, 'nessuna azione trovata nei mittenti').toBeGreaterThan(10);
    expect(conosciute.has('lockdown.enable')).toBe(true);

    const sconosciute = [...mandate].filter((azione) => !conosciute.has(azione));
    expect(sconosciute, 'azioni mandate che il bot non conosce').toEqual([]);
  });

  it('nessuno usa più il vecchio canale pub/sub dei comandi', () => {
    const colpevoli = ['apps/api/src', 'apps/worker/src', 'apps/twitch/src', 'apps/bot/src']
      .flatMap((cartella) => sorgenti(path.join(RADICE, cartella)))
      .filter((file) => readFileSync(file, 'utf8').includes('aegis:command'));
    expect(colpevoli).toEqual([]);
  });
});

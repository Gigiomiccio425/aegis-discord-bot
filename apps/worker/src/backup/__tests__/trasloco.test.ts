import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GRUPPI, componiTesto, estraiPassword } from '../trasloco.js';
import type { Manifesto } from '../formato.js';

const qui = path.dirname(fileURLToPath(import.meta.url));
const ENV = path.resolve(qui, '../../../../../packages/shared/src/env.ts');

/* ── Il kit copre davvero tutto quello che serve ───────────────────────── */

/**
 * Variabili che di proposito non finiscono nel kit, con il motivo.
 *
 * Chi ne aggiunge una a `env.ts` deve decidere qui se vada riportata sulla
 * macchina nuova. Il modo in cui un trasloco fallisce non è con un errore: è
 * con una variabile dimenticata, scoperta il giorno dopo quando un pezzo del
 * bot non funziona e nessuno sa perché.
 */
const FUORI_APPOSTA: Record<string, string> = {
  // La imposta l'immagine, non chi installa.
  NODE_ENV: 'la scrive il Dockerfile',
  // Servono solo a chi sviluppa in locale: su una macchina di produzione non
  // esistono, e stamparle nel kit suggerirebbe di impostarle.
  DEV_GUILD_ID: 'solo per lo sviluppo',
  WEB_DEV_ORIGIN: 'solo per lo sviluppo',
  /*
   * L'unica esclusione che è una decisione di sicurezza e non una comodità.
   *
   * È la chiave temporanea che apre la rotta per ottenere i token dell'account
   * bot di Twitch. Serve dieci minuti, una volta sola, e va tolta subito dopo:
   * portarsela dietro in un trasloco significherebbe riaprire sulla macchina
   * nuova una porta che era stata chiusa apposta sulla vecchia.
   */
  TWITCH_SETUP_KEY: 'chiave temporanea: non deve sopravvivere a un trasloco',
};

/**
 * Ogni variabile letta da qualche parte nel codice.
 *
 * Il test qui sotto guardava solo `env.ts`, e la premessa — «lo schema è
 * l'elenco di tutte le variabili» — a un certo punto ha smesso di essere
 * vera: le credenziali dell'account bot di Twitch sono arrivate leggendo
 * `process.env` direttamente, e il kit di trasloco non se ne è accorto. Un
 * trasloco le avrebbe lasciate indietro, e il sintomo sulla macchina nuova
 * sarebbe stato un bot Twitch spento senza che nulla dicesse perché.
 *
 * Adesso si guarda anche il sorgente. Meno preciso di uno schema — un nome
 * costruito a pezzi sfugge — e copre il caso che si è già verificato.
 */
function variabiliNelSorgente(): string[] {
  const trovate = new Set<string>();

  const visita = (cartella: string): void => {
    for (const voce of readdirSync(cartella, { withFileTypes: true })) {
      const percorso = path.join(cartella, voce.name);
      if (voce.isDirectory()) {
        if (voce.name === 'node_modules' || voce.name === 'dist' || voce.name === '__tests__') {
          continue;
        }
        visita(percorso);
        continue;
      }
      if (!voce.name.endsWith('.ts')) continue;

      const sorgente = readFileSync(percorso, 'utf8');
      for (const trovato of sorgente.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        trovate.add(trovato[1]!);
      }
    }
  };

  const radice = path.resolve(qui, '../../../../..');
  for (const gruppo of ['apps', 'packages']) {
    for (const progetto of readdirSync(path.join(radice, gruppo), { withFileTypes: true })) {
      if (!progetto.isDirectory()) continue;
      const src = path.join(radice, gruppo, progetto.name, 'src');
      try {
        visita(src);
      } catch {
        /* progetto senza src: niente da guardare */
      }
    }
  }

  return [...trovate];
}

/**
 * Variabili che il programma si imposta da solo.
 *
 * Non le scrive nessuno nel compose: le mette la CI dentro l'immagine, o il
 * supervisore all'avvio per parlare con i propri processi. Riportarle in un
 * trasloco non avrebbe senso, e nel file dei valori sarebbero rumore in mezzo
 * a quelli che invece vanno copiati a mano.
 */
const INTERNE = new Set([
  'ANGEL_VERSION',
  'ANGEL_MODE',
  'ANGEL_DEGRADATO',
  'BACKUP_ON_START',
  'RESTORE_FROM',
  'RESTORE_OVERWRITE',
  'RESTORE_SKIP_STORAGE',
  'RESTORE_ACCEPT_KEY_MISMATCH',
]);

describe('variabili elencate nel kit', () => {
  const chiavi = [...readFileSync(ENV, 'utf8').matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map(
    (trovato) => trovato[1]!,
  );

  const elencate = new Set(GRUPPI.flatMap((gruppo) => gruppo.nomi));

  it('env.ts dichiara le variabili da cui partire', () => {
    expect(chiavi).toContain('ENCRYPTION_KEY');
    expect(chiavi.length).toBeGreaterThan(15);
  });

  it('ogni variabile di env.ts è nel kit, o è esclusa di proposito', () => {
    const dimenticate = chiavi.filter((chiave) => !elencate.has(chiave) && !FUORI_APPOSTA[chiave]);
    expect(dimenticate).toEqual([]);
  });

  /*
   * Lo stesso controllo, ma partendo dal codice invece che dallo schema.
   *
   * È quello che avrebbe fermato il buco vero: `TWITCH_BOT_ACCESS_TOKEN` non
   * compariva in `env.ts`, quindi il test precedente non aveva niente da
   * confrontare e passava.
   */
  it('ogni variabile letta nel codice è nel kit, o è esclusa di proposito', () => {
    const lette = variabiliNelSorgente();

    /*
     * La controprova.
     *
     * Una scansione che non trova niente passa sempre, e passerebbe anche con
     * il percorso della cartella sbagliato — dando la stessa tranquillità di
     * un controllo vero senza controllare nulla. Prima di fidarsi delle
     * risposte si verifica che il rilevatore veda qualcosa che c'è.
     */
    expect(lette.length, 'la scansione del sorgente non trova niente').toBeGreaterThan(15);
    expect(lette).toContain('ENCRYPTION_KEY');
    expect(lette).toContain('TWITCH_PUBLIC_URL');

    const dimenticate = lette.filter(
      (chiave) => !elencate.has(chiave) && !FUORI_APPOSTA[chiave] && !INTERNE.has(chiave),
    );
    expect(dimenticate).toEqual([]);
  });

  it('nessuna variabile compare in due gruppi diversi', () => {
    const tutte = GRUPPI.flatMap((gruppo) => gruppo.nomi);
    expect(new Set(tutte).size).toBe(tutte.length);
  });

  it('la chiave di cifratura sta nel gruppo che dice di non toccarla', () => {
    const primo = GRUPPI[0]!;
    expect(primo.titolo).toContain('IDENTICHE');
    expect(primo.nomi).toContain('ENCRYPTION_KEY');
    expect(primo.segrete).toBe(true);
  });
});

/* ── La password del database ──────────────────────────────────────────── */

describe('password estratta da DATABASE_URL', () => {
  it('la trova in un URL normale', () => {
    expect(estraiPassword('postgresql://aegis:segreta123@aegis-postgres:5432/aegis')).toBe(
      'segreta123',
    );
  });

  it('decodifica i caratteri percentuali', () => {
    // Una password con `@` o `/` dentro va per forza codificata nell'URL, e
    // ricopiarla codificata in POSTGRES_PASSWORD è il modo tipico per
    // ritrovarsi Postgres che rifiuta l'autenticazione senza spiegare quale
    // delle due copie sia quella buona.
    expect(estraiPassword('postgresql://aegis:pa%40ss%2Fword@host:5432/db')).toBe('pa@ss/word');
  });

  it('non inventa niente quando la password non c’è', () => {
    expect(estraiPassword('postgresql://aegis@host:5432/db')).toBeNull();
    expect(estraiPassword('non un url')).toBeNull();
    expect(estraiPassword(undefined)).toBeNull();
  });
});

/* ── Il file di testo ──────────────────────────────────────────────────── */

const MANIFESTO: Manifesto = {
  prodottoDa: 'ANGEL',
  versione: '1.24.0',
  quando: '2026-08-31T04:15:00.000Z',
  righe: { guild: 2, auditEvent: 15000 },
  totaleRighe: 15002,
  errori: [],
  tipi: {},
  archivio: { incluso: true, file: 120, byte: 5_000_000 },
  improntaChiave: 'abcdef0123456789',
  schema: { tabelle: 27 },
};

const SERVER = [{ id: '1272925031764328471', name: 'Prova', memberCount: 42, active: true }];

const TOKEN = 'MTIzNDU2Nzg5.SEGRETISSIMO.abcdefghijklmnop';
const CHIAVE = 'f'.repeat(64);

describe('TRASLOCO.txt', () => {
  const prima = { ...process.env };

  beforeEach(() => {
    process.env.DISCORD_TOKEN = TOKEN;
    process.env.ENCRYPTION_KEY = CHIAVE;
    process.env.DATABASE_URL = 'postgresql://aegis:passwordDelDb@aegis-postgres:5432/aegis';
    process.env.PUBLIC_URL = 'http://192.168.1.50:780';
  });

  afterEach(() => {
    process.env = { ...prima };
  });

  it('con i segreti scrive i valori veri', async () => {
    const testo = await componiTesto({
      manifesto: MANIFESTO,
      server: SERVER,
      impronte: { 'dati.tar.gz': { sha: 'a'.repeat(64), byte: 1024 } },
      conSegreti: true,
      nomeCartella: 'trasloco-2026-08-31T04-15-00',
    });

    expect(testo).toContain(TOKEN);
    expect(testo).toContain(CHIAVE);
    expect(testo).toContain('passwordDelDb');
    // La password del database va scritta in due punti che devono coincidere:
    // il kit li produce tutti e due invece di lasciarli ricopiare a mano.
    expect(testo).toContain("POSTGRES_PASSWORD: 'passwordDelDb'");
  });

  /*
   * Il test di sicurezza vero.
   *
   * «Senza segreti» deve significare che il file si può mandare a chiunque.
   * Basta un punto in cui il valore viene stampato lo stesso — il blocco da
   * incollare, per esempio — perché l'opzione dia una falsa tranquillità, che
   * è peggio del non averla.
   */
  it('senza segreti non lascia trapelare nessun valore', async () => {
    const testo = await componiTesto({
      manifesto: MANIFESTO,
      server: SERVER,
      impronte: {},
      conSegreti: false,
      nomeCartella: 'trasloco-2026-08-31T04-15-00',
    });

    expect(testo).not.toContain(TOKEN);
    expect(testo).not.toContain(CHIAVE);
    expect(testo).not.toContain('passwordDelDb');
    expect(testo).toContain('XXXXX');
    // I nomi restano, così si sa cosa andare a cercare.
    expect(testo).toContain('DISCORD_TOKEN');
  });

  it('anche senza segreti dice se hai riportato il valore giusto', async () => {
    const testo = await componiTesto({
      manifesto: MANIFESTO,
      server: SERVER,
      impronte: {},
      conSegreti: false,
      nomeCartella: 'trasloco-2026-08-31T04-15-00',
    });

    // L'impronta della chiave c'è sempre: è quella che il ripristino confronta,
    // ed è l'unico modo di accorgersi di aver rimesso la chiave sbagliata prima
    // che le integrazioni smettano di funzionare in silenzio.
    expect(testo).toContain(MANIFESTO.improntaChiave!.slice(0, 8));
  });

  it('elenca i server e i conteggi da ritrovare dopo', async () => {
    const testo = await componiTesto({
      manifesto: MANIFESTO,
      server: SERVER,
      impronte: {},
      conSegreti: true,
      nomeCartella: 'trasloco-2026-08-31T04-15-00',
    });

    expect(testo).toContain('1272925031764328471');
    expect(testo).toContain('Prova');
    expect(testo).toContain('auditEvent');
  });

  it('mette il nome della cartella dentro la riga RESTORE_FROM', async () => {
    const testo = await componiTesto({
      manifesto: MANIFESTO,
      server: [],
      impronte: {},
      conSegreti: true,
      nomeCartella: 'trasloco-2026-08-31T04-15-00',
    });

    expect(testo).toContain('RESTORE_FROM: /backup/trasloco-2026-08-31T04-15-00');
  });

  it('avvisa quando l’archivio dei file non è nella copia', async () => {
    const testo = await componiTesto({
      manifesto: {
        ...MANIFESTO,
        archivio: { incluso: false, file: 0, byte: 0, motivo: 'oltre il limite' },
      },
      server: [],
      impronte: {},
      conSegreti: true,
      nomeCartella: 'trasloco-2026-08-31T04-15-00',
    });

    expect(testo).toContain('oltre il limite');
    expect(testo).toMatch(/allegati e trascrizioni/i);
  });
});

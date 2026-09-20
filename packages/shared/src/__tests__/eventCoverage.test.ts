import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EVENT_CATEGORY,
  EVENTI_MINACCIA,
  EVENTI_RISPOSTA,
  LogEventType,
} from '../types/events.js';

/* ═══════════════════════════════════════════════════════════════════════
   COPERTURA DEL REGISTRO

   Il catalogo degli eventi è una promessa: se un tipo è dichiarato, il pannello
   lo offre come filtro e chi amministra si aspetta di trovarlo. Un tipo mai
   emesso è un filtro che non restituisce nulla per sempre, senza che nessuno
   capisca perché.

   Questo test scandisce il codice sorgente e verifica che ogni tipo dichiarato
   compaia da qualche parte come evento emesso. Non prova che l'evento venga
   emesso *nel momento giusto* — quello richiede un test di integrazione — ma
   impedisce il caso più comune: dichiarare un tipo e dimenticarsi di usarlo.
   ═══════════════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

const SOURCE_DIRS = [
  path.join(ROOT, 'apps', 'bot', 'src'),
  path.join(ROOT, 'apps', 'api', 'src'),
  path.join(ROOT, 'apps', 'worker', 'src'),
];

function collectSources(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
      collectSources(full, files);
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const sources = SOURCE_DIRS.flatMap((dir) => collectSources(dir));
const haystack = sources.map((file) => readFileSync(file, 'utf8')).join('\n');

describe('copertura del catalogo eventi', () => {
  it('trova i file sorgente da analizzare', () => {
    // Se il test non trova nulla, i controlli successivi passerebbero a vuoto.
    expect(sources.length).toBeGreaterThan(30);
  });

  it('ogni tipo di evento dichiarato viene emesso da qualche parte', () => {
    const declared = LogEventType.options;
    const missing = declared.filter((type) => !haystack.includes(`'${type}'`));

    expect(
      missing,
      missing.length > 0
        ? `Tipi dichiarati ma mai emessi: ${missing.join(', ')}. ` +
            'Un tipo mai emesso è un filtro vuoto nel pannello: o lo si implementa, o lo si toglie dal catalogo.'
        : '',
    ).toEqual([]);
  });

  it('ogni tipo dichiarato ha una categoria', () => {
    const orphans = LogEventType.options.filter((type) => !EVENT_CATEGORY[type]);
    expect(orphans).toEqual([]);
  });

  it('non ci sono categorie assegnate a tipi inesistenti', () => {
    const declared = new Set<string>(LogEventType.options);
    const extra = Object.keys(EVENT_CATEGORY).filter((type) => !declared.has(type));
    expect(extra).toEqual([]);
  });
});

/*
 * MINACCE E RISPOSTE
 *
 * Il contatore della dashboard diceva «512 minacce oggi» e le minacce erano
 * zero: contava tutta la categoria `SECURITY`, dentro cui stanno anche gli
 * snapshot che ANGEL si fa da solo. Un numero che parte da cinquecento e sale
 * per conto suo non fa notare niente.
 *
 * Adesso le due liste lo decidono. Il guasto che questo test impedisce è che
 * un tipo nuovo non finisca in nessuna delle due: non darebbe errore, e
 * sparirebbe dal conteggio in silenzio — cioè una minaccia che non si vede.
 */
describe('minacce e risposte', () => {
  const sicurezza = LogEventType.options.filter(
    (tipo) => EVENT_CATEGORY[tipo] === 'SECURITY',
  );

  it('ogni evento di sicurezza è o una minaccia o una risposta', () => {
    const classificati = new Set<string>([...EVENTI_MINACCIA, ...EVENTI_RISPOSTA]);

    // La controprova: senza, una lettura sbagliata non troverebbe nessun
    // evento e il test passerebbe su un insieme vuoto.
    expect(sicurezza.length, 'nessun evento di sicurezza letto').toBeGreaterThan(10);

    const senzaPosto = sicurezza.filter((tipo) => !classificati.has(tipo));
    expect(senzaPosto, 'eventi di sicurezza non classificati').toEqual([]);
  });

  it('nessun evento sta in tutte e due le liste', () => {
    const doppi = EVENTI_MINACCIA.filter((tipo) =>
      (EVENTI_RISPOSTA as readonly string[]).includes(tipo),
    );
    expect(doppi, 'contato due volte').toEqual([]);
  });

  /*
   * Le liste contengono solo nomi di eventi che esistono davvero. Un refuso
   * qui non darebbe errore: quel tipo semplicemente non verrebbe mai contato.
   */
  it('le due liste non nominano eventi inesistenti', () => {
    const esistenti = new Set<string>(LogEventType.options);
    const fantasmi = [...EVENTI_MINACCIA, ...EVENTI_RISPOSTA].filter(
      (tipo) => !esistenti.has(tipo),
    );
    expect(fantasmi, 'nomi che non corrispondono a nessun evento').toEqual([]);
  });

  it('gli snapshot non sono minacce', () => {
    // Il caso preciso da cui nasce tutto questo.
    expect(EVENTI_MINACCIA as readonly string[]).not.toContain('SECURITY_SNAPSHOT_CREATED');
    expect(EVENTI_RISPOSTA as readonly string[]).toContain('SECURITY_SNAPSHOT_CREATED');
  });
});

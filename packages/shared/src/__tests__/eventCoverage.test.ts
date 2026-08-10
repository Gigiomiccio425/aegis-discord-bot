import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_CATEGORY, LogEventType } from '../types/events.js';

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

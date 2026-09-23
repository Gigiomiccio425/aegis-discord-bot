import { describe, expect, it } from 'vitest';
import { defaultGuildConfig, describeField, MODULE_REGISTRY, SECTION_DOCS } from '@angel/shared';
import {
  cerca,
  normalizza,
  preparaIndice,
  vociConfigurazione,
  vociPagine,
  type Descrittori,
  type VoceRicerca,
} from '../ricerca.js';
import { SEZIONE_GENERALE } from '../sezioni.js';

/* ═══════════════════════════════════════════════════════════════════════
   LA RICERCA TROVA, E PORTA AL POSTO GIUSTO

   Due promesse. La prima: quello che la pagina della configurazione mostra
   si trova anche cercandolo, con le stesse parole. La seconda: il risultato
   porta alla sezione e al campo, non alla pagina in generale.

   Le prove girano sulla configurazione predefinita e sulle descrizioni vere:
   un test su dati inventati direbbe che la ricerca funziona su dati
   inventati.
   ═══════════════════════════════════════════════════════════════════════ */

const descrittori: Descrittori = {
  campo: describeField,
  sezione: (chiave) => SECTION_DOCS[chiave],
};
const sezioni = [SEZIONE_GENERALE, ...MODULE_REGISTRY];
const config = defaultGuildConfig() as unknown as Record<string, unknown>;
const voci = [...vociPagine(), ...vociConfigurazione(config, sezioni, descrittori)];
const indice = preparaIndice(voci);

function primo(domanda: string): VoceRicerca | undefined {
  return cerca(indice, domanda)[0]?.voce;
}

describe('normalizza', () => {
  it('ignora accenti, maiuscole e punteggiatura', () => {
    expect(normalizza('Modalità  Prova')).toBe('modalita prova');
    expect(normalizza('Anti-Raid')).toBe('anti raid');
    expect(normalizza('  perché?  ')).toBe('perche');
  });
});

describe('indice', () => {
  it('ha una voce per ogni sezione e per ogni campo, senza doppioni', () => {
    const id = voci.map((voce) => voce.id);
    expect(new Set(id).size).toBe(id.length);
    for (const sezione of sezioni) {
      expect(id).toContain(`sezione:${sezione.key}`);
    }
    expect(id).toContain('campo:security.antiRaid.enabled');
    expect(id).toContain('campo:general.dryRun');
  });

  it('non entra negli elementi degli elenchi', () => {
    expect(voci.some((voce) => /\.\d+(\.|$)/.test(voce.id))).toBe(false);
  });

  it('porta ogni campo alla sua sezione e a sé stesso', () => {
    const campo = voci.find((voce) => voce.id === 'campo:security.antiRaid.autoLiftAfterSec');
    expect(campo?.destinazione).toBe(
      'impostazioni?sezione=security.antiRaid&campo=security.antiRaid.autoLiftAfterSec',
    );
    expect(campo?.dove).toBe('Configurazione › Anti-Raid');
  });

  it('dice il percorso dei campi annidati con le etichette, non con i nomi tecnici', () => {
    const annidato = voci.find((voce) => voce.id === 'campo:security.antiRaid.clustering.windowSec');
    expect(annidato?.dove.startsWith('Configurazione › Anti-Raid › ')).toBe(true);
    expect(annidato?.dove).not.toContain('clustering');
  });
});

describe('cerca', () => {
  it('trova un campo dalla sua etichetta', () => {
    expect(primo('revoca automatica')?.id).toBe('campo:security.antiRaid.autoLiftAfterSec');
  });

  it('trova senza accenti quello che ha gli accenti', () => {
    expect(primo('modalita prova')?.id).toBe('campo:general.dryRun');
  });

  it('trova una pagina da una parola che non è il suo nome', () => {
    const risultati = cerca(indice, 'lockdown').map((risultato) => risultato.voce.id);
    expect(risultati).toContain('pagina:');
  });

  it('trova una sezione dal suo nome', () => {
    expect(primo('anti nuke')?.id).toBe('sezione:security.antiNuke');
  });

  it('quando una voce ha tutte le parole, mostra solo quelle', () => {
    const prova = preparaIndice([
      { id: 'solo', tipo: 'impostazione', titolo: 'Soglia', dove: 'X', destinazione: 's' },
      { id: 'tutte', tipo: 'impostazione', titolo: 'Soglia degli ingressi', dove: 'X', destinazione: 't' },
    ]);
    const risultati = cerca(prova, 'soglia ingressi');
    expect(risultati.map((risultato) => risultato.voce.id)).toEqual(['tutte']);
    expect(risultati[0]?.parziale).toBe(false);
  });

  // Controprova della regola qui sopra: senza nessuna voce completa non
  // resta il vuoto, restano le più vicine — e sono dichiarate parziali.
  it('se nessuna voce le ha tutte, mostra le più vicine e lo dice', () => {
    const risultati = cerca(indice, 'revoca automatica zzzz');
    expect(risultati[0]?.voce.id).toBe('campo:security.antiRaid.autoLiftAfterSec');
    expect(risultati.every((risultato) => risultato.parziale)).toBe(true);
  });

  it('trova i campi anche dal nome del loro gruppo', () => {
    const ids = cerca(indice, 'ondata ingressi').map((risultato) => risultato.voce.id);
    expect(ids).toContain('campo:security.antiRaid.joinBurst.count');
  });

  it('una parola che non c’è da nessuna parte non restituisce niente', () => {
    expect(cerca(indice, 'zzzzqq')).toEqual([]);
  });

  it('una ricerca vuota non restituisce niente', () => {
    expect(cerca(indice, '   ')).toEqual([]);
  });

  // Il peso del titolo, provato su voci costruite apposta: con i dati veri
  // l'ordine dipende da descrizioni che cambiano.
  it('mette prima il titolo, poi le parole chiave, poi la spiegazione', () => {
    const prova = preparaIndice([
      { id: 'c', tipo: 'impostazione', titolo: 'Canale', descrizione: 'Dove va la soglia', dove: 'X', destinazione: 'c' },
      { id: 'b', tipo: 'impostazione', titolo: 'Altro', parole: ['soglia'], dove: 'X', destinazione: 'b' },
      { id: 'a', tipo: 'impostazione', titolo: 'Soglia degli ingressi', dove: 'X', destinazione: 'a' },
    ]);
    expect(cerca(prova, 'soglia').map((risultato) => risultato.voce.id)).toEqual(['a', 'b', 'c']);
  });

  it('a parità, il titolo identico vince su quello che lo contiene', () => {
    const prova = preparaIndice([
      { id: 'lungo', tipo: 'impostazione', titolo: 'Soglia di ostilità', dove: 'X', destinazione: 'l' },
      { id: 'esatto', tipo: 'impostazione', titolo: 'Soglia', dove: 'X', destinazione: 'e' },
    ]);
    expect(cerca(prova, 'soglia')[0]?.voce.id).toBe('esatto');
  });

  // Controprova: il pezzo di parola corto non pesca a caso dentro le parole.
  it('due lettere cercano solo l’inizio delle parole', () => {
    const prova = preparaIndice([
      { id: 'dentro', tipo: 'impostazione', titolo: 'Straordinario', dove: 'X', destinazione: 'd' },
      { id: 'inizio', tipo: 'impostazione', titolo: 'Ragione', dove: 'X', destinazione: 'i' },
    ]);
    expect(cerca(prova, 'ra').map((risultato) => risultato.voce.id)).toEqual(['inizio']);
  });
});

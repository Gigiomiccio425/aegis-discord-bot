import { describe, expect, it } from 'vitest';
import { commands, commandMap, commandsDaRegistrare } from '../index.js';

/*
 * Gli pseudonimi inglesi sono lo stesso comando con un altro nome. Le cose che
 * possono andare storte sono tre, tutte silenziose: un nome inglese che
 * coincide con un comando italiano già esistente (Discord rifiuta l'intera
 * registrazione, quindi spariscono *tutti* i comandi), un nome che Discord non
 * accetta per forma, e il superamento del limite di cento comandi per server.
 */

describe('pseudonimi inglesi', () => {
  it('non collidono con i nomi italiani', () => {
    const italiani = new Set(commands.map((command) => command.data.name));
    const alias = commandsDaRegistrare.filter((command) => !italiani.has(command.data.name));

    expect(alias.length).toBeGreaterThan(10);
    for (const voce of alias) {
      expect(italiani.has(voce.data.name), `${voce.data.name} esiste già in italiano`).toBe(false);
    }
  });

  it('non registra due volte lo stesso nome', () => {
    const nomi = commandsDaRegistrare.map((command) => command.data.name);
    expect(new Set(nomi).size).toBe(nomi.length);
  });

  it('rispettano la forma che Discord accetta', () => {
    // Minuscolo, senza spazi, 1-32 caratteri: un nome fuori norma fa fallire
    // la registrazione di tutto l'elenco, non solo della voce sbagliata.
    for (const command of commandsDaRegistrare) {
      expect(command.data.name).toMatch(/^[-_\p{Ll}\p{Lm}\p{Lo}\p{N}]{1,32}$/u);
    }
  });

  it('restano sotto il limite di cento comandi per server', () => {
    expect(commandsDaRegistrare.length).toBeLessThan(100);
  });

  it('puntano alla stessa funzione dell-originale', () => {
    // È il punto di tutta la costruzione: nessuna logica duplicata, quindi
    // `/ban` cambia quando cambia `/bandisci`.
    const italiano = commands.find((command) => command.data.name === 'bandisci');
    const inglese = commandMap.get('ban');

    expect(italiano).toBeDefined();
    expect(inglese).toBeDefined();
    expect(inglese!.execute).toBe(italiano!.execute);
  });

  it('conservano le opzioni del comando originale', () => {
    const italiano = commands.find((command) => command.data.name === 'bandisci')!;
    const inglese = commandMap.get('ban')!;

    const opzioniItaliane = (italiano.data.toJSON() as { options?: unknown[] }).options ?? [];
    const opzioniInglesi = (inglese.data.toJSON() as { options?: unknown[] }).options ?? [];

    expect(opzioniInglesi).toEqual(opzioniItaliane);
  });
});

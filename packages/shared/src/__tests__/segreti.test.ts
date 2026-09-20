import { describe, expect, it } from 'vitest';
import { applicaSegreti, leggiSegreti } from '../segreti.js';

/*
 * I SEGRETI FUORI DAL COMPOSE
 *
 * Su umbrelOS il compose dell'app viene riscritto dal repository a ogni
 * aggiornamento: i valori messi a mano spariscono, e finché non si rimettono
 * il bot gira senza collegarsi. Il file dei segreti sta dentro i dati
 * dell'app e sopravvive.
 *
 * Quello che si sbaglia scrivendo un file del genere è sempre lo stesso: una
 * password con dentro un `=`, o un `#`, o le virgolette. Un valore troncato
 * non dà errore — dà un'autenticazione che fallisce e nessun indizio.
 */

describe('lettura del file dei segreti', () => {
  it('legge le righe normali', () => {
    const valori = leggiSegreti('DISCORD_TOKEN=abc.def\nOWNER_IDS=1,2,3\n');
    expect(valori.get('DISCORD_TOKEN')).toBe('abc.def');
    expect(valori.get('OWNER_IDS')).toBe('1,2,3');
  });

  it('tiene il segno di uguale dentro il valore', () => {
    // Una password troncata a metà non dà errore: dà un'autenticazione che
    // fallisce e nessuno che sappia perché.
    expect(leggiSegreti('POSTGRES_PASSWORD=ab=cd==').get('POSTGRES_PASSWORD')).toBe('ab=cd==');
  });

  it('salta righe vuote e commenti', () => {
    expect([...leggiSegreti('\n# un commento\n  # indentato\nA=1\n').keys()]).toEqual(['A']);
  });

  it('accetta export davanti, come in una shell', () => {
    expect(leggiSegreti('export SESSION_SECRET=xyz').get('SESSION_SECRET')).toBe('xyz');
  });

  it('toglie le virgolette, e dentro gli apici non interpreta niente', () => {
    expect(leggiSegreti('A="con spazi"').get('A')).toBe('con spazi');
    expect(leggiSegreti("B='n\\napri'").get('B')).toBe('n\\napri');
    expect(leggiSegreti('C="riga\\nriga"').get('C')).toBe('riga\nriga');
  });

  it('un cancelletto dopo uno spazio è un commento, attaccato no', () => {
    expect(leggiSegreti('A=segreto # quella vecchia').get('A')).toBe('segreto');
    // Un `#` dentro una password generata è frequente: toglierlo la romperebbe.
    expect(leggiSegreti('B=segre#to').get('B')).toBe('segre#to');
    expect(leggiSegreti('C="con # dentro"').get('C')).toBe('con # dentro');
  });

  it('ignora le righe che non sono assegnazioni', () => {
    expect([...leggiSegreti('questa riga no\n=1\n2NOME=x\nVALIDO=x\n').keys()]).toEqual(['VALIDO']);
  });

  it('legge un file scritto su Windows', () => {
    expect(leggiSegreti('A=1\r\nB=2\r\n').get('B')).toBe('2');
  });
});

describe('applicazione all’ambiente', () => {
  /*
   * Il file vince sul compose, e deve: al contrario, i segnaposto riscritti
   * dall'aggiornamento continuerebbero a vincere sul file — cioè il guasto
   * che questo meccanismo esiste per togliere.
   */
  it('il file vince su quello che c’è già', () => {
    const ambiente: Record<string, string | undefined> = {
      DISCORD_TOKEN: 'METTI_QUI_IL_TOKEN',
      ALTRO: 'resta',
    };
    const esito = applicaSegreti('DISCORD_TOKEN=quello-vero\n', ambiente);

    expect(esito.nomi).toEqual(['DISCORD_TOKEN']);
    expect(ambiente.DISCORD_TOKEN).toBe('quello-vero');
    expect(ambiente.ALTRO).toBe('resta');
  });

  it('dice cosa resta da compilare, segnaposto compresi', () => {
    const ambiente: Record<string, string | undefined> = {
      SESSION_SECRET: 'METTI_QUI_openssl_rand_hex_32',
      DATABASE_URL: 'postgresql://angel:x@postgres:5432/angel',
    };
    const esito = applicaSegreti('DISCORD_TOKEN=abc\n', ambiente);

    expect(esito.mancanti).toContain('SESSION_SECRET');
    expect(esito.mancanti).toContain('ENCRYPTION_KEY');
    expect(esito.mancanti).not.toContain('DISCORD_TOKEN');
    expect(esito.mancanti).not.toContain('DATABASE_URL');
  });

  it('senza niente da leggere non tocca l’ambiente', () => {
    const ambiente: Record<string, string | undefined> = { A: '1' };
    expect(applicaSegreti('', ambiente).nomi).toEqual([]);
    expect(ambiente.A).toBe('1');
  });
});

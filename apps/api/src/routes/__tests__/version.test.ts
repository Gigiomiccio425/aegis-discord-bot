import { describe, expect, it } from 'vitest';
import { isNewer } from '../version.js';

describe('confronto di versioni', () => {
  it('riconosce una versione più recente', () => {
    expect(isNewer('v1.2.0', 'v1.1.9')).toBe(true);
    expect(isNewer('v2.0.0', 'v1.99.99')).toBe(true);
  });

  it('non segnala aggiornamenti verso il passato o verso se stessa', () => {
    expect(isNewer('v1.1.0', 'v1.2.0')).toBe(false);
    expect(isNewer('v1.2.3', 'v1.2.3')).toBe(false);
  });

  it('confronta i numeri e non le stringhe', () => {
    // Il caso che rende inutile un confronto lessicografico: '1.10.0' < '1.9.0'
    // come stringhe, mentre è la versione successiva.
    expect(isNewer('v1.10.0', 'v1.9.0')).toBe(true);
  });

  it('tollera il prefisso v mancante e i segmenti assenti', () => {
    expect(isNewer('1.3', 'v1.2.9')).toBe(true);
    expect(isNewer('v1.2', 'v1.2.0')).toBe(false);
  });

  it('ignora il suffisso di prerelease', () => {
    expect(isNewer('v1.3.0-rc.1', 'v1.2.0')).toBe(true);
  });
});

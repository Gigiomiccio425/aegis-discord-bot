import { describe, expect, it } from 'vitest';
import { virgoletteSugliId } from '../util/json.js';

/**
 * Il caso che ha dato origine a questa funzione: un elenco di streamer
 * incollato con gli ID copiati da Discord, cioè numeri nudi. Senza correzione
 * il salvataggio veniva rifiutato — e se non lo fosse stato, avrebbe salvato
 * un ID diverso da quello incollato.
 */
describe('virgoletteSugliId', () => {
  it('mette fra virgolette gli ID e li lascia esatti', () => {
    const testo = '{"announceChannelId": 1272925031764328471}';
    const parsed = JSON.parse(virgoletteSugliId(testo)) as { announceChannelId: string };

    expect(parsed.announceChannelId).toBe('1272925031764328471');
    // La prova che la correzione serve: letto come numero, l'ID cambia.
    expect(String((JSON.parse(testo) as { announceChannelId: number }).announceChannelId)).not.toBe(
      '1272925031764328471',
    );
  });

  it('non tocca i numeri veri della configurazione', () => {
    const testo = '{"cooldownMinutes": 20, "clipMinViews": 40, "soglia": 0.5, "grande": 1e18}';
    expect(virgoletteSugliId(testo)).toBe(testo);
  });

  it('non tocca le cifre dentro le stringhe', () => {
    const testo = '{"template": "diretta 12345678901234567890 in corso"}';
    expect(virgoletteSugliId(testo)).toBe(testo);
  });

  it('regge le virgolette con escape dentro le stringhe', () => {
    const testo = '{"template": "dice \\"12345678901234567\\" davvero", "id": 12345678901234567}';
    const atteso = '{"template": "dice \\"12345678901234567\\" davvero", "id": "12345678901234567"}';
    expect(virgoletteSugliId(testo)).toBe(atteso);
  });

  it('lascia intatto ciò che è già scritto bene', () => {
    const testo = '[{"login": "yayadoppia", "liveRoleId": "1536531073658523660"}]';
    expect(virgoletteSugliId(testo)).toBe(testo);
  });

  it('corregge un elenco intero senza rompere il resto', () => {
    const testo = `[
  {
    "login": "yayadoppia",
    "announceChannelId": 1272925031764328471,
    "cooldownMinutes": 20
  }
]`;
    const parsed = JSON.parse(virgoletteSugliId(testo)) as [
      { login: string; announceChannelId: string; cooldownMinutes: number },
    ];

    expect(parsed[0].login).toBe('yayadoppia');
    expect(parsed[0].announceChannelId).toBe('1272925031764328471');
    expect(parsed[0].cooldownMinutes).toBe(20);
  });
});

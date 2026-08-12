import { describe, expect, it } from 'vitest';
import { defaultGuildConfig } from '../config/index.js';

/*
 * Le soglie predefinite decidono se il messaggio di una persona sparisce.
 * Sono numeri, quindi si possono verificare senza mettere in piedi un finto
 * Discord: quello che conta è che un segnale isolato non basti, e che una
 * combinazione plausibile invece basti.
 */
describe('soglie del rilevatore di account compromessi', () => {
  const settings = defaultGuildConfig().security.compromise;
  const { signals } = settings;

  it('un solo segnale non fa sparire il messaggio', () => {
    // Il caso che si vedeva davvero: una GIF o un link, e basta.
    expect(signals.firstMessageIsLink).toBeLessThan(settings.deleteAtScore);
    expect(signals.imageWithUrl).toBeLessThan(settings.deleteAtScore);
    expect(signals.dormantThenLink).toBeLessThan(settings.deleteAtScore);
    expect(signals.knownScamKeywords).toBeLessThan(settings.deleteAtScore);
  });

  it('due segnali insieme fanno eliminare il messaggio', () => {
    // Silenzio di settimane + immagine con link: è la firma della campagna
    // MrBeast, e a quel punto lasciarlo in chat non ha senso.
    expect(signals.dormantThenLink + signals.imageWithUrl).toBeGreaterThanOrEqual(
      settings.deleteAtScore,
    );
    // Stesso messaggio in più canali + parole chiave della campagna.
    expect(signals.sameMessageManyChannels + signals.knownScamKeywords).toBeGreaterThanOrEqual(
      settings.deleteAtScore,
    );
  });

  it('la quarantena resta più severa dell-eliminazione', () => {
    // Se le due soglie si invertissero, un messaggio verrebbe lasciato in chat
    // mentre il suo autore viene isolato: la combinazione meno spiegabile di
    // tutte.
    expect(settings.quarantineAtScore).toBeGreaterThan(settings.deleteAtScore);
  });

  it('serve più di una coppia qualsiasi per arrivare alla quarantena', () => {
    // Nessuna coppia di segnali deboli deve isolare una persona da sola.
    expect(signals.firstMessageIsLink + signals.imageWithUrl).toBeLessThan(
      settings.quarantineAtScore,
    );
  });
});

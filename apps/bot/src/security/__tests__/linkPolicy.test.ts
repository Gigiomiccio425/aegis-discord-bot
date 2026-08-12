import { describe, expect, it } from 'vitest';
import { decidi, leggiTesto } from '../linkPolicy.js';

/*
 * Questo modulo cancella messaggi di persone che non hanno fatto niente di
 * male: hanno solo scritto nel canale sbagliato. Un errore qui non produce un
 * allarme da leggere, produce un canale in cui non si riesce a scrivere e
 * nessuno capisce perché — quindi la decisione si verifica caso per caso.
 */

const CHAT = '111111111111111111';
const MEME = '222222222222222222';

const regole = {
  linkChannelIds: [CHAT],
  gifChannelIds: [MEME],
  alwaysAllowedDomains: [] as string[],
};

describe('lettura del messaggio', () => {
  it('riconosce i link', () => {
    expect(leggiTesto('guarda qui https://esempio.it/pagina e poi vedi').link).toEqual([
      'https://esempio.it/pagina',
    ]);
  });

  it('tratta i link a Tenor come GIF', () => {
    expect(leggiTesto('https://tenor.com/view/qualcosa-123').gif).toBe(true);
  });

  it('un link normale non è una GIF', () => {
    expect(leggiTesto('https://esempio.it').gif).toBe(false);
  });
});

describe('decisione', () => {
  it('lascia passare il link nel canale consentito', () => {
    expect(decidi({ link: ['https://esempio.it'], gif: false, canaleId: CHAT }, regole)).toBeNull();
  });

  it('toglie il link fuori dai canali consentiti', () => {
    const esito = decidi({ link: ['https://esempio.it'], gif: false, canaleId: MEME }, regole);
    expect(esito?.cosa).toBe('link');
    expect(esito?.consentiti).toEqual([CHAT]);
  });

  it('giudica il link a Tenor come GIF, non come link', () => {
    // Nel canale delle GIF deve passare, anche se i link lì non sono ammessi.
    const nelCanaleGif = decidi(
      { link: ['https://tenor.com/view/x'], gif: true, canaleId: MEME },
      regole,
    );
    expect(nelCanaleGif).toBeNull();

    // E nel canale dei link deve essere tolto, perché resta una GIF.
    const nelCanaleLink = decidi(
      { link: ['https://tenor.com/view/x'], gif: true, canaleId: CHAT },
      regole,
    );
    expect(nelCanaleLink?.cosa).toBe('GIF');
  });

  it('un dominio sempre ammesso non fa togliere il messaggio', () => {
    const esito = decidi(
      { link: ['https://angel.example/regolamento'], gif: false, canaleId: MEME },
      { ...regole, alwaysAllowedDomains: ['angel.example'] },
    );
    expect(esito).toBeNull();
  });

  it('il sottodominio di un dominio ammesso vale come ammesso', () => {
    const esito = decidi(
      { link: ['https://wiki.angel.example/pagina'], gif: false, canaleId: MEME },
      { ...regole, alwaysAllowedDomains: ['angel.example'] },
    );
    expect(esito).toBeNull();
  });

  it('elenco vuoto significa consentito ovunque', () => {
    const esito = decidi(
      { link: ['https://esempio.it'], gif: false, canaleId: MEME },
      { ...regole, linkChannelIds: [] },
    );
    expect(esito).toBeNull();
  });

  it('dice entrambe le cose quando entrambe sono fuori posto', () => {
    const esito = decidi(
      { link: ['https://esempio.it'], gif: true, canaleId: '999999999999999999' },
      regole,
    );
    expect(esito?.cosa).toBe('link e GIF');
  });
});

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  bitScrittura,
  comeModifica,
  pianificaBlocco,
  ripristinoEveryone,
  type CanaleDescritto,
} from '../pianoBlocco.js';

/*
 * Il lockdown è l'azione più grossa che il bot possa fare su un server, e
 * quella che più facilmente sembra funzionare quando non funziona: risponde
 * «attivo», e intanto un canale resta aperto. I casi qui sotto sono quelli
 * scoperti sul campo — la chat delle vocali, il ruolo con la scrittura
 * concessa — più quelli che una correzione frettolosa romperebbe.
 */

const EVERYONE = '100000000000000000';
const MEMBRI = '200000000000000000';
const STAFF = '300000000000000000';
const UTENTE = '400000000000000000';

const { SendMessages, ViewChannel } = PermissionFlagsBits;

function canale(
  id: string,
  tipo: ChannelType,
  sovrascritture: CanaleDescritto['sovrascritture'] = [],
): CanaleDescritto {
  return { id, nome: `canale-${id.slice(0, 3)}`, tipo, sovrascritture };
}

const contesto = {
  everyoneId: EVERYONE,
  canaliEsenti: new Set<string>(),
  ruoliIntoccabili: new Set([STAFF]),
};

describe('piano del lockdown', () => {
  it('chiude la chat delle vocali e dei palchi', () => {
    const piano = pianificaBlocco(
      [canale('1', ChannelType.GuildVoice), canale('2', ChannelType.GuildStageVoice)],
      contesto,
    );
    expect(piano.map((voce) => voce.canaleId)).toEqual(['1', '2']);
    expect(piano.every((voce) => voce.vocale)).toBe(true);
  });

  it('nelle vocali toglie solo la scrittura, non la voce', () => {
    // Parlare e collegarsi restano: chi è in vocale con lo staff durante un
    // raid non deve essere buttato fuori.
    expect(bitScrittura(ChannelType.GuildVoice)).toBe(SendMessages);
    const [voce] = pianificaBlocco([canale('1', ChannelType.GuildVoice)], contesto);
    expect(voce!.daNegare).toBe(SendMessages);
  });

  it('nei canali di testo chiude anche i thread, privati compresi', () => {
    const bit = bitScrittura(ChannelType.GuildText);
    expect(bit & PermissionFlagsBits.SendMessagesInThreads).not.toBe(0n);
    expect(bit & PermissionFlagsBits.CreatePublicThreads).not.toBe(0n);
    expect(bit & PermissionFlagsBits.CreatePrivateThreads).not.toBe(0n);
  });

  it('ignora categorie e thread', () => {
    const piano = pianificaBlocco(
      [canale('1', ChannelType.GuildCategory), canale('2', ChannelType.PublicThread)],
      contesto,
    );
    expect(piano).toEqual([]);
  });

  it('rispetta i canali esentati', () => {
    const piano = pianificaBlocco([canale('1', ChannelType.GuildText)], {
      ...contesto,
      canaliEsenti: new Set(['1']),
    });
    expect(piano).toEqual([]);
  });

  /*
   * Il buco principale: un ruolo con la scrittura concessa sul canale la
   * riconcede sopra il divieto di @everyone. Senza neutralizzarlo il
   * lockdown è attivo e non ferma nessuno.
   */
  it('neutralizza la scrittura concessa a un ruolo ordinario', () => {
    const [voce] = pianificaBlocco(
      [
        canale('1', ChannelType.GuildText, [
          { id: MEMBRI, tipo: 0, allow: SendMessages | ViewChannel, deny: 0n },
        ]),
      ],
      contesto,
    );
    expect(voce!.ruoli).toEqual([{ ruoloId: MEMBRI, bit: SendMessages }]);
  });

  it('non tocca i ruoli di staff', () => {
    const [voce] = pianificaBlocco(
      [canale('1', ChannelType.GuildText, [{ id: STAFF, tipo: 0, allow: SendMessages, deny: 0n }])],
      contesto,
    );
    expect(voce!.ruoli).toEqual([]);
  });

  it('non tocca le concessioni personali, che i ticket usano', () => {
    const [voce] = pianificaBlocco(
      [canale('1', ChannelType.GuildText, [{ id: UTENTE, tipo: 1, allow: SendMessages, deny: 0n }])],
      contesto,
    );
    expect(voce!.ruoli).toEqual([]);
  });

  it('un ruolo che concede solo la vista non va neutralizzato', () => {
    // È il modello dei server costruiti da ANGEL: i verificati vedono, e la
    // scrittura arriva dai permessi del server, che il divieto su @everyone
    // blocca già.
    const [voce] = pianificaBlocco(
      [canale('1', ChannelType.GuildText, [{ id: MEMBRI, tipo: 0, allow: ViewChannel, deny: 0n }])],
      contesto,
    );
    expect(voce!.ruoli).toEqual([]);
    expect(voce!.daNegare).not.toBe(0n);
  });

  /*
   * Un canale già in sola lettura per scelta dello staff non riceve un
   * secondo divieto: alla revoca verrebbe riaperto un canale che doveva
   * restare chiuso — gli annunci.
   */
  it('non ridà un divieto a un canale già in sola lettura', () => {
    const piano = pianificaBlocco(
      [
        canale('1', ChannelType.GuildAnnouncement, [
          { id: EVERYONE, tipo: 0, allow: 0n, deny: SendMessages },
        ]),
      ],
      contesto,
    );
    expect(piano).toEqual([]);
  });

  it('ma neutralizza lo stesso chi ci scrive per ruolo ordinario', () => {
    const [voce] = pianificaBlocco(
      [
        canale('1', ChannelType.GuildAnnouncement, [
          { id: EVERYONE, tipo: 0, allow: 0n, deny: SendMessages },
          { id: MEMBRI, tipo: 0, allow: SendMessages, deny: 0n },
        ]),
      ],
      contesto,
    );
    expect(voce!.daNegare).toBe(0n);
    expect(voce!.ruoli).toHaveLength(1);
  });

  it('ricorda cosa @everyone aveva concesso esplicitamente', () => {
    const [voce] = pianificaBlocco(
      [canale('1', ChannelType.GuildText, [{ id: EVERYONE, tipo: 0, allow: SendMessages, deny: 0n }])],
      contesto,
    );
    expect(voce!.everyoneEsisteva).toBe(true);
    expect(voce!.everyoneConcessiPrima).toBe(SendMessages);
  });
});

describe('modifiche dei permessi', () => {
  it('traduce i bit nei nomi che discord.js si aspetta', () => {
    expect(comeModifica(SendMessages, false)).toEqual({ SendMessages: false });
  });

  /*
   * La prima versione rimetteva tutto a «eredita», cancellando in silenzio
   * una concessione esplicita fatta dallo staff prima del blocco.
   */
  it('la revoca rimette le concessioni che c’erano', () => {
    const bit = bitScrittura(ChannelType.GuildText);
    const modifica = ripristinoEveryone(bit, SendMessages);
    expect(modifica.SendMessages).toBe(true);
    expect(modifica.SendMessagesInThreads).toBeNull();
    expect(modifica.CreatePrivateThreads).toBeNull();
  });
});

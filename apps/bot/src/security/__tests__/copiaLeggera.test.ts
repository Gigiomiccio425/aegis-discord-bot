import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { componiDocumento, FORMATO_LEGGERO, type DocumentoLeggero } from '@angel/shared';
import { accettaDocumento, motivoRifiuto, nomeFile } from '../copiaLeggera.js';

/* ═══════════════════════════════════════════════════════════════════════
   I DUE CONTROLLI CHE TENGONO IN PIEDI LA COPIA LEGGERA

   Questa copia esce dalla macchina e va su Discord. Due cose possono andare
   storte, e nessuna delle due dà errore quando va storta:

   • **pubblicarla dove la leggono tutti.** Il file dice quali difese sono
     accese e con quali soglie: in un canale aperto è una mappa per chi vuole
     aggirarle. Sapere che l'anti-raid scatta a dieci ingressi significa
     sapere di entrare in nove;

   • **rimettere un file di qualcun altro.** Rimettere una configurazione è
     come cambiarla. Un documento preparato da un estraneo, allegato da un
     amministratore in buona fede, spegne le difese del server senza che
     nessuno abbia fatto niente di apparentemente sbagliato.

   Il primo si verifica sul canale, il secondo sull'autore del messaggio.
   ═══════════════════════════════════════════════════════════════════════ */

/** Una gilda finta: servono solo `@everyone` e il membro che è il bot. */
function gildaFinta() {
  return {
    id: '1272925031034523698',
    roles: { everyone: { id: '1272925031034523698' } },
    members: { me: { id: 'bot' } },
  } as never;
}

/**
 * Un canale finto.
 *
 * `vedeEveryone` è il caso che conta: un canale che `@everyone` può leggere
 * non deve ricevere la copia.
 */
function canaleFinto(opzioni: {
  tipo?: number;
  vedeEveryone?: boolean;
  botPuoAllegare?: boolean;
}) {
  const { tipo = ChannelType.GuildText, vedeEveryone = false, botPuoAllegare = true } = opzioni;

  return {
    type: tipo,
    permissionsFor: (chi: { id: string }) => ({
      has: (flag: bigint) => {
        if (chi.id === 'bot') {
          return flag === PermissionFlagsBits.AttachFiles ? botPuoAllegare : true;
        }
        return flag === PermissionFlagsBits.ViewChannel ? vedeEveryone : false;
      },
    }),
  };
}

function documento(modifiche: Partial<DocumentoLeggero> = {}): DocumentoLeggero {
  return {
    formato: FORMATO_LEGGERO,
    angel: '1.29.8',
    guildId: '1272925031034523698',
    guildNome: 'Server di prova',
    creatoIl: '2026-09-21T04:15:00.000Z',
    configurazione: { general: { dryRun: false } },
    ruoli: [],
    canali: [],
    comandi: [],
    paroleVietate: [],
    dominiAmmessi: [],
    sorvegliati: [],
    ...modifiche,
  };
}

describe('dove si può pubblicare la copia', () => {
  it('in un canale riservato allo staff, sì', () => {
    expect(motivoRifiuto(gildaFinta(), canaleFinto({}))).toBeNull();
  });

  /*
   * Il rifiuto arriva **prima** di pubblicare, non dopo. Su Discord
   * cancellare un file non lo toglie a chi l'ha già scaricato.
   */
  it('in un canale che legge @everyone, no', () => {
    const motivo = motivoRifiuto(gildaFinta(), canaleFinto({ vedeEveryone: true }));
    expect(motivo).toContain('@everyone');
  });

  it('in un canale vocale, no', () => {
    const motivo = motivoRifiuto(gildaFinta(), canaleFinto({ tipo: ChannelType.GuildVoice }));
    expect(motivo).toContain('testuale');
  });

  it('senza il permesso di allegare file, no', () => {
    const motivo = motivoRifiuto(gildaFinta(), canaleFinto({ botPuoAllegare: false }));
    expect(motivo).toContain('allegare');
  });

  it('in un canale che non esiste più, no', () => {
    expect(motivoRifiuto(gildaFinta(), undefined)).toContain('non esiste');
  });
});

describe('quali copie si accettano per rimetterle', () => {
  const guildId = '1272925031034523698';

  it('una copia pubblicata dal bot, di questo server', () => {
    const testo = componiDocumento(documento());
    const esito = accettaDocumento(testo, { autoreBot: true, guildId });

    expect(esito.problemi).toEqual([]);
    expect(esito.documento?.guildId).toBe(guildId);
  });

  /*
   * Il controllo che regge tutto il resto.
   *
   * Il documento qui sotto è **perfettamente valido**: impronta giusta,
   * formato giusto, server giusto. Viene rifiutato solo perché non l'ha
   * pubblicato il bot — ed è esattamente il caso da fermare, perché un file
   * preparato da un estraneo sarebbe valido quanto questo.
   */
  it('un file valido ma non pubblicato dal bot viene rifiutato lo stesso', () => {
    const testo = componiDocumento(documento());
    const esito = accettaDocumento(testo, { autoreBot: false, guildId });

    expect(esito.documento).toBeNull();
    expect(esito.problemi.join(' ')).toContain('solo le copie che ho pubblicato io');
  });

  /*
   * Una copia di un altro server nomina ruoli e canali che qui non esistono.
   * Applicarla lascerebbe una configurazione che punta nel vuoto — difese
   * accese che non proteggono niente, che è peggio di difese spente.
   */
  it('una copia di un altro server viene rifiutata', () => {
    const testo = componiDocumento(documento({ guildId: '999999999999999999' }));
    const esito = accettaDocumento(testo, { autoreBot: true, guildId });

    expect(esito.documento).toBeNull();
    expect(esito.problemi.join(' ')).toContain('un altro server');
  });

  it('un file che non è una copia leggera viene rifiutato', () => {
    const esito = accettaDocumento('ciao', { autoreBot: true, guildId });
    expect(esito.documento).toBeNull();
    expect(esito.problemi).not.toEqual([]);
  });
});

describe('nome del file', () => {
  it('contiene il server e la data, così si riconosce nell’elenco', () => {
    const nome = nomeFile('1272925031034523698', new Date('2026-09-21T04:15:00.000Z'));
    expect(nome).toBe('angel-copia-1272925031034523698-2026-09-21.md');
  });
});

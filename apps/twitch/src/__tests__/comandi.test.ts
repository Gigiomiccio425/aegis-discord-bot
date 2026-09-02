import { describe, expect, it } from 'vitest';
import { defaultTwitchConfig, type TwitchChannelConfig } from '@angel/shared';
import type { MessaggioChat } from '../deps.js';
import { durata, eseguiComando, type ContestoComando } from '../comandi.js';
import type { Canale } from '../stato.js';

/* ═══════════════════════════════════════════════════════════════════════
   I comandi in chat sono la promessa «funziona anche senza pannello».

   Sono quindi la parte che deve reggere proprio quando tutto il resto non
   regge: database giù, pannello irraggiungibile, streamer che ha in mano
   solo l'app di Twitch. Questi test girano senza niente di tutto quello —
   nessuna rete, nessun database — perché è esattamente la condizione in cui
   quel codice deve funzionare.
   ═══════════════════════════════════════════════════════════════════════ */

/** Quello che il bot ha detto in chat durante il test. */
let detto: string[] = [];

function canale(ritocchi: (config: TwitchChannelConfig) => void = () => undefined): Canale {
  const config = defaultTwitchConfig();
  ritocchi(config);

  return {
    // Un id diverso a ogni chiamata: i cooldown vivono in una mappa di modulo,
    // e due test che usassero lo stesso canale si influenzerebbero a vicenda
    // in un modo che dipende dall'ordine.
    id: `canale-${Math.random().toString(36).slice(2)}`,
    login: 'yayadoppia',
    nome: 'yayadoppia',
    guildId: null,
    config,
    token: { accessToken: 'valido', refreshToken: null },
    moderatori: ['aiutante'],
    online: true,
    righeDaTimer: 0,
    raid: { nuovi: [], impronte: [] },
    scudoFinoA: null,
    spettatori: new Map(),
    botModeratore: false,
    moderatoriAggiornatiIl: 0,
    improntaTermini: '',
  };
}

function messaggio(testo: string, extra: Partial<MessaggioChat> = {}): MessaggioChat {
  return {
    canaleId: '1',
    canaleLogin: 'yayadoppia',
    messaggioId: 'm1',
    utenteId: '99',
    utenteLogin: 'spettatore',
    utenteNome: 'Spettatore',
    testo,
    emote: 0,
    colore: null,
    moderatore: false,
    abbonato: false,
    vip: false,
    streamer: false,
    primoMessaggio: false,
    rispostaA: null,
    ...extra,
  };
}

interface Esito {
  eseguito: boolean;
  detto: string[];
  salvataggi: number;
  dimenticati: string[];
}

async function esegui(
  suCanale: Canale,
  testo: string,
  extra: Partial<MessaggioChat> = {},
  opzioni: { salvaFallisce?: boolean } = {},
): Promise<Esito> {
  detto = [];
  const dimenticati: string[] = [];
  let salvataggi = 0;

  const contesto = {
    esecutore: {
      // Solo quello che i comandi usano davvero. Un finto client completo
      // sarebbe più lavoro e proverebbe meno: quello che qui non compare è
      // quello che i comandi non devono chiamare.
      helix: {
        manda: (_canaleId: string, _mittente: string, testo: string) => {
          detto.push(testo);
          return Promise.resolve();
        },
        seguace: () => Promise.resolve(null),
        utenti: () => Promise.resolve([]),
        sanziona: () => Promise.resolve(),
        revocaSanzione: () => Promise.resolve(),
      },
      archivio: { registra: () => undefined },
      botId: 'bot',
      botModeratore: () => false,
    },
    canale: suCanale,
    messaggio: messaggio(testo, extra),
    argomento: '',
    salva: () => {
      salvataggi += 1;
      return Promise.resolve(!opzioni.salvaFallisce);
    },
    daQuandoOnline: 3_600_000,
    dimentica: (_c: Canale, utenteId: string) => {
      dimenticati.push(utenteId);
      return Promise.resolve(7);
    },
  } as unknown as ContestoComando;

  const eseguito = await eseguiComando(contesto);
  return { eseguito, detto, salvataggi, dimenticati };
}

/* ── Smistamento ──────────────────────────────────────────────────────── */

describe('riconoscimento dei comandi', () => {
  it('un messaggio normale non è un comando', async () => {
    const esito = await esegui(canale(), 'ciao a tutti');
    expect(esito.eseguito).toBe(false);
    expect(esito.detto).toEqual([]);
  });

  it('un comando che non esiste non produce risposte', async () => {
    const esito = await esegui(canale(), '!inventato');
    expect(esito.detto).toEqual([]);
  });

  it('rispetta il prefisso scelto dallo streamer', async () => {
    const suCanale = canale((config) => void (config.prefisso = '?'));
    expect((await esegui(suCanale, '!dado')).detto).toEqual([]);
    expect((await esegui(suCanale, '?dado')).detto.length).toBe(1);
  });
});

/* ── Comandi personalizzati ───────────────────────────────────────────── */

describe('comandi personalizzati', () => {
  const conComando = (): Canale =>
    canale((config) => {
      config.chat.comandi = [
        {
          nome: 'discord',
          alias: ['dc'],
          risposta: 'Ciao {utente}, entra su esempio.it',
          livello: 'TUTTI',
          cooldownSec: 0,
          cooldownCanaleSec: 0,
          attivo: true,
        },
      ];
    });

  it('risponde e sostituisce i segnaposto', async () => {
    const esito = await esegui(conComando(), '!discord');
    expect(esito.detto[0]).toBe('Ciao Spettatore, entra su esempio.it');
  });

  it('risponde anche agli alias', async () => {
    expect((await esegui(conComando(), '!dc')).detto).toHaveLength(1);
  });

  it('un comando spento non risponde', async () => {
    const suCanale = conComando();
    suCanale.config.chat.comandi[0]!.attivo = false;
    expect((await esegui(suCanale, '!discord')).detto).toEqual([]);
  });

  /*
   * Il livello si controlla *prima* del cooldown.
   *
   * Invertendoli, chi non ha i permessi consumerebbe l'attesa di tutti gli
   * altri: basterebbe uno spettatore che preme un comando riservato ai
   * moderatori per impedire ai moderatori di usarlo.
   */
  it('un comando riservato non risponde a chi non ha il livello', async () => {
    const suCanale = conComando();
    suCanale.config.chat.comandi[0]!.livello = 'MODERATORI';

    expect((await esegui(suCanale, '!discord')).detto).toEqual([]);
    expect((await esegui(suCanale, '!discord', { moderatore: true })).detto).toHaveLength(1);
  });

  it('il cooldown ferma la seconda chiamata di fila', async () => {
    const suCanale = conComando();
    suCanale.config.chat.comandi[0]!.cooldownSec = 60;

    expect((await esegui(suCanale, '!discord')).detto).toHaveLength(1);
    expect((await esegui(suCanale, '!discord')).detto).toEqual([]);
  });
});

/* ── !angel ───────────────────────────────────────────────────────────── */

describe('!angel', () => {
  it('lo stato lo può chiedere un moderatore', async () => {
    const esito = await esegui(canale(), '!angel stato', { moderatore: true });
    expect(esito.detto[0]).toContain('ANGEL');
    expect(esito.detto[0]).toContain('normale');
  });

  it('uno spettatore qualsiasi non governa il bot', async () => {
    expect((await esegui(canale(), '!angel stato')).detto).toEqual([]);
    expect((await esegui(canale(), '!angel livello blindato')).detto).toEqual([]);
  });

  it('cambia livello e lo salva', async () => {
    const suCanale = canale();
    const esito = await esegui(suCanale, '!angel livello blindato', { moderatore: true });

    expect(suCanale.config.livello).toBe('BLINDATO');
    expect(suCanale.config.sicurezza.link.soloPermessi).toBe(true);
    expect(esito.salvataggi).toBe(1);
  });

  /*
   * Il caso per cui questi comandi esistono.
   *
   * Con il database giù il cambio deve avere effetto lo stesso — la
   * configurazione vive in memoria — e il bot deve dirlo, altrimenti lo
   * streamer crede di aver cambiato qualcosa per sempre e se lo ritrova
   * com'era al riavvio successivo.
   */
  it('senza database il livello cambia comunque, e lo dice', async () => {
    const suCanale = canale();
    const esito = await esegui(suCanale, '!angel livello alto', { moderatore: true }, {
      salvaFallisce: true,
    });

    expect(suCanale.config.livello).toBe('ALTO');
    expect(esito.detto[0]).toContain('non ho potuto salvarlo');
  });

  it('un livello inventato elenca quelli veri invece di inventarne uno', async () => {
    const suCanale = canale();
    const esito = await esegui(suCanale, '!angel livello fortissimo', { moderatore: true });

    expect(suCanale.config.livello).toBe('NORMALE');
    expect(esito.detto[0]).toContain('blindato');
  });

  it('accende e spegne la modalità prova', async () => {
    const suCanale = canale();
    await esegui(suCanale, '!angel prova on', { moderatore: true });
    expect(suCanale.config.modalitaProva).toBe(true);

    await esegui(suCanale, '!angel prova off', { moderatore: true });
    expect(suCanale.config.modalitaProva).toBe(false);
  });

  it('aggiunge e toglie un dominio ammesso, ripulendolo', async () => {
    const suCanale = canale();

    await esegui(suCanale, '!angel permetti https://www.esempio.it/pagina', { moderatore: true });
    expect(suCanale.config.sicurezza.link.dominiAmmessi).toEqual(['esempio.it']);

    // Lo stesso comando due volte lo toglie: un elenco che si può solo
    // allungare è un elenco che prima o poi contiene un errore per sempre.
    await esegui(suCanale, '!angel permetti esempio.it', { moderatore: true });
    expect(suCanale.config.sicurezza.link.dominiAmmessi).toEqual([]);
  });

  it('accende e spegne i messaggi a tempo', async () => {
    const suCanale = canale((config) => {
      config.chat.timer = [
        {
          nome: 'regole',
          messaggi: ['comportatevi bene'],
          intervalloSec: 900,
          minRighe: 5,
          ancheOffline: false,
          attivo: true,
        },
      ];
    });

    await esegui(suCanale, '!angel timer off', { moderatore: true });
    expect(suCanale.config.chat.timer[0]!.attivo).toBe(false);
  });

  /*
   * `dimenticami` non ha un livello, e non ne deve avere.
   *
   * L'accordo con Twitch obbliga a dare modo di opporsi al trattamento.
   * Riservarlo ai moderatori significherebbe non darlo proprio a chi serve,
   * che sono gli spettatori.
   */
  it('dimenticami funziona per chiunque', async () => {
    const esito = await esegui(canale(), '!angel dimenticami');
    expect(esito.dimenticati).toEqual(['99']);
    expect(esito.detto[0]).toContain('7');
  });

  it('senza argomenti mostra l’aiuto', async () => {
    const esito = await esegui(canale(), '!angel', { moderatore: true });
    expect(esito.detto[0]).toContain('livello');
    expect(esito.detto[0]).toContain('scudo');
  });
});

/* ── Comandi integrati ────────────────────────────────────────────────── */

describe('comandi integrati', () => {
  it('uptime dice da quanto è in diretta', async () => {
    const esito = await esegui(canale(), '!uptime');
    expect(esito.detto[0]).toContain('1 h');
  });

  it('si possono spegnere tutti insieme', async () => {
    const suCanale = canale((config) => void (config.chat.comandiIntegrati = false));
    expect((await esegui(suCanale, '!uptime')).detto).toEqual([]);
  });

  it('l’elenco dei comandi mostra solo quelli aperti a tutti', async () => {
    const suCanale = canale((config) => {
      config.chat.comandi = [
        { nome: 'aperto', alias: [], risposta: 'x', livello: 'TUTTI', cooldownSec: 0, cooldownCanaleSec: 0, attivo: true },
        { nome: 'riservato', alias: [], risposta: 'x', livello: 'MODERATORI', cooldownSec: 0, cooldownCanaleSec: 0, attivo: true },
      ];
    });

    const esito = await esegui(suCanale, '!comandi');
    expect(esito.detto[0]).toContain('!aperto');
    expect(esito.detto[0]).not.toContain('!riservato');
  });
});

/* ── Durata leggibile ─────────────────────────────────────────────────── */

describe('durata', () => {
  it('sceglie l’unità in base alla grandezza', () => {
    expect(durata(45_000)).toBe('45 s');
    expect(durata(600_000)).toBe('10 m');
    expect(durata(3_900_000)).toBe('1 h 5 m');
    expect(durata(200_000_000)).toBe('2 g 7 h');
  });
});

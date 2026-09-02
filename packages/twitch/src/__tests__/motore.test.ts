import { describe, expect, it } from 'vitest';
import { defaultTwitchConfig, applicaLivello } from '@angel/shared';
import type { MessaggioChat } from '../eventsub.js';
import {
  improntaMessaggio,
  livelloDi,
  scegliAzione,
  sembraAsciiArt,
  valuta,
  valutaRaid,
  type ContestoMessaggio,
  type StatoSpettatore,
} from '../moderazione/motore.js';

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

function contesto(
  testo: string,
  extra: Partial<MessaggioChat> = {},
  ritocchi: (ctx: ContestoMessaggio) => void = () => undefined,
): ContestoMessaggio {
  const spettatore: StatoSpettatore = { messaggi: 50, fiducia: 50, fidato: false, recenti: [] };
  const ctx: ContestoMessaggio = {
    messaggio: messaggio(testo, extra),
    config: defaultTwitchConfig(),
    spettatore,
    streamerLogin: 'yayadoppia',
    moderatoriLogin: ['aiutante'],
    adesso: 1_000_000,
  };
  ritocchi(ctx);
  return ctx;
}

/* ── Il caso che conta di più ─────────────────────────────────────────── */

describe('bot commerciali', () => {
  it('riconosce il venditore di visualizzatori', () => {
    const verdetto = valuta(contesto('Hi! Want cheap viewers on your stream? Check our site'));
    expect(verdetto.azione).toBe('BANDISCI');
    expect(verdetto.rilevazioni.some((r) => r.modulo === 'botSpam')).toBe(true);
  });

  /*
   * Il test per cui esiste la normalizzazione.
   *
   * Questa è la forma vera in cui arrivano: matematici e diacritici
   * combinanti scelti apposta perché i termini bloccati di Twitch — che
   * confrontano il testo letterale — non li vedano.
   */
  it('lo riconosce anche scritto in Unicode strano', () => {
    const verdetto = valuta(contesto('Ch̵eap Vi̇ewers on 𝗯𝗲𝘀𝘁 site'));
    expect(verdetto.rilevazioni.some((r) => r.modulo === 'botSpam')).toBe(true);
  });

  it('non tocca i bot legittimi', () => {
    const verdetto = valuta(
      contesto('Buy followers here', { utenteLogin: 'nightbot' }),
    );
    expect(verdetto.rilevazioni.some((r) => r.modulo === 'botSpam')).toBe(false);
  });

  it('due segnali deboli insieme pesano più di uno solo', () => {
    const uno = valuta(contesto('see my work'));
    const due = valuta(contesto('see my work, add me on discord'));
    const punti = (v: typeof uno): number =>
      v.rilevazioni.filter((r) => r.modulo === 'botSpam').reduce((s, r) => s + r.punteggio, 0);
    expect(punti(due)).toBeGreaterThan(punti(uno));
  });
});

/* ── Link ─────────────────────────────────────────────────────────────── */

describe('link', () => {
  it('blocca il dominio che imita Steam', () => {
    const verdetto = valuta(contesto('free skins su https://steamcommunlty.com/gift'));
    expect(verdetto.rilevazioni.some((r) => r.modulo === 'link')).toBe(true);
    expect(verdetto.eliminaMessaggio).toBe(true);
  });

  it('rispetta i domini ammessi dallo streamer', () => {
    const verdetto = valuta(
      contesto('il mio discord: https://discord.gg/abcdef', { primoMessaggio: true }, (ctx) => {
        ctx.config.sicurezza.link.dominiAmmessi = ['discord.gg'];
      }),
    );
    expect(verdetto.rilevazioni.some((r) => r.modulo === 'link')).toBe(false);
  });

  it('un link nel primo messaggio pesa, negli altri no', () => {
    const primo = valuta(contesto('guarda https://esempio.it', { primoMessaggio: true }));
    const dopo = valuta(contesto('guarda https://esempio.it'));
    expect(primo.rilevazioni.some((r) => r.modulo === 'link')).toBe(true);
    expect(dopo.rilevazioni.some((r) => r.modulo === 'link')).toBe(false);
  });

  it('usa la blocklist condivisa con il bot Discord', () => {
    const verdetto = valuta(
      contesto('https://cattivo.example/x', {}, (ctx) => {
        ctx.hostMalevolo = (host) => host === 'cattivo.example';
      }),
    );
    expect(verdetto.azione).toBe('BANDISCI');
  });
});

/* ── Esenzioni ────────────────────────────────────────────────────────── */

describe('chi non viene toccato', () => {
  it('lo streamer non viene mai sanzionato', () => {
    const verdetto = valuta(contesto('CHEAP VIEWERS BUY FOLLOWERS', { streamer: true }));
    expect(verdetto.azione).toBe('NIENTE');
  });

  it('i moderatori sono esenti di partenza', () => {
    const verdetto = valuta(contesto('AAAAAAAAAAAAAAAAAAAAA', { moderatore: true }));
    expect(verdetto.rilevazioni.some((r) => r.modulo === 'antiSpam')).toBe(false);
  });
});

/* ── Anti-spam ────────────────────────────────────────────────────────── */

describe('anti-spam', () => {
  it('conta le ripetizioni nella finestra', () => {
    const verdetto = valuta(
      contesto('ciao a tutti', {}, (ctx) => {
        ctx.spettatore.recenti = [
          { testo: 'ciao a tutti', quando: 999_000 },
          { testo: 'ciao a tutti', quando: 999_500 },
        ];
      }),
    );
    expect(verdetto.rilevazioni.some((r) => r.motivo.includes('ripetuto'))).toBe(true);
  });

  it('non conta i messaggi fuori dalla finestra', () => {
    const verdetto = valuta(
      contesto('ciao a tutti', {}, (ctx) => {
        // Mezz'ora prima: la finestra predefinita è di quindici secondi.
        ctx.spettatore.recenti = [
          { testo: 'ciao a tutti', quando: 1_000_000 - 1_800_000 },
          { testo: 'ciao a tutti', quando: 1_000_000 - 1_700_000 },
        ];
      }),
    );
    expect(verdetto.rilevazioni.some((r) => r.motivo.includes('ripetuto'))).toBe(false);
  });

  it('«OK» non è un urlo', () => {
    expect(valuta(contesto('OK')).rilevazioni.some((r) => r.motivo.includes('maiuscole'))).toBe(
      false,
    );
  });

  it('una frase intera in maiuscolo sì', () => {
    const verdetto = valuta(contesto('SMETTETELA TUTTI QUANTI ADESSO'));
    expect(verdetto.rilevazioni.some((r) => r.motivo.includes('maiuscole'))).toBe(true);
  });

  it('riconosce l’ASCII art ma non le faccine', () => {
    expect(sembraAsciiArt('¯\\_(ツ)_/¯')).toBe(false);
    expect(sembraAsciiArt('▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄')).toBe(true);
  });
});

/* ── Modalità prova e livelli ─────────────────────────────────────────── */

describe('livelli di sicurezza', () => {
  it('OSSERVA valuta tutto ma dichiara che è una prova', () => {
    const config = applicaLivello('OSSERVA');
    const ctx = contesto('cheap viewers');
    ctx.config = config;
    const verdetto = valuta(ctx);
    expect(verdetto.simulato).toBe(true);
    expect(verdetto.rilevazioni.length).toBeGreaterThan(0);
  });

  it('LEGGERO non filtra il linguaggio', () => {
    const config = applicaLivello('LEGGERO');
    expect(config.sicurezza.linguaggio.attivo).toBe(false);
    expect(config.sicurezza.link.attivo).toBe(true);
  });

  it('BLINDATO riserva i link a chi è abbonato', () => {
    const config = applicaLivello('BLINDATO');
    expect(config.sicurezza.link.soloPermessi).toBe(true);
    expect(config.sicurezza.antiRaid.rallentaSec).toBeGreaterThan(0);
  });

  /*
   * Il preset non deve cancellare il lavoro dello streamer.
   *
   * Se cambiare livello spazzasse via timer, comandi e domini ammessi,
   * nessuno oserebbe più toccare quel menu — e i livelli esistono proprio
   * perché sia una scelta senza conseguenze.
   */
  it('cambiare livello non cancella timer, comandi e domini ammessi', () => {
    const prima = defaultTwitchConfig();
    prima.chat.comandi = [
      { nome: 'discord', alias: [], risposta: 'entra qui', livello: 'TUTTI', cooldownSec: 10, cooldownCanaleSec: 3, attivo: true },
    ];
    prima.sicurezza.link.dominiAmmessi = ['discord.gg'];
    prima.registro.canaleAvvisiId = '123456789012345678';

    const dopo = applicaLivello('BLINDATO', prima);
    expect(dopo.chat.comandi).toHaveLength(1);
    expect(dopo.sicurezza.link.dominiAmmessi).toEqual(['discord.gg']);
    expect(dopo.registro.canaleAvvisiId).toBe('123456789012345678');
  });
});

/* ── Scala ────────────────────────────────────────────────────────────── */

describe('scala delle azioni', () => {
  const scala = [
    { dalPunteggio: 20, azione: 'ELIMINA_MESSAGGIO' as const, durataSec: 0 },
    { dalPunteggio: 50, azione: 'SILENZIA' as const, durataSec: 600 },
    { dalPunteggio: 80, azione: 'BANDISCI' as const, durataSec: 0 },
  ];

  it('sceglie il gradino più alto raggiunto', () => {
    expect(scegliAzione(scala, 10).azione).toBe('NIENTE');
    expect(scegliAzione(scala, 20).azione).toBe('ELIMINA_MESSAGGIO');
    expect(scegliAzione(scala, 55).azione).toBe('SILENZIA');
    expect(scegliAzione(scala, 99).azione).toBe('BANDISCI');
  });

  it('porta con sé la durata del gradino', () => {
    expect(scegliAzione(scala, 55).durataSec).toBe(600);
  });
});

/* ── Raid ─────────────────────────────────────────────────────────────── */

describe('raid ostile', () => {
  const config = defaultTwitchConfig();

  /*
   * Il falso positivo da evitare a ogni costo.
   *
   * Un raid di Twitch è un regalo: uno streamer manda i propri spettatori.
   * Trattarlo come un attacco significa accogliere gli ospiti chiudendo la
   * chat, ed è il modo migliore per far disinstallare il bot.
   */
  it('venti sconosciuti che scrivono cose diverse non sono un attacco', () => {
    const adesso = 1_000_000;
    const verdetto = valutaRaid(
      config,
      {
        nuovi: Array.from({ length: 20 }, (_, i) => adesso - i * 100),
        impronte: Array.from({ length: 20 }, (_, i) => ({
          impronta: `saluto numero ${i}`,
          quando: adesso - i * 100,
        })),
      },
      adesso,
    );
    expect(verdetto.attacco).toBe(false);
  });

  it('venti sconosciuti che scrivono la stessa cosa lo sono', () => {
    const adesso = 1_000_000;
    const verdetto = valutaRaid(
      config,
      {
        nuovi: Array.from({ length: 20 }, (_, i) => adesso - i * 100),
        impronte: Array.from({ length: 20 }, (_, i) => ({
          impronta: 'sei uno schifo',
          quando: adesso - i * 100,
        })),
      },
      adesso,
    );
    expect(verdetto.attacco).toBe(true);
    expect(verdetto.motivo).toContain('quasi identici');
  });

  it('l’impronta ignora i numeri, che gli attacchi randomizzano', () => {
    expect(improntaMessaggio('compra su sito 12345')).toBe(improntaMessaggio('compra su sito 99'));
  });
});

/* ── Livelli di chi scrive ────────────────────────────────────────────── */

describe('livello di chi scrive', () => {
  it('lo streamer vince su tutto', () => {
    expect(livelloDi(messaggio('ciao', { streamer: true, moderatore: true }))).toBe('STREAMER');
  });

  it('un abbonato normale è ABBONATI', () => {
    expect(livelloDi(messaggio('ciao', { abbonato: true }))).toBe('ABBONATI');
  });
});

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { installaParserJson } from '../pannello/parser.js';
import {
  origineAccettata,
  proxyFidati,
  richiestaDaAltraOrigine,
} from '@angel/shared';

/*
 * Tre pulsanti del pannello degli streamer — esci, togli un accesso, stacca
 * il canale — rispondevano 400 da sempre: il client manda il content-type
 * JSON anche senza corpo, e Fastify lo rifiuta. Il test usa un Fastify vero,
 * perché il guasto stava proprio nel comportamento predefinito della libreria.
 */
async function server() {
  const app = Fastify();
  installaParserJson(app);
  app.post('/esci', async () => ({ uscito: true }));
  app.delete('/canale', async () => ({ staccato: true }));
  app.post('/eco', async (request) => request.body);
  await app.ready();
  return app;
}

const JSON_HDR = { 'content-type': 'application/json' };

describe('parser JSON del pannello Twitch', () => {
  it('accetta il corpo vuoto su POST e DELETE', async () => {
    const app = await server();
    expect((await app.inject({ method: 'POST', url: '/esci', headers: JSON_HDR })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/canale', headers: JSON_HDR })).statusCode).toBe(200);
  });

  it('senza il parser il corpo vuoto è rifiutato', async () => {
    // La controprova: se Fastify smettesse di rifiutarlo, questo parser non
    // servirebbe più, e va saputo.
    const app = Fastify();
    app.post('/esci', async () => ({ uscito: true }));
    const risposta = await app.inject({ method: 'POST', url: '/esci', headers: JSON_HDR });
    expect(risposta.statusCode).toBe(400);
  });

  it('continua a leggere i corpi veri', async () => {
    const app = await server();
    const risposta = await app.inject({
      method: 'POST',
      url: '/eco',
      headers: JSON_HDR,
      payload: '{"livello":"ALTO"}',
    });
    expect(risposta.json()).toEqual({ livello: 'ALTO' });
  });

  it('resta sicuro contro __proto__', async () => {
    const app = await server();
    const risposta = await app.inject({
      method: 'POST',
      url: '/eco',
      headers: JSON_HDR,
      payload: '{"__proto__":{"admin":true}}',
    });
    expect(risposta.statusCode).toBe(400);
  });
});

describe('difese comuni dei pannelli', () => {
  it('rifiuta le scritture che arrivano da un’altra origine', () => {
    expect(richiestaDaAltraOrigine('POST', 'cross-site')).toBe(true);
    // L'altra porta della stessa macchina: stesso sito, origine diversa.
    expect(richiestaDaAltraOrigine('DELETE', 'same-site')).toBe(true);
    expect(richiestaDaAltraOrigine('POST', 'same-origin')).toBe(false);
    expect(richiestaDaAltraOrigine('POST', undefined)).toBe(false);
    // Le letture non si toccano: navigare verso il pannello da un link è normale.
    expect(richiestaDaAltraOrigine('GET', 'cross-site')).toBe(false);
  });

  it('di predefinito si fida solo dei proxy su rete privata', () => {
    expect(proxyFidati(undefined)).toBe('loopback,linklocal,uniquelocal');
    expect(proxyFidati('true')).toBe(true);
    expect(proxyFidati('2')).toBe(2);
  });

  it('il feed live accetta solo l’origine del pannello', () => {
    const pubblico = 'http://umbrel-1.esempio.ts.net:780';
    expect(origineAccettata('http://umbrel-1.esempio.ts.net:780', 'interno:8080', pubblico)).toBe(true);
    // Il pannello degli streamer, sulla stessa macchina.
    expect(origineAccettata('http://umbrel-1.esempio.ts.net:781', 'interno:8080', pubblico)).toBe(false);
    // Accesso diretto senza proxy.
    expect(origineAccettata('http://192.168.1.77:780', '192.168.1.77:780', pubblico)).toBe(true);
    expect(origineAccettata(undefined, 'x', pubblico)).toBe(true);
  });
});

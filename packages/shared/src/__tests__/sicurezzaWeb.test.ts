import { describe, expect, it } from 'vitest';
import { origineAccettata, proxyFidati, richiestaDaAltraOrigine } from '../sicurezzaWeb.js';

/* ═══════════════════════════════════════════════════════════════════════
   LE DIFESE DEI PANNELLI, E COSA NON DEVONO ROMPERE

   Queste tre funzioni sono arrivate senza test. Sono le più delicate del
   pannello: sbagliate in un verso lasciano passare le richieste forgiate
   dalla porta 781, sbagliate nell'altro chiudono fuori chi il pannello lo
   usa davvero — e il secondo guasto si scopre solo quando un salvataggio
   risponde 403.

   Per questo ogni difesa ha accanto il caso legittimo che non deve fermare.
   Il più importante è il pannello aperto con l'indirizzo IP invece che col
   nome: è così che lo apre chi non ha il DNS di casa configurato.
   ═══════════════════════════════════════════════════════════════════════ */

describe('proxy fidati', () => {
  /*
   * Il guasto di prima: `trustProxy: true` credeva a chiunque scrivesse il
   * proprio indirizzo in X-Forwarded-For, e il limite di frequenza contava
   * ogni richiesta come un visitatore nuovo.
   */
  it('senza configurazione non si fida di tutti', () => {
    expect(proxyFidati(undefined)).not.toBe(true);
    expect(proxyFidati('')).not.toBe(true);
  });

  it('senza configurazione si fida delle reti private, dove sta il proxy di Umbrel', () => {
    // Il proxy di umbrelOS sta su 10.21.0.0/16: è `uniquelocal`.
    expect(proxyFidati(undefined)).toBe('loopback,linklocal,uniquelocal');
  });

  it('TRUST_PROXY si legge per quello che è', () => {
    expect(proxyFidati('true')).toBe(true);
    expect(proxyFidati('false')).toBe(false);
    expect(proxyFidati('2')).toBe(2);
    expect(proxyFidati(' 10.0.0.0/8 ')).toBe('10.0.0.0/8');
  });
});

describe('richieste da un’altra origine', () => {
  /*
   * L'attacco: una pagina sulla porta 781 — quella esposta a Internet — che
   * scrive sul pannello della 780. Per il browser è lo stesso sito, quindi
   * manda i cookie; `Sec-Fetch-Site` però dice `same-site`, non
   * `same-origin`.
   */
  it('rifiuta una scrittura dall’altra porta della stessa macchina', () => {
    expect(richiestaDaAltraOrigine('POST', 'same-site')).toBe(true);
    expect(richiestaDaAltraOrigine('DELETE', 'same-site')).toBe(true);
  });

  it('rifiuta una scrittura da un altro sito', () => {
    expect(richiestaDaAltraOrigine('PUT', 'cross-site')).toBe(true);
  });

  // La controprova: le richieste del pannello stesso devono passare.
  it('lascia passare le scritture del pannello stesso', () => {
    expect(richiestaDaAltraOrigine('POST', 'same-origin')).toBe(false);
    expect(richiestaDaAltraOrigine('PATCH', 'same-origin')).toBe(false);
  });

  it('non tocca le letture, da dovunque vengano', () => {
    expect(richiestaDaAltraOrigine('GET', 'cross-site')).toBe(false);
    expect(richiestaDaAltraOrigine('HEAD', 'same-site')).toBe(false);
  });

  it('senza l’intestazione lascia passare: chi non la manda non porta cookie', () => {
    // Il webhook di Twitch, un client da riga di comando.
    expect(richiestaDaAltraOrigine('POST', undefined)).toBe(false);
  });

  it('il metodo in minuscolo non è un modo per passare', () => {
    expect(richiestaDaAltraOrigine('post', 'same-site')).toBe(true);
  });

  it('un’intestazione ripetuta si legge dalla prima', () => {
    expect(richiestaDaAltraOrigine('POST', ['same-site', 'same-origin'])).toBe(true);
  });
});

describe('origine del feed live', () => {
  const PUBBLICO = 'http://umbrel-1.taila0adf7.ts.net:780';

  it('accetta il pannello aperto dall’indirizzo pubblico', () => {
    expect(origineAccettata(PUBBLICO, 'umbrel-1.taila0adf7.ts.net:780', PUBBLICO)).toBe(true);
  });

  /*
   * Il caso che non deve rompersi: il pannello aperto con l'IP. L'origine
   * non coincide con PUBLIC_URL, ma coincide con l'host della richiesta.
   */
  it('accetta il pannello aperto con l’indirizzo IP', () => {
    expect(origineAccettata('http://192.168.1.77:780', '192.168.1.77:780', PUBBLICO)).toBe(true);
  });

  it('dietro un proxy che riscrive l’host, accetta PUBLIC_URL', () => {
    expect(origineAccettata(PUBBLICO, 'g-d-app-store-gd-angel_angel_1:8080', PUBBLICO)).toBe(
      true,
    );
  });

  // L'attacco, e la controprova dei casi sopra.
  it('rifiuta una pagina servita dalla porta 781', () => {
    expect(origineAccettata('http://192.168.1.77:781', '192.168.1.77:780', PUBBLICO)).toBe(false);
  });

  it('rifiuta un’origine che non si legge', () => {
    expect(origineAccettata('non-un-indirizzo', '192.168.1.77:780', PUBBLICO)).toBe(false);
  });

  it('con PUBLIC_URL malformata resta il confronto con l’host', () => {
    expect(origineAccettata('http://192.168.1.77:780', '192.168.1.77:780', 'rotto')).toBe(true);
    expect(origineAccettata('http://altro:780', '192.168.1.77:780', 'rotto')).toBe(false);
  });

  it('senza origine lascia passare: non viene da una pagina', () => {
    expect(origineAccettata(undefined, '192.168.1.77:780', PUBBLICO)).toBe(true);
  });
});

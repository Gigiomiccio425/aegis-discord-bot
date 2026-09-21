import { afterEach, describe, expect, it, vi } from 'vitest';
import { destinazioneAmmessa, expandUrl, indirizzoPrivato } from '../reputation.js';

/* ═══════════════════════════════════════════════════════════════════════
   DOVE PUÒ ARRIVARE IL BOT SEGUENDO UN LINK

   `expandUrl` riceve un indirizzo scritto da chiunque abbia accesso alla
   chat, e ci fa una richiesta. Il bot gira dentro la rete dell'Umbrel:
   senza controlli, un messaggio di una riga lo fa bussare a `postgres`, a
   `redis`, al router, ai metadati della macchina.

   Il guasto non si vede mai nei log — la richiesta parte e basta, e chi
   l'ha chiesta legge la risposta dal tempo che ci mette. Perciò serve un
   test: è l'unico posto in cui questo comportamento diventa visibile.

   Ogni prova qui sotto ha la sua controprova. Un test che dice solo «gli
   indirizzi interni si bloccano» passerebbe anche con una funzione che
   blocca tutto, bot compreso.
   ═══════════════════════════════════════════════════════════════════════ */

/** Un DNS finto: senza, ogni test farebbe una query vera. */
const dnsFinto =
  (mappa: Record<string, string[]>) =>
  async (host: string): Promise<string[]> => {
    const trovati = mappa[host];
    if (!trovati) throw new Error(`nome sconosciuto: ${host}`);
    return trovati;
  };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('indirizzi che il bot non deve contattare', () => {
  it.each([
    ['127.0.0.1', 'questa macchina'],
    ['0.0.0.0', 'questa macchina, altro modo di scriverlo'],
    ['10.0.0.5', 'rete privata'],
    ['172.17.0.2', 'rete Docker: qui vivono postgres e redis'],
    ['192.168.1.1', 'il router di casa'],
    ['169.254.169.254', 'metadati della macchina virtuale'],
    ['100.100.0.1', 'CGNAT'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'questa macchina, in IPv6'],
    ['fd00::1', 'rete locale IPv6'],
    ['fe80::1', 'link-local IPv6'],
    ['::ffff:127.0.0.1', 'IPv4 travestito da IPv6'],
    ['::ffff:7f00:1', 'lo stesso, come lo scrive Node'],
    ['64:ff9b::127.0.0.1', 'IPv4 dentro NAT64'],
  ])('%s è privato (%s)', (ip) => {
    expect(indirizzoPrivato(ip)).toBe(true);
  });

  /*
   * La controprova. Senza, basterebbe `return true` per far passare tutto
   * il blocco qui sopra — e il bot non espanderebbe più nessun link.
   */
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111'])(
    '%s è pubblico, e si contatta',
    (ip) => {
      expect(indirizzoPrivato(ip)).toBe(false);
    },
  );

  it('quello che non si riesce a leggere si tratta come privato', () => {
    // Fallire aperto qui significa che una forma strana di indirizzo
    // diventa il modo per aggirare tutto il resto.
    expect(indirizzoPrivato('999.1.1.1')).toBe(true);
    expect(indirizzoPrivato('')).toBe(true);
    expect(indirizzoPrivato('non-un-indirizzo')).toBe(true);
  });
});

describe('destinazioni ammesse', () => {
  const dns = dnsFinto({
    'esempio.com': ['93.184.216.34'],
    'interno.esempio.com': ['10.0.0.9'],
    'misto.esempio.com': ['93.184.216.34', '127.0.0.1'],
  });

  it('un dominio pubblico si contatta', async () => {
    expect(await destinazioneAmmessa('https://esempio.com/pagina', dns)).toBe(true);
  });

  /*
   * IL CONTROLLO SUL NOME NON BASTA
   *
   * `interno.esempio.com` è un nome come un altro: nessuna regola scritta
   * sul testo dell'indirizzo lo fermerebbe. Quello che conta è dove punta.
   */
  it('un dominio che punta dentro la rete non si contatta', async () => {
    expect(await destinazioneAmmessa('http://interno.esempio.com/', dns)).toBe(false);
  });

  /*
   * Un nome che risponde con un indirizzo pubblico **e** uno privato basta a
   * rifiutare: è la forma più comune di DNS rebinding, e accettare il primo
   * indirizzo pubblico della lista sarebbe esattamente il modo di caderci.
   */
  it('basta un indirizzo privato fra quelli restituiti per rifiutare', async () => {
    expect(await destinazioneAmmessa('http://misto.esempio.com/', dns)).toBe(false);
  });

  it('un nome che non si risolve non si contatta', async () => {
    // Fallire chiuso: altrimenti rompere il DNS diventa il modo per passare.
    expect(await destinazioneAmmessa('http://mai-visto.esempio/', dns)).toBe(false);
  });

  it('gli indirizzi numerici non passano dal DNS, e valgono uguale', async () => {
    // `http://2130706433/` lo normalizza `new URL` in 127.0.0.1: un controllo
    // fatto sul testo scritto da chi manda il messaggio non lo vedrebbe.
    expect(await destinazioneAmmessa('http://2130706433/', dns)).toBe(false);
    expect(await destinazioneAmmessa('http://0x7f000001/', dns)).toBe(false);
    expect(await destinazioneAmmessa('http://[::1]:6379/', dns)).toBe(false);
    expect(await destinazioneAmmessa('http://93.184.216.34/', dns)).toBe(true);
  });

  it.each(['file:///etc/passwd', 'gopher://esempio.com/', 'ftp://esempio.com/'])(
    '%s non è http: non si contatta',
    async (url) => {
      expect(await destinazioneAmmessa(url, dns)).toBe(false);
    },
  );
});

describe('espansione dei link', () => {
  const dns = dnsFinto({
    'accorciatore.esempio': ['93.184.216.34'],
    'destinazione.esempio': ['93.184.216.34'],
    'ostile.esempio': ['93.184.216.34'],
  });

  /** Una risposta finta con la sola intestazione che ci interessa. */
  const rispostaCon = (location?: string) =>
    ({
      headers: { get: (nome: string) => (nome === 'location' ? (location ?? null) : null) },
    }) as unknown as Response;

  it('segue il redirect e restituisce la catena', async () => {
    const chiamate: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      chiamate.push(url);
      return rispostaCon(chiamate.length === 1 ? 'https://destinazione.esempio/vero' : undefined);
    });

    const esito = await expandUrl('https://accorciatore.esempio/abc', { risolvi: dns });

    expect(esito?.finalUrl).toBe('https://destinazione.esempio/vero');
    expect(esito?.chain).toHaveLength(2);
  });

  /*
   * IL SALTO VERSO L'INTERNO
   *
   * Questo è l'attacco vero, e non lo ferma nessun controllo fatto solo
   * sull'indirizzo di partenza: si scrive in chat un link a un host esterno
   * qualunque, e quell'host risponde `Location: http://127.0.0.1:6379/`.
   * Se il bot lo seguisse, chiunque potrebbe far bussare il bot a Redis.
   */
  it('non segue un redirect che punta dentro la rete', async () => {
    const visitati: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      visitati.push(url);
      return rispostaCon(visitati.length === 1 ? 'http://127.0.0.1:6379/' : undefined);
    });

    const esito = await expandUrl('https://ostile.esempio/trappola', { risolvi: dns });

    expect(visitati, 'la richiesta verso 127.0.0.1 non deve partire').toEqual([
      'https://ostile.esempio/trappola',
    ]);
    expect(esito).toBeUndefined();
  });

  it('un indirizzo interno di partenza non si contatta nemmeno una volta', async () => {
    const visitati: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      visitati.push(url);
      return rispostaCon(undefined);
    });

    const esito = await expandUrl('http://192.168.1.1/admin', { risolvi: dns });

    expect(visitati).toEqual([]);
    expect(esito).toBeUndefined();
  });
});

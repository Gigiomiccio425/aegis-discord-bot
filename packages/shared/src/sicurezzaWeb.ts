/* ═══════════════════════════════════════════════════════════════════════
   DIFESE COMUNI DEI DUE PANNELLI

   Il pannello Discord e quello degli streamer girano sulla stessa macchina,
   su due porte. Per il browser sono due **origini** diverse ma lo stesso
   **sito**: e i cookie `SameSite=Lax`, su cui contava la difesa contro le
   richieste forgiate, guardano il sito, non l'origine. Una pagina servita
   dalla porta 781 — quella esposta a Internet — manda i cookie della 780.

   Queste funzioni sono pure, senza dipendenze da Fastify: le usano entrambi
   i server nello stesso modo.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Il valore di `trustProxy` per Fastify.
 *
 * Senza configurazione: solo i proxy su rete privata o sulla stessa macchina
 * — il proxy di Umbrel, un tunnel Cloudflare locale, Caddy nel compose. È la
 * differenza fra «l'indirizzo lo dice il proxy» e «l'indirizzo lo dice chi
 * visita»: con `true`, come prima, chiunque poteva scriverlo da sé in
 * X-Forwarded-For e il limite di frequenza contava ogni richiesta come un
 * visitatore nuovo.
 */
export function proxyFidati(valore: string | undefined): boolean | number | string {
  const pulito = valore?.trim();
  if (!pulito) return 'loopback,linklocal,uniquelocal';
  if (pulito === 'true') return true;
  if (pulito === 'false') return false;
  if (/^\d+$/.test(pulito)) return Number(pulito);
  return pulito;
}

const METODI_CHE_SCRIVONO = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Una richiesta che cambia qualcosa, partita da un'altra origine?
 *
 * I browser moderni dicono da dove parte ogni richiesta nell'intestazione
 * `Sec-Fetch-Site`, e una pagina non può falsificarla. Si accettano solo
 * `same-origin` e `none` (l'indirizzo digitato a mano). `same-site` no: è
 * esattamente il caso dell'altra porta della stessa macchina.
 *
 * Senza l'intestazione si lascia passare: la mandano tutti i browser in uso
 * da anni, e chi non la manda — un client da riga di comando, il webhook di
 * Twitch — non porta con sé i cookie di nessuno.
 */
export function richiestaDaAltraOrigine(
  metodo: string,
  secFetchSite: string | string[] | undefined,
): boolean {
  if (!METODI_CHE_SCRIVONO.has(metodo.toUpperCase())) return false;
  const valore = Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite;
  if (!valore) return false;
  return valore !== 'same-origin' && valore !== 'none';
}

/**
 * L'origine di una connessione WebSocket è quella del pannello?
 *
 * Il WebSocket non passa dai controlli di CORS: il browser apre la
 * connessione da qualunque pagina, con i cookie del sito. Senza questo
 * controllo una pagina dell'altra porta potrebbe leggere il registro in tempo
 * reale.
 *
 * Si accetta l'origine di `PUBLIC_URL` — l'unico indirizzo su cui esiste il
 * cookie di sessione, perché è lì che torna l'accesso con Discord — oppure
 * quella che coincide con l'host della richiesta, per l'accesso diretto. Il
 * solo confronto con l'host non basterebbe: dietro il proxy di Umbrel l'host
 * può arrivare riscritto, e il feed live smetterebbe di funzionare.
 */
export function origineAccettata(
  origin: string | undefined,
  host: string | undefined,
  pubblico?: string,
): boolean {
  if (!origin) return true;
  let letta: URL;
  try {
    letta = new URL(origin);
  } catch {
    return false;
  }
  if (host && letta.host === host) return true;
  if (pubblico) {
    try {
      if (new URL(pubblico).origin === letta.origin) return true;
    } catch {
      // PUBLIC_URL malformata: resta il confronto con l'host.
    }
  }
  return false;
}

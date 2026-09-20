import { lookup } from 'node:dns/promises';

/* ═══════════════════════════════════════════════════════════════════════
   DOVE LO SCANNER PUÒ ANDARE

   Lo scanner segue i redirect dei link scritti in chat, per sapere dove
   portano davvero. Detto così è una funzione di sicurezza; detto in un altro
   modo è: **chiunque può far fare una richiesta HTTP al bot, verso un
   indirizzo che scrive lui**.

   Dentro Docker, «un indirizzo che scrive lui» comprende il pannello sulla
   porta 8080, il database, Redis, gli altri container della macchina, e su
   un server in cloud l'indirizzo dei metadati — quello che restituisce le
   credenziali dell'istanza. Il bot non riporta indietro il contenuto, quindi
   non è una lettura; ma è un colpo battuto dall'interno della rete, ed è
   esattamente la premessa che nessuno vuole regalare.

   Qui si guarda dove porta il link *prima* di chiederlo: solo http e https,
   solo le porte del web, e solo indirizzi pubblici — con la risoluzione DNS
   fatta a mano, perché un nome può puntare a 127.0.0.1 e il nome da solo non
   lo dice.
   ═══════════════════════════════════════════════════════════════════════ */

/** Porte ammesse: quelle del web. Tutto il resto è un servizio interno. */
const PORTE = new Set(['', '80', '443', '8080', '8443']);

/**
 * Un indirizzo che non deve essere raggiunto da un link scritto da altri.
 *
 * L'elenco è per blocco e non per permesso: gli intervalli riservati sono
 * noti e finiti, mentre «tutto il resto di Internet» non si può elencare.
 */
export function indirizzoInterno(ip: string): boolean {
  const pulito = ip.replace(/^\[|\]$/g, '').toLowerCase();

  // IPv4, anche mappato in IPv6 (::ffff:127.0.0.1).
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(pulito);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true; // questa rete, privata, loopback
    if (a === 169 && b === 254) return true; // link-local: qui vivono i metadati in cloud
    if (a === 172 && b >= 16 && b <= 31) return true; // privata: le reti di Docker
    if (a === 192 && b === 168) return true; // privata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT: gli indirizzi di Tailscale
    if (a === 192 && b === 0) return true; // riservata (0.0/24, 2.0/24)
    if (a === 198 && (b === 18 || b === 19)) return true; // collaudo
    if (a >= 224) return true; // multicast e riservati
    return false;
  }

  if (pulito === '::' || pulito === '::1') return true; // non specificato, loopback
  if (pulito.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(pulito)) return true; // unique local
  if (pulito.startsWith('ff')) return true; // multicast
  return false;
}

export interface EsitoDestinazione {
  ok: boolean;
  motivo?: string;
}

/**
 * Il link si può chiedere?
 *
 * Risolve il nome e controlla **tutti** gli indirizzi che restituisce: un
 * nome che risponde con un indirizzo pubblico e uno interno va rifiutato,
 * altrimenti basta riprovare finché non esce quello giusto.
 */
export async function destinazioneAmmessa(url: string): Promise<EsitoDestinazione> {
  let letta: URL;
  try {
    letta = new URL(url);
  } catch {
    return { ok: false, motivo: 'indirizzo non interpretabile' };
  }

  if (letta.protocol !== 'http:' && letta.protocol !== 'https:') {
    return { ok: false, motivo: `schema non ammesso (${letta.protocol})` };
  }
  if (!PORTE.has(letta.port)) {
    return { ok: false, motivo: `porta non ammessa (${letta.port})` };
  }

  // Un indirizzo numerico si controlla direttamente: `lookup` su un IP
  // restituisce l'IP stesso, ma passare dal DNS per niente è un giro in più.
  const nome = letta.hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(nome) || nome.includes(':')) {
    return indirizzoInterno(nome) ? { ok: false, motivo: 'indirizzo interno' } : { ok: true };
  }

  try {
    const indirizzi = await lookup(nome, { all: true });
    if (indirizzi.length === 0) return { ok: false, motivo: 'nome senza indirizzi' };
    if (indirizzi.some((voce) => indirizzoInterno(voce.address))) {
      return { ok: false, motivo: 'il nome punta a un indirizzo interno' };
    }
    return { ok: true };
  } catch {
    // Nome che non si risolve: non c'è niente da chiedere, e non è un errore
    // da propagare — il link resta com'è.
    return { ok: false, motivo: 'nome non risolvibile' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   LA POSTA DEL BOT

   Come gli altri processi chiedono qualcosa al bot Discord.

   Il bot è l'unico processo collegato al gateway: pannello, worker e bot
   Twitch non parlano con Discord, chiedono a lui. Finora lo facevano con un
   `PUBLISH` su Redis, e il pub/sub ha una proprietà che qui è un difetto:
   **consegna solo a chi ascolta in quel momento**. Il messaggio non resta da
   nessuna parte, e chi lo manda non sa se qualcuno l'ha ricevuto.

   In pratica, tre guasti con lo stesso sintomo — «il pannello dice fatto e
   non è successo niente»:

   • il bot si stava riavviando, o era nei secondi fra l'avvio e il
     collegamento a Discord: il comando si perdeva;
   • il comando arrivava ma falliva — un permesso mancante, un membro non
     più nel server: l'errore finiva nei log del bot e il pannello aveva già
     risposto «ok» un istante dopo averlo spedito;
   • un sondaggio scaduto mentre il bot era giù non veniva chiuso finché il
     worker non ripubblicava, e un giveaway allo stesso modo.

   ── Come funziona adesso ───────────────────────────────────────────────

   Uno **stream** Redis con un gruppo di consumo. Il comando resta nello
   stream finché il bot non lo conferma, quindi sopravvive a un riavvio; il
   bot lo conferma solo dopo averlo eseguito; e l'esito — fatto, fallito e
   perché — torna al mittente, che può aspettarlo o chiederlo dopo.

   Ogni comando ha una **scadenza**. Un lockdown chiesto durante un raid e
   consegnato un'ora dopo, al rientro del bot, non è un lockdown: è una
   sorpresa. Oltre la scadenza il bot non lo esegue e risponde «scaduto».

   E una **chiave anti-doppione**, per i comandi che il worker ripete ogni
   minuto: con il bot giù per un'ora, sessanta «chiudi quel sondaggio»
   identici non servono a niente.
   ═══════════════════════════════════════════════════════════════════════ */

/** Il minimo di Redis che serve: `call` c'è in ioredis e non lega a una versione. */
export interface RedisPosta {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export const Posta = {
  stream: 'aegis:bot:posta',
  gruppo: 'bot',
  /** Esito di un comando, letto dal mittente. */
  esito: (id: string) => `aegis:bot:esito:${id}`,
  /** Presente finché c'è un comando uguale in attesa. */
  attesa: (chiave: string) => `aegis:bot:attesa:${chiave}`,
  /**
   * Battito del bot, scritto solo **dopo** il collegamento a Discord.
   *
   * La versione dichiarata non basta: il bot la scrive prima del login, e un
   * bot che non riesce a collegarsi risulterebbe vivo per tre minuti.
   */
  pronto: 'aegis:bot:pronto',
} as const;

/** Quanto resta leggibile l'esito di un comando. */
export const ESITO_TTL_SEC = 900;
/** Lunghezza massima dello stream: oltre, i più vecchi si scartano. */
const MAX_STREAM = 5000;

export interface ComandoBot {
  action: string;
  guildId: string;
  [campo: string]: unknown;
}

export type Esito =
  | { stato: 'fatto'; messaggio: string; dati?: unknown }
  | { stato: 'fallito'; messaggio: string }
  | { stato: 'scaduto'; messaggio: string };

export interface EsitoSalvato {
  stato: Esito['stato'];
  messaggio: string;
  dati?: unknown;
  guildId: string;
  action: string;
  finitoIl: number;
}

export interface Consegna {
  id: string;
  /** Il bot era collegato a Discord quando il comando è partito? */
  botInLinea: boolean;
  /** `null` finché il bot non ha finito — o non ha ancora cominciato. */
  esito: EsitoSalvato | null;
  /** Il comando era già in attesa: questo è l'identificativo di quello. */
  doppione?: boolean;
}

/**
 * Scadenza per azione, in millisecondi.
 *
 * Il criterio è una domanda sola: se il bot lo ricevesse adesso, a questa
 * distanza di tempo, farebbe ancora la cosa che chi l'ha chiesto voleva?
 */
const SCADENZE: Record<string, number> = {
  // Chiesti da una persona che sta guardando lo schermo, per un fatto in corso.
  'lockdown.enable': 3 * 60_000,
  'message.send': 10 * 60_000,
  'quarantine.apply': 15 * 60_000,
  // Riaprire va bene anche tardi: chi ha chiuso vuole che si riapra.
  'lockdown.disable': 6 * 3_600_000,
  // Correzioni e scadenze: vanno fatte, anche in ritardo.
  'case.undo': 24 * 3_600_000,
  'quarantine.lift': 24 * 3_600_000,
  'poll.close': 24 * 3_600_000,
  'giveaway.draw': 24 * 3_600_000,
  'watch.add': 24 * 3_600_000,
  'watch.remove': 24 * 3_600_000,
  'commands.reload': 24 * 3_600_000,
  'server.setup': 3_600_000,
  'snapshot.create': 3_600_000,
  // Il worker li ripete da solo: uno perso si recupera al giro dopo.
  'events.reminders': 2 * 60_000,
  'config.reloaded': 60_000,
  'twitch.log': 30 * 60_000,
};
const SCADENZA_PREDEFINITA = 30 * 60_000;

export function scadenzaDi(action: string): number {
  return SCADENZE[action] ?? SCADENZA_PREDEFINITA;
}

function nuovoId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Manda un comando al bot.
 *
 * Con `attendiMs` aspetta l'esito fino a quel tempo; senza, ritorna appena il
 * comando è in coda. In entrambi i casi il comando **non si perde**: se il
 * bot è giù resta nello stream e parte al rientro, entro la sua scadenza.
 *
 * Con `chiave`, un comando uguale già in attesa non viene duplicato.
 */
export async function inviaAlBot(
  redis: RedisPosta,
  comando: ComandoBot,
  opzioni: { attendiMs?: number; chiave?: string; scadenzaMs?: number } = {},
): Promise<Consegna> {
  const id = nuovoId();
  const botInLinea = (await redis.get(Posta.pronto).catch(() => null)) !== null;
  const scadenza = opzioni.scadenzaMs ?? scadenzaDi(comando.action);

  if (opzioni.chiave) {
    const libero = await redis.call(
      'SET',
      Posta.attesa(opzioni.chiave),
      id,
      'NX',
      'PX',
      scadenza,
    );
    if (libero !== 'OK') {
      const esistente = (await redis.get(Posta.attesa(opzioni.chiave))) ?? id;
      return { id: esistente, botInLinea, esito: null, doppione: true };
    }
  }

  await redis.call(
    'XADD',
    Posta.stream,
    'MAXLEN',
    '~',
    MAX_STREAM,
    '*',
    'id',
    id,
    'c',
    JSON.stringify(comando),
    't',
    Date.now(),
    's',
    scadenza,
    'k',
    opzioni.chiave ?? '',
  );

  const esito = opzioni.attendiMs ? await attendiEsito(redis, id, opzioni.attendiMs) : null;
  return { id, botInLinea, esito };
}

/** Legge l'esito, se c'è già. */
export async function leggiEsito(redis: RedisPosta, id: string): Promise<EsitoSalvato | null> {
  const grezzo = await redis.get(Posta.esito(id)).catch(() => null);
  if (!grezzo) return null;
  try {
    return JSON.parse(grezzo) as EsitoSalvato;
  } catch {
    return null;
  }
}

/**
 * Aspetta l'esito controllando a intervalli crescenti.
 *
 * Interrogare invece di sottoscrivere: una sottoscrizione chiede una
 * connessione Redis dedicata per ogni attesa, e per richieste che durano da
 * qualche decimo di secondo a qualche secondo il conto non torna.
 */
export async function attendiEsito(
  redis: RedisPosta,
  id: string,
  attendiMs: number,
): Promise<EsitoSalvato | null> {
  const fine = Date.now() + attendiMs;
  let pausa = 80;
  while (Date.now() < fine) {
    const esito = await leggiEsito(redis, id);
    if (esito) return esito;
    await new Promise((risolvi) => setTimeout(risolvi, Math.min(pausa, fine - Date.now())));
    pausa = Math.min(pausa * 1.5, 600);
  }
  return leggiEsito(redis, id);
}

/* ── Lato bot ─────────────────────────────────────────────────────────── */

export interface Busta {
  /** Identificativo dello stream, per la conferma. */
  voce: string;
  id: string;
  comando: ComandoBot | null;
  creatoIl: number;
  scadenzaMs: number;
  chiave: string;
}

/**
 * Da una voce grezza di XREADGROUP a una busta.
 *
 * Una voce illeggibile non deve fermare la coda: esce con `comando: null`,
 * il bot la conferma e la scarta. Tenerla significherebbe rileggerla a ogni
 * riavvio per sempre.
 */
export function apriBusta(voce: string, campi: string[]): Busta {
  const mappa = new Map<string, string>();
  for (let i = 0; i + 1 < campi.length; i += 2) mappa.set(campi[i]!, campi[i + 1]!);

  let comando: ComandoBot | null = null;
  try {
    const grezzo = JSON.parse(mappa.get('c') ?? 'null') as unknown;
    if (
      grezzo &&
      typeof grezzo === 'object' &&
      typeof (grezzo as ComandoBot).action === 'string' &&
      typeof (grezzo as ComandoBot).guildId === 'string'
    ) {
      comando = grezzo as ComandoBot;
    }
  } catch {
    comando = null;
  }

  return {
    voce,
    id: mappa.get('id') ?? voce,
    comando,
    creatoIl: Number(mappa.get('t') ?? 0),
    scadenzaMs: Number(mappa.get('s') ?? SCADENZA_PREDEFINITA),
    chiave: mappa.get('k') ?? '',
  };
}

export function scaduta(busta: Busta, adesso = Date.now()): boolean {
  return adesso - busta.creatoIl > busta.scadenzaMs;
}

/**
 * Le voci lette da XREADGROUP, nella forma che restituisce Redis:
 * `[[stream, [[id, [campo, valore, …]], …]]]`, oppure `null` a vuoto.
 */
export function leggiRisposta(risposta: unknown): { voce: string; campi: string[] }[] {
  if (!Array.isArray(risposta)) return [];
  const out: { voce: string; campi: string[] }[] = [];
  for (const flusso of risposta) {
    const voci = Array.isArray(flusso) ? (flusso[1] as unknown) : null;
    if (!Array.isArray(voci)) continue;
    for (const voce of voci) {
      if (!Array.isArray(voce) || typeof voce[0] !== 'string') continue;
      // Una voce cancellata mentre era in attesa torna con i campi a null.
      const campi = Array.isArray(voce[1]) ? (voce[1] as unknown[]).map(String) : [];
      out.push({ voce: voce[0], campi });
    }
  }
  return out;
}

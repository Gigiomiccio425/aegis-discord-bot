import {
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import {
  componiDocumento,
  FORMATO_LEGGERO,
  leggiDocumento,
  runningVersion,
  type DocumentoLeggero,
} from '@angel/shared';
import { childLogger } from '../core/logger.js';
import { getGuildConfig } from '../core/config.js';

const log = childLogger('copiaLeggera');

/**
 * Come è andata una pubblicazione, detto a parole: per il log quando la
 * chiede il worker, per la risposta quando la chiede qualcuno col comando.
 */
export type Esito =
  | { stato: 'fatto'; messaggio: string; dati?: unknown }
  | { stato: 'fallito'; messaggio: string };

/**
 * Il rifiuto normale: la copia leggera non è accesa per quel server.
 *
 * Il worker la chiede per tutti i server e lascia decidere il bot, che ha la
 * configurazione. Quindi questo esito arriva ogni giorno da ogni server che
 * non l'ha accesa, e non è un guasto: chi lo registra non deve farne un
 * avviso.
 */
export const COPIA_SPENTA = 'la copia leggera è spenta per questo server';

/* ═══════════════════════════════════════════════════════════════════════
   COMPORRE E PUBBLICARE LA COPIA CHE SOPRAVVIVE ALLA MACCHINA

   Il formato sta in `@angel/shared`, ed è puro: compone e rilegge stringhe.
   Qui c'è quello che il formato non può sapere — come si guarda dentro una
   gilda Discord, e dove si può pubblicare senza fare danni.

   ── Il canale non è un dettaglio ───────────────────────────────────────

   Questo file dice quali difese sono accese e con quali soglie. In un canale
   che leggono tutti è una mappa per chi vuole aggirarle: sapere che
   l'anti-raid scatta a dieci ingressi in trenta secondi significa sapere di
   entrare in nove.

   Perciò si controlla, e si **rifiuta** invece di pubblicare e avvisare dopo.
   Un avviso dopo arriva quando il file è già leggibile da tutti, e su Discord
   cancellarlo non lo toglie a chi l'ha già scaricato.
   ═══════════════════════════════════════════════════════════════════════ */

/** Nome del file pubblicato. `.md` perché Discord lo mostra in anteprima. */
export function nomeFile(guildId: string, quando = new Date()): string {
  return `angel-copia-${guildId}-${quando.toISOString().slice(0, 10)}.md`;
}

/**
 * Il canale è adatto a ricevere la copia?
 *
 * Restituisce il motivo del rifiuto, oppure `null` se va bene.
 */
export function motivoRifiuto(guild: Guild, canale: unknown): string | null {
  if (!canale || typeof canale !== 'object') return 'il canale non esiste più';

  const c = canale as {
    type?: number;
    permissionsFor?: (id: unknown) => { has: (flag: bigint) => boolean } | null;
  };

  if (c.type !== ChannelType.GuildText) {
    return 'la copia si pubblica in un canale testuale, e quello scelto non lo è';
  }

  const perEveryone = c.permissionsFor?.(guild.roles.everyone);
  if (perEveryone?.has(PermissionFlagsBits.ViewChannel)) {
    return (
      'quel canale è leggibile da @everyone. La copia dice quali difese sono accese e ' +
      'con quali soglie: in un canale aperto è una mappa per chi vuole aggirarle. ' +
      'Scegline uno riservato allo staff'
    );
  }

  const perBot = guild.members.me ? c.permissionsFor?.(guild.members.me) : null;
  if (perBot && !perBot.has(PermissionFlagsBits.AttachFiles)) {
    return 'in quel canale non posso allegare file';
  }

  return null;
}

/** Raccoglie dalla gilda e dal database quello che vale la pena salvare. */
export async function componiPerGilda(guild: Guild): Promise<DocumentoLeggero> {
  const configurazione = await getGuildConfig(guild.id);
  const impostazioni = configurazione.general.copiaLeggera;

  const prisma = getPrisma();
  const [comandi, sorvegliati] = await Promise.all([
    prisma.customCommand.findMany({
      where: { guildId: guild.id },
      select: { name: true, description: true },
    }),
    prisma.userProfile.findMany({
      where: { guildId: guild.id, watchedAt: { not: null } },
      select: { userId: true },
    }),
  ]);

  /*
   * I ruoli in ordine di posizione, dal più alto.
   *
   * L'ordine non è estetico: in Discord decide chi può moderare chi, e una
   * gerarchia ricostruita a caso è una gerarchia sbagliata. Chi rifà i ruoli
   * a mano ha bisogno di quest'ordine.
   */
  const ruoli = [...guild.roles.cache.values()]
    .sort((a, b) => b.position - a.position)
    .map((ruolo) => ({
      id: ruolo.id,
      nome: ruolo.name,
      colore: ruolo.color,
      posizione: ruolo.position,
      permessi: ruolo.permissions.bitfield.toString(),
    }));

  const canali = [...guild.channels.cache.values()].map((canale) => ({
    id: canale.id,
    nome: canale.name,
    tipo: canale.type as number,
    categoria: 'parent' in canale ? (canale.parent?.name ?? null) : null,
  }));

  const parole = configurazione.security.language.terms.map((voce) =>
    typeof voce === 'string' ? voce : String((voce as { term?: string }).term ?? ''),
  );

  return {
    formato: FORMATO_LEGGERO,
    angel: runningVersion(),
    guildId: guild.id,
    guildNome: guild.name,
    creatoIl: new Date().toISOString(),
    /*
     * Chi preferisce che le proprie soglie non stiano scritte fuori dalla
     * macchina lo dice qui, e in cambio le rimette a mano. Il documento resta
     * valido: il ripristino salta la parte che non c'è invece di applicare
     * mezza configurazione.
     */
    configurazione: impostazioni.includiConfigurazione ? configurazione : null,
    ruoli,
    canali,
    comandi: comandi.map((c) => ({ nome: c.name, risposta: c.description })),
    paroleVietate: parole.filter(Boolean),
    dominiAmmessi: configurazione.scanner.url.allowedDomains ?? [],
    sorvegliati: sorvegliati.map((s) => s.userId),
  };
}

/**
 * Compone e pubblica. Non lancia: l'esito torna a chi l'ha chiesto.
 *
 * Il lavoro notturno la chiama per ogni gilda, e una gilda che fallisce non
 * deve impedire alle altre di avere la loro copia.
 */
export async function pubblicaCopiaLeggera(client: Client, guildId: string): Promise<Esito> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { stato: 'fallito', messaggio: 'il bot non è in questo server' };

  const configurazione = await getGuildConfig(guildId);
  const impostazioni = configurazione.general.copiaLeggera;

  if (!impostazioni.enabled) {
    return { stato: 'fallito', messaggio: COPIA_SPENTA };
  }
  if (!impostazioni.channelId) {
    return { stato: 'fallito', messaggio: 'manca il canale dove pubblicare la copia leggera' };
  }

  const canale = guild.channels.cache.get(impostazioni.channelId);
  const rifiuto = motivoRifiuto(guild, canale);
  if (rifiuto) return { stato: 'fallito', messaggio: `copia non pubblicata: ${rifiuto}` };

  let testo: string;
  try {
    testo = componiDocumento(await componiPerGilda(guild));
  } catch (errore) {
    // `componiDocumento` lancia quando ci troverebbe dentro un segreto. È il
    // caso in cui non pubblicare è la cosa giusta, e va detto per intero.
    const messaggio = errore instanceof Error ? errore.message : String(errore);
    log.error({ err: errore, guildId }, 'copia leggera non composta');
    return { stato: 'fallito', messaggio };
  }

  const allegato = new AttachmentBuilder(Buffer.from(testo, 'utf8'), { name: nomeFile(guildId) });

  const inviabile = canale as unknown as { send?: (opzioni: unknown) => Promise<unknown> };
  if (typeof inviabile.send !== 'function') {
    return { stato: 'fallito', messaggio: 'in quel canale non si può scrivere' };
  }

  await inviabile.send({
    content:
      '🗂️ **Copia leggera** — quello che costerebbe ore rifare a mano.\n' +
      'Tienila: se la macchina che esegue ANGEL si rompe, da qui si riparte. ' +
      'Si rimette allegando questo file al comando di ripristino.',
    files: [allegato],
  });

  const byte = Buffer.byteLength(testo, 'utf8');
  log.info({ guildId, byte }, 'copia leggera pubblicata');
  return {
    stato: 'fatto',
    messaggio: `Copia leggera pubblicata (${Math.max(1, Math.round(byte / 1024))} KB).`,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   RIMETTERE

   Qui sta la protezione che il formato non poteva darsi da solo.

   L'impronta dentro il documento riconosce un file troncato o ritoccato per
   sbaglio, e basta: chi conosce il formato la ricalcola. Se il ripristino
   accettasse un file qualsiasi, chiunque possa mandare un messaggio con un
   allegato potrebbe consegnare una configurazione preparata e **spegnere le
   difese del server**.

   Perciò si accettano solo i file pubblicati dal bot stesso: l'allegato deve
   stare su un messaggio il cui autore è il bot. Non è una formalità, è
   l'unica cosa che separa un ripristino da un'iniezione di configurazione.
   ═══════════════════════════════════════════════════════════════════════ */

export interface EsitoRilettura {
  documento: DocumentoLeggero | null;
  problemi: string[];
}

/**
 * Rilegge un documento scaricato, con i controlli che contano.
 *
 * `autoreBot` dice se l'allegato stava su un messaggio scritto dal bot.
 * `guildId` è il server su cui si sta per rimettere: un documento di un altro
 * server nomina ruoli e canali che qui non esistono, e applicarlo
 * produrrebbe una configurazione che punta nel vuoto.
 */
export function accettaDocumento(
  testo: string,
  opzioni: { autoreBot: boolean; guildId: string },
): EsitoRilettura {
  if (!opzioni.autoreBot) {
    return {
      documento: null,
      problemi: [
        'accetto solo le copie che ho pubblicato io. Un file arrivato da qualcun altro ' +
          'potrebbe essere stato preparato per spegnere le difese: rimettere una ' +
          'configurazione è come cambiarla. Allega la copia dal canale dove la pubblico.',
      ],
    };
  }

  const { documento, problemi } = leggiDocumento(testo);
  if (!documento) return { documento: null, problemi };

  if (documento.guildId !== opzioni.guildId) {
    return {
      documento: null,
      problemi: [
        ...problemi,
        `questa copia è di un altro server (${documento.guildId}). I ruoli e i canali ` +
          'che nomina qui non esistono, e rimetterla lascerebbe una configurazione che ' +
          'punta nel vuoto.',
      ],
    };
  }

  return { documento, problemi };
}

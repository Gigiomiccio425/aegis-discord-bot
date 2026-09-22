import {
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type NonThreadGuildBasedChannel,
} from 'discord.js';
import { RedisKeys, type GuildConfig } from '@angel/shared';
import { childLogger } from './logger.js';
import { getRedis } from './redis.js';
import { humanDuration } from './i18n.js';
import { getGuildConfig } from './config.js';
import { recordEvent } from '../logging/auditLogger.js';
import { archivioBlocchi, type ArchivioBlocchi } from './bloccoDurevole.js';
import {
  bitScrittura,
  comeModifica,
  eBloccabile,
  pianificaBlocco,
  ripristinoEveryone,
  type CanaleDescritto,
  type PianoCanale,
} from '../security/pianoBlocco.js';

const log = childLogger('lockdown');

/* ═══════════════════════════════════════════════════════════════════════
   LOCKDOWN

   Cosa la prima versione sbagliava, tutto scoperto sul campo:

   1. Lo stato in Redis scadeva dopo 24 ore. Passate quelle, i canali restavano
      bloccati ma la revoca non trovava più l'elenco e usciva senza fare nulla.
      Ora la chiave non scade, e la scadenza è un campo dentro lo stato —
      sorvegliato da un ciclo che sopravvive ai riavvii.

   2. I canali venivano modificati uno alla volta, in serie: su cinquanta
      canali il blocco arrivava a raid concluso. Ora si procede a lotti.

   3. Si leggeva solo la cache dei canali, incompleta dopo un riavvio.

   4. **Gli errori sparivano.** Ogni canale veniva modificato dentro un
      `Promise.allSettled` il cui esito nessuno guardava: senza il permesso
      «Gestisci ruoli» il comando rispondeva «Canali chiusi: 0» e basta, e
      da fuori sembrava che il lockdown non funzionasse. Ora ogni canale non
      modificato è elencato con il motivo, e il permesso che manca si
      controlla prima di cominciare.

   5. **Le chat delle vocali e i ruoli con la scrittura concessa** restavano
      aperti: il perché sta in `pianoBlocco.ts`.

   6. **Due richieste insieme potevano bloccare due volte.** Il controllo
      «è già attivo?» e la scrittura dello stato erano due passi separati.
      Ora lo stato si reclama con un `SET NX`, che è un passo solo.

   7. **Uno stato rimasto indietro rendeva il comando inerte.** Se lo staff
      riapriva i canali a mano da Discord, lo stato restava in Redis e ogni
      lockdown successivo rispondeva «già attivo» senza fare niente. Ora uno
      stato di cui non resta traccia sui canali si riconosce e si scarta.
   ═══════════════════════════════════════════════════════════════════════ */

/** Permessi che fanno di un ruolo un ruolo di staff, ai fini del lockdown. */
const PERMESSI_DA_STAFF =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.BanMembers;

/** I bit che la prima versione toglieva, per rileggere i suoi stati. */
const BIT_V1 =
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.CreatePublicThreads;

export interface CanaleNonModificato {
  canaleId: string;
  nome: string;
  motivo: string;
}

export interface LockdownState {
  reason: string;
  /** Canali a cui è stato negato di scrivere a @everyone. */
  channels: string[];
  startedAt: number;
  /** Timestamp di revoca automatica. 0 = solo manuale. */
  expiresAt: number;
  /** Messaggi d'avviso pubblicati, per poterli sostituire alla revoca. */
  notices: { channelId: string; messageId: string }[];
  /*
   * I campi seguenti mancano negli stati scritti dalla prima versione: la
   * revoca li tratta come facoltativi e torna al comportamento di allora.
   */
  versione?: 2;
  /** Per canale: i bit negati e com'era @everyone prima. Bigint come stringhe. */
  dettagli?: Record<string, { bit: string; concessiPrima: string; esisteva: boolean }>;
  /** Permessi di ruoli ordinari riportati a «eredita», da riconcedere. */
  ruoli?: { canaleId: string; ruoloId: string; bit: string }[];
  /** Gli inviti erano già in pausa prima del blocco: la revoca non li riapre. */
  invitiGiaInPausa?: boolean;
  /** Canali che non è stato possibile chiudere. */
  falliti?: CanaleNonModificato[];
}

export interface EsitoBlocco {
  /** Canali chiusi a @everyone. */
  locked: number;
  /** Permessi di scrittura tolti a ruoli ordinari. */
  ruoliNeutralizzati: number;
  /** Di cui canali vocali o palchi. */
  vocali: number;
  falliti: CanaleNonModificato[];
  alreadyActive: boolean;
  /** Pausa inviti: `null` se non era richiesta, `false` se Discord l'ha rifiutata. */
  invitiInPausa: boolean | null;
  /** Il permesso del bot che impedisce di cominciare, se manca. */
  permessoMancante: string | null;
}

export interface EsitoSblocco {
  unlocked: number;
  ruoliRipristinati: number;
  hadState: boolean;
  falliti: CanaleNonModificato[];
}

type Modifica = ReturnType<typeof comeModifica>;

/* ── Stato ────────────────────────────────────────────────────────────── */

/**
 * Copia in memoria dello stato, per il controllo sui messaggi.
 *
 * Il controllo gira a ogni messaggio: un giro su Redis per ciascuno sarebbe
 * il costo più alto di tutto il lockdown, pagato anche quando il lockdown non
 * c'è. Cinque secondi di ritardo sono il prezzo di chi arriva da un altro
 * processo; quelli attivati da qui aggiornano la copia subito.
 */
const memoria = new Map<string, { stato: LockdownState | null; scade: number }>();
const MEMORIA_MS = 5_000;

export async function readLockdownState(guildId: string): Promise<LockdownState | null> {
  const raw = await getRedis().get(RedisKeys.lockdown(guildId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LockdownState;
  } catch {
    return null;
  }
}

/** Lo stato come lo vede il controllo sui messaggi: dalla memoria se recente. */
export async function statoRecente(guildId: string): Promise<LockdownState | null> {
  const copia = memoria.get(guildId);
  if (copia && copia.scade > Date.now()) return copia.stato;
  const stato = await readLockdownState(guildId).catch(() => null);
  memoria.set(guildId, { stato, scade: Date.now() + MEMORIA_MS });
  return stato;
}

function ricorda(guildId: string, stato: LockdownState | null): void {
  memoria.set(guildId, { stato, scade: Date.now() + MEMORIA_MS });
}

/**
 * La copia dello stato su Postgres: vedi `bloccoDurevole.ts` per il perché.
 *
 * Creata al primo uso e non al caricamento del modulo: `getPrisma()` vuole
 * `DATABASE_URL`, e un modulo che la pretende appena importato rompe ogni
 * test che lo tocca anche solo di passaggio.
 */
let archivio: ArchivioBlocchi | null = null;
function copia(): ArchivioBlocchi {
  return (archivio ??= archivioBlocchi());
}

export async function isLockedDown(guildId: string): Promise<boolean> {
  return (await getRedis().exists(RedisKeys.lockdown(guildId))) === 1;
}

/* ── Utilità ──────────────────────────────────────────────────────────── */

function motivoErrore(errore: unknown): string {
  if (errore instanceof DiscordAPIError) {
    if (errore.code === 50013) return 'manca «Gestisci permessi» su questo canale';
    if (errore.code === 50001) return 'il bot non vede questo canale';
    if (errore.code === 10003) return 'canale eliminato nel frattempo';
    return `Discord ha risposto ${errore.code}: ${errore.message.slice(0, 120)}`;
  }
  return errore instanceof Error ? errore.message.slice(0, 160) : 'errore sconosciuto';
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function truncateReason(reason: string): string {
  // L'header X-Audit-Log-Reason ha un limite di 512 caratteri.
  return reason.slice(0, 500);
}

function haSovrascritture(
  channel: GuildBasedChannel | null,
): channel is NonThreadGuildBasedChannel {
  return channel != null && 'permissionOverwrites' in channel && eBloccabile(channel.type);
}

function descrivi(channel: NonThreadGuildBasedChannel): CanaleDescritto {
  return {
    id: channel.id,
    nome: channel.name,
    tipo: channel.type,
    sovrascritture: [...channel.permissionOverwrites.cache.values()].map((s) => ({
      id: s.id,
      tipo: s.type === OverwriteType.Member ? 1 : 0,
      allow: s.allow.bitfield,
      deny: s.deny.bitfield,
    })),
  };
}

/** Ruoli i cui permessi sul canale il lockdown non tocca. */
function ruoliIntoccabili(guild: Guild, config: GuildConfig): Set<string> {
  const esclusi = new Set<string>(config.general.staffRoleIds);
  for (const role of guild.roles.cache.values()) {
    if (role.managed) esclusi.add(role.id);
    if ((role.permissions.bitfield & PERMESSI_DA_STAFF) !== 0n) esclusi.add(role.id);
  }
  for (const roleId of guild.members.me?.roles.cache.keys() ?? []) esclusi.add(roleId);
  return esclusi;
}

async function tuttiICanali(guild: Guild): Promise<Map<string, NonThreadGuildBasedChannel>> {
  // Dall'API e non dalla cache: dopo un riavvio la cache può essere parziale,
  // e un canale dimenticato aperto è la falla da cui passa tutto il resto.
  const canali = await guild.channels.fetch();
  const mappa = new Map<string, NonThreadGuildBasedChannel>();
  for (const channel of canali.values()) {
    if (haSovrascritture(channel)) mappa.set(channel.id, channel);
  }
  return mappa;
}

/**
 * Lo stato salvato corrisponde ancora a qualcosa sui canali?
 *
 * Se nessuno dei canali registrati nega più la scrittura a @everyone e non
 * ci sono permessi di ruoli da riconcedere, qualcuno ha già riaperto tutto
 * a mano: tenere lo stato significherebbe rispondere «già attivo» a ogni
 * lockdown futuro, cioè non poterne più attivare uno.
 */
function statoOrfano(
  stato: LockdownState,
  canali: Map<string, NonThreadGuildBasedChannel>,
  everyoneId: string,
): boolean {
  if ((stato.ruoli?.length ?? 0) > 0) return false;
  return !stato.channels.some((id) =>
    canali
      .get(id)
      ?.permissionOverwrites.cache.get(everyoneId)
      ?.deny.has(PermissionFlagsBits.SendMessages),
  );
}

/* ── Blocco ───────────────────────────────────────────────────────────── */

/**
 * Lockdown: canali pubblici in sola lettura e inviti in pausa.
 *
 * La pausa degli inviti è la parte decisiva: senza, i nuovi account continuano
 * ad arrivare mentre si ripulisce quanto già entrato.
 */
export async function enableLockdown(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  reason: string,
  durationSec: number,
): Promise<EsitoBlocco> {
  const redis = getRedis();
  const key = RedisKeys.lockdown(guild.id);
  const settings = config.security.antiRaid;

  const esito: EsitoBlocco = {
    locked: 0,
    ruoliNeutralizzati: 0,
    vocali: 0,
    falliti: [],
    alreadyActive: false,
    invitiInPausa: null,
    permessoMancante: null,
  };

  // Il permesso si controlla prima di reclamare lo stato: un blocco che non
  // può partire non deve lasciare dietro di sé uno stato che dice «attivo».
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (settings.lockChannels && !me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    esito.permessoMancante = 'Gestisci ruoli';
    return esito;
  }

  const canali = settings.lockChannels
    ? await tuttiICanali(guild)
    : new Map<string, NonThreadGuildBasedChannel>();

  const state: LockdownState = {
    versione: 2,
    reason,
    channels: [],
    startedAt: Date.now(),
    expiresAt: durationSec > 0 ? Date.now() + durationSec * 1000 : 0,
    notices: [],
    dettagli: {},
    ruoli: [],
    invitiGiaInPausa: guild.features.includes('INVITES_DISABLED'),
    falliti: [],
  };

  /*
   * Redis può aver perso uno stato che il database ricorda ancora: un blocco
   * in corso, con i suoi permessi di ruolo da rimettere. Partirne uno nuovo
   * sopra significherebbe sovrascrivere quell'elenco, e quei permessi non
   * tornerebbero più. Rimesso in Redis, il NX qui sotto lo trova, e da lì
   * vale quello che vale per qualunque stato già presente: blocco già
   * attivo, oppure — se nessun canale è più chiuso — stato orfano, scartato.
   */
  if (!(await redis.exists(key))) {
    const ricordato = await copia().leggi(guild.id);
    if (ricordato) {
      log.warn(
        { guildId: guild.id },
        'stato di lockdown ritrovato nel database: Redis lo aveva perso',
      );
      await redis.set(key, JSON.stringify(ricordato), 'NX');
    }
  }

  // Lo stato si scrive **prima** di toccare i canali, e con NX: se il processo
  // muore a metà la revoca trova un elenco parziale da cui ripartire, e due
  // richieste simultanee non bloccano due volte.
  let reclamato = (await redis.set(key, JSON.stringify(state), 'NX')) === 'OK';
  if (!reclamato) {
    const esistente = await readLockdownState(guild.id);
    if (esistente && settings.lockChannels && statoOrfano(esistente, canali, guild.id)) {
      log.info({ guildId: guild.id }, 'stato di lockdown rimasto indietro: scartato');
      await redis.del(key);
      reclamato = (await redis.set(key, JSON.stringify(state), 'NX')) === 'OK';
    }
    if (!reclamato) {
      esito.alreadyActive = true;
      return esito;
    }
  }
  ricorda(guild.id, state);
  // La copia subito, prima di toccare i canali: per la stessa ragione per
  // cui Redis si scrive prima. Un processo che muore a metà deve lasciare un
  // elenco parziale da cui ripartire, non niente.
  await copia().salva(guild.id, state);

  if (settings.lockChannels) {
    const piano = pianificaBlocco([...canali.values()].map(descrivi), {
      everyoneId: guild.id,
      canaliEsenti: new Set(settings.lockdownExemptChannels),
      ruoliIntoccabili: ruoliIntoccabili(guild, config),
    });

    const announcement = settings.announceLockdown
      ? settings.lockdownMessage
          .replace('{motivo}', reason.slice(0, 300))
          .replace(
            '{durata}',
            durationSec > 0 ? `Durata prevista: ${humanDuration(durationSec)}` : '',
          )
          .trim()
      : null;

    for (const lotto of chunk(piano, settings.lockdownBatchSize)) {
      await Promise.all(
        lotto.map((voce) =>
          chiudiCanale(canali.get(voce.canaleId)!, voce, reason, state, announcement),
        ),
      );
      await redis.set(key, JSON.stringify(state));
      await copia().salva(guild.id, state);
    }

    esito.locked = state.channels.length;
    esito.ruoliNeutralizzati = state.ruoli!.length;
    esito.vocali = piano.filter(
      (voce) => voce.vocale && state.channels.includes(voce.canaleId),
    ).length;
    esito.falliti = state.falliti!;
  }

  if (settings.pauseInvites) {
    // `invitesDisabled` è la pausa inviti nativa di Discord. Richiede
    // «Gestisci server», e senza quello va detto: è la metà che ferma gli
    // arrivi, e crederla attiva quando non lo è costa l'intero raid.
    esito.invitiInPausa = state.invitiGiaInPausa
      ? true
      : await guild
          .disableInvites(true)
          .then(() => true)
          .catch((errore: unknown) => {
            log.warn({ err: errore, guildId: guild.id }, 'pausa inviti non applicata');
            return false;
          });
  }

  await redis.set(key, JSON.stringify(state));
  await copia().salva(guild.id, state);
  ricorda(guild.id, state);

  const righe = [
    `🔒 Server bloccato: ${reason}`,
    `Canali chiusi: ${esito.locked}` + (esito.vocali ? ` (di cui ${esito.vocali} vocali)` : ''),
  ];
  if (esito.ruoliNeutralizzati) {
    righe.push(`Permessi di scrittura sospesi a ruoli ordinari: ${esito.ruoliNeutralizzati}`);
  }
  if (esito.falliti.length) {
    righe.push(
      `⚠️ Non chiusi: ${esito.falliti.length} — ` +
        esito.falliti
          .slice(0, 5)
          .map((f) => `<#${f.canaleId}> (${f.motivo})`)
          .join(', '),
    );
  }
  if (esito.invitiInPausa === false) {
    righe.push('⚠️ Inviti **non** in pausa: manca «Gestisci server».');
  }
  if (durationSec > 0) righe.push(`Revoca automatica fra ${humanDuration(durationSec)}`);

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_LOCKDOWN_ENABLED',
    actorId: client.user?.id,
    severity: 95,
    automated: true,
    summary: righe.join('\n'),
    payload: {
      channels: state.channels,
      ruoli: esito.ruoliNeutralizzati,
      falliti: esito.falliti,
      durationSec,
      invitesPaused: esito.invitiInPausa,
    },
  });

  return esito;
}

async function chiudiCanale(
  channel: NonThreadGuildBasedChannel,
  voce: PianoCanale,
  reason: string,
  state: LockdownState,
  announcement: string | null,
): Promise<void> {
  const motivo = { reason: truncateReason(reason) };

  if (voce.daNegare !== 0n) {
    try {
      await channel.permissionOverwrites.edit(
        channel.guild.id,
        comeModifica(voce.daNegare, false),
        motivo,
      );
    } catch (errore) {
      state.falliti!.push({ canaleId: voce.canaleId, nome: voce.nome, motivo: motivoErrore(errore) });
      // Se non si riesce a chiudere @everyone non si riesce nemmeno con i
      // ruoli: stesso permesso, stesso canale. Provarci produrrebbe solo un
      // secondo errore identico.
      return;
    }
    state.channels.push(voce.canaleId);
    state.dettagli![voce.canaleId] = {
      bit: voce.daNegare.toString(),
      concessiPrima: voce.everyoneConcessiPrima.toString(),
      esisteva: voce.everyoneEsisteva,
    };
  }

  for (const ruolo of voce.ruoli) {
    try {
      await channel.permissionOverwrites.edit(ruolo.ruoloId, comeModifica(ruolo.bit, null), motivo);
      state.ruoli!.push({
        canaleId: voce.canaleId,
        ruoloId: ruolo.ruoloId,
        bit: ruolo.bit.toString(),
      });
    } catch (errore) {
      state.falliti!.push({
        canaleId: voce.canaleId,
        nome: voce.nome,
        motivo: `ruolo <@&${ruolo.ruoloId}>: ${motivoErrore(errore)}`,
      });
    }
  }

  if (announcement && voce.daNegare !== 0n && channel.isTextBased()) {
    const sent = await channel
      .send({ content: announcement, allowedMentions: { parse: [] } })
      .catch(() => null);
    if (sent) state.notices.push({ channelId: channel.id, messageId: sent.id });
  }
}

/* ── Revoca ───────────────────────────────────────────────────────────── */

/**
 * Revoca il lockdown.
 *
 * Con `force` riapre **tutti** i canali che negano la scrittura a @everyone,
 * non solo quelli registrati. È la via d'uscita quando lo stato è andato perso
 * — un Redis svuotato, un ripristino da backup — e il server è rimasto muto.
 * Riapre però anche i canali che lo staff voleva in sola lettura, come gli
 * annunci: per questo non parte mai da sola, ma solo quando la si chiede.
 */
export async function disableLockdown(
  client: Client,
  guild: Guild,
  reason: string,
  options: { force?: boolean; config?: GuildConfig } = {},
): Promise<EsitoSblocco> {
  const redis = getRedis();
  const key = RedisKeys.lockdown(guild.id);
  const inRedis = await readLockdownState(guild.id);
  /*
   * Senza stato in Redis, la copia. È il caso per cui la copia esiste: senza,
   * la revoca forzata riaprirebbe i canali a @everyone ma non saprebbe quali
   * permessi di ruolo rimettere, e resterebbero tolti.
   */
  const state = inRedis ?? (await copia().leggi(guild.id));
  if (!inRedis && state) {
    log.warn(
      { guildId: guild.id },
      'revoca con lo stato ritrovato nel database: Redis lo aveva perso',
    );
  }
  const esito: EsitoSblocco = {
    unlocked: 0,
    ruoliRipristinati: 0,
    hadState: Boolean(state),
    falliti: [],
  };
  if (!state && !options.force) return esito;

  const canali = await tuttiICanali(guild).catch(
    () => new Map<string, NonThreadGuildBasedChannel>(),
  );
  const everyone = guild.id;
  const motivo = { reason: truncateReason(reason) };

  // Cosa rimettere su @everyone, canale per canale.
  const daRiaprire = new Map<string, Modifica>();
  for (const id of state?.channels ?? []) {
    const det = state?.dettagli?.[id];
    daRiaprire.set(
      id,
      det
        ? ripristinoEveryone(BigInt(det.bit), BigInt(det.concessiPrima))
        : comeModifica(BIT_V1, null),
    );
  }
  if (options.force) {
    for (const channel of canali.values()) {
      if (daRiaprire.has(channel.id)) continue;
      const attuale = channel.permissionOverwrites.cache.get(everyone);
      if (attuale?.deny.has(PermissionFlagsBits.SendMessages)) {
        daRiaprire.set(channel.id, comeModifica(bitScrittura(channel.type), null));
      }
    }
  }

  const batchSize = options.config?.security.antiRaid.lockdownBatchSize ?? 10;

  for (const lotto of chunk([...daRiaprire.entries()], batchSize)) {
    await Promise.all(
      lotto.map(async ([channelId, modifica]) => {
        const channel = canali.get(channelId);
        if (!channel) return;
        try {
          await channel.permissionOverwrites.edit(everyone, modifica, motivo);
          esito.unlocked += 1;

          // La sovrascrittura l'aveva creata il lockdown: se ora è vuota si
          // toglie, e il canale torna sincronizzato con la sua categoria.
          // Lasciarla significherebbe un canale che da quel giorno non segue
          // più i permessi della categoria, senza che nessuno lo abbia deciso.
          const det = state?.dettagli?.[channelId];
          const ora = channel.permissionOverwrites.cache.get(everyone);
          if (det && !det.esisteva && ora && ora.allow.bitfield === 0n && ora.deny.bitfield === 0n) {
            await channel.permissionOverwrites.delete(everyone, motivo.reason).catch(() => undefined);
          }
        } catch (errore) {
          esito.falliti.push({ canaleId: channelId, nome: channel.name, motivo: motivoErrore(errore) });
        }
      }),
    );
  }

  for (const lotto of chunk(state?.ruoli ?? [], batchSize)) {
    await Promise.all(
      lotto.map(async (voce) => {
        const channel = canali.get(voce.canaleId);
        if (!channel) return;
        try {
          await channel.permissionOverwrites.edit(
            voce.ruoloId,
            comeModifica(BigInt(voce.bit), true),
            motivo,
          );
          esito.ruoliRipristinati += 1;
        } catch (errore) {
          esito.falliti.push({
            canaleId: voce.canaleId,
            nome: channel.name,
            motivo: `ruolo <@&${voce.ruoloId}>: ${motivoErrore(errore)}`,
          });
        }
      }),
    );
  }

  // Gli inviti si riaprono solo se li aveva chiusi il lockdown: se erano già
  // in pausa per scelta dello staff, riaprirli sarebbe disfare una decisione
  // che non gli apparteneva.
  if (!state?.invitiGiaInPausa) {
    await guild.disableInvites(false).catch(() => undefined);
  }

  // L'avviso di revoca prende il posto di quello di blocco, nello stesso
  // messaggio: due cartellini contraddittori uno sotto l'altro confondono più
  // del silenzio.
  const liftText = options.config?.security.antiRaid.lockdownLiftMessage;
  if (liftText && state?.notices.length) {
    await Promise.allSettled(
      state.notices.map(async (notice) => {
        const channel = canali.get(notice.channelId);
        if (!channel?.isTextBased()) return;
        const message = await channel.messages.fetch(notice.messageId).catch(() => null);
        await message?.edit({ content: liftText, allowedMentions: { parse: [] } });
      }),
    );
  }

  // Prima la copia, poi Redis: se il processo muore in mezzo, resta lo stato
  // in Redis e la revoca successiva lo ritrova intero.
  await copia().cancella(guild.id);
  await redis.del(key);
  ricorda(guild.id, null);

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_LOCKDOWN_DISABLED',
    actorId: client.user?.id,
    summary:
      `🔓 Lockdown revocato: ${reason}\nCanali riaperti: ${esito.unlocked}` +
      (esito.ruoliRipristinati ? `\nPermessi di ruoli rimessi: ${esito.ruoliRipristinati}` : '') +
      (esito.falliti.length
        ? `\n⚠️ Non riaperti: ${esito.falliti.map((f) => `<#${f.canaleId}> (${f.motivo})`).join(', ')}`
        : '') +
      (options.force && !state ? '\n(revoca forzata: nessuno stato salvato)' : ''),
    payload: {
      unlocked: esito.unlocked,
      ruoli: esito.ruoliRipristinati,
      falliti: esito.falliti,
      forced: options.force ?? false,
      hadState: Boolean(state),
    },
  });

  return esito;
}

/**
 * Revoca i lockdown scaduti.
 *
 * Sostituisce il `setTimeout` di prima, che moriva con il processo: un riavvio
 * durante un lockdown a tempo lasciava il server bloccato per sempre. Il ciclo
 * riparte a ogni avvio e ritrova lo stato in Redis.
 */
export function startLockdownSweeper(client: Client, intervalMs = 20_000): NodeJS.Timeout {
  let inCorso = false;
  const timer = setInterval(() => {
    // Un giro che dura più dell'intervallo — molti canali, Discord lento — non
    // deve sovrapporsi al successivo: due revoche dello stesso blocco
    // rimetterebbero due volte gli stessi permessi.
    if (inCorso) return;
    inCorso = true;
    void (async () => {
      // Un blocco a tempo di cui Redis ha perso lo stato non scadrebbe mai:
      // il server resterebbe chiuso finché qualcuno non se ne accorge. Una
      // query per giro dice quali server hanno una copia.
      const conCopia = await copia().elenca();
      for (const guild of client.guilds.cache.values()) {
        const state =
          (await readLockdownState(guild.id).catch(() => null)) ??
          (conCopia.has(guild.id) ? await copia().leggi(guild.id) : null);
        if (!state?.expiresAt || state.expiresAt > Date.now()) continue;
        const config = await getGuildConfig(guild.id).catch(() => undefined);
        await disableLockdown(client, guild, 'scadenza automatica', { config }).catch((errore) =>
          log.warn({ err: errore, guildId: guild.id }, 'revoca a scadenza non riuscita'),
        );
      }
    })().finally(() => {
      inCorso = false;
    });
  }, intervalMs);
  // Non deve tenere vivo il processo da solo.
  timer.unref?.();
  return timer;
}

/** Riepilogo leggibile di un blocco, uguale per il comando e per il pannello. */
export function descriviBlocco(esito: EsitoBlocco, minuti = 0): string {
  if (esito.permessoMancante) {
    return (
      `⛔ Lockdown non avviato: al bot manca il permesso «${esito.permessoMancante}». ` +
      'Senza non può cambiare i permessi dei canali. Aggiungilo al ruolo del bot e riprova.'
    );
  }
  if (esito.alreadyActive) {
    return 'Il lockdown era già attivo: nessuna modifica. `/lockdown stato` mostra da quando.';
  }
  const righe = [
    `🔒 Server bloccato. Canali chiusi: ${esito.locked}` +
      (esito.vocali ? ` (di cui ${esito.vocali} chat vocali)` : '') +
      '.',
  ];
  if (esito.ruoliNeutralizzati > 0) {
    righe.push(
      `Sospesi ${esito.ruoliNeutralizzati} permessi di scrittura dati a ruoli ordinari: ` +
        'tornano come prima alla revoca.',
    );
  }
  if (esito.invitiInPausa === true) righe.push('Inviti in pausa.');
  if (esito.invitiInPausa === false) {
    righe.push('⚠️ Inviti **non** in pausa: al bot manca «Gestisci server».');
  }
  if (esito.falliti.length > 0) {
    righe.push(
      `⚠️ ${esito.falliti.length} non modificati:\n` +
        esito.falliti
          .slice(0, 10)
          .map((f) => `• <#${f.canaleId}> — ${f.motivo}`)
          .join('\n') +
        (esito.falliti.length > 10 ? `\n…e altri ${esito.falliti.length - 10}` : ''),
    );
  }
  if (esito.locked === 0 && esito.ruoliNeutralizzati === 0 && esito.falliti.length === 0) {
    righe.push(
      'Nessun canale da chiudere: sono tutti già in sola lettura, oppure esentati in configurazione.',
    );
  }
  if (minuti > 0) righe.push(`Sblocco automatico fra ${minuti} minuti.`);
  return righe.join('\n');
}

/** Riepilogo leggibile di una revoca. */
export function descriviSblocco(esito: EsitoSblocco, forzata: boolean): string {
  if (!esito.hadState && !forzata) {
    return (
      'Il lockdown non risulta attivo.\n' +
      '-# Se i canali sono comunque chiusi, ripeti forzando: riapre tutto ciò che nega la ' +
      'scrittura a @everyone — compresi i canali di annunci, che poi vanno richiusi a mano.'
    );
  }
  const righe = [`🔓 Lockdown revocato. Canali riaperti: ${esito.unlocked}.`];
  if (esito.ruoliRipristinati > 0) {
    righe.push(`Rimessi ${esito.ruoliRipristinati} permessi di scrittura ai ruoli.`);
  }
  if (esito.falliti.length > 0) {
    righe.push(
      `⚠️ ${esito.falliti.length} non ripristinati:\n` +
        esito.falliti
          .slice(0, 10)
          .map((f) => `• <#${f.canaleId}> — ${f.motivo}`)
          .join('\n'),
    );
  }
  return righe.join('\n');
}

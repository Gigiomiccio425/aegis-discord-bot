import { ChannelType, PermissionFlagsBits } from 'discord.js';

/* ═══════════════════════════════════════════════════════════════════════
   IL PIANO DEL LOCKDOWN

   Cosa chiudere e come, deciso su dati semplici e senza toccare Discord.
   Sta in un file a parte per poterlo collaudare: la parte che parla con
   Discord si limita a eseguire quello che esce da qui.

   ── Due buchi della versione precedente ────────────────────────────────

   1. **Le chat delle vocali restavano aperte.** Dal 2022 ogni canale vocale
      ha una chat testuale propria, e i palchi pure. L'elenco dei tipi
      bloccabili si fermava a testo, annunci e forum: durante un raid la
      chat di una vocale era il posto dove continuare indisturbati.

   2. **Un ruolo con «Invia messaggi» concesso sul canale scavalcava il
      blocco.** Il lockdown negava la scrittura a @everyone, ma Discord
      applica prima i divieti di @everyone e poi i permessi dei ruoli: un
      ruolo «Membri» con la scrittura concessa esplicitamente sul canale la
      riconcede a tutti quelli che ce l'hanno. Sui server costruiti da ANGEL
      non capita — il ruolo dei verificati concede solo la vista — ma su
      quelli costruiti a mano è la norma, e il lockdown risultava attivo
      senza fermare nessuno.

      Ora quei permessi vengono riportati a «eredita» per la durata del
      blocco, e rimessi com'erano alla revoca. Restano intatti quelli dei
      ruoli di staff, dei ruoli con permessi di moderazione e dei ruoli
      gestiti da un'integrazione: chiudere la bocca a chi deve gestire il
      raid sarebbe il modo più rapido di perderlo.
   ═══════════════════════════════════════════════════════════════════════ */

/** Tipi di canale che il lockdown chiude. */
export const TIPI_BLOCCABILI: readonly ChannelType[] = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  // La chat testuale delle vocali e dei palchi: si chiude con lo stesso
  // «Invia messaggi», e senza restava l'unica stanza aperta del server.
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
];

const VOCALI: readonly ChannelType[] = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

/**
 * I permessi che il lockdown toglie, per tipo di canale.
 *
 * Nelle vocali solo la scrittura: parlare e connettersi restano, perché
 * buttare fuori dalla voce chi sta parlando con lo staff durante un raid
 * non ferma il raid e interrompe proprio chi lo sta gestendo. I thread non
 * esistono dentro le vocali, quindi i permessi relativi non servono.
 *
 * Nei canali di testo anche i thread privati: senza, chiunque ne apre uno
 * nel canale bloccato e continua a scrivere lì dentro.
 */
export function bitScrittura(tipo: ChannelType): bigint {
  if (VOCALI.includes(tipo)) return PermissionFlagsBits.SendMessages;
  return (
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.SendMessagesInThreads |
    PermissionFlagsBits.CreatePublicThreads |
    PermissionFlagsBits.CreatePrivateThreads
  );
}

export function eBloccabile(tipo: ChannelType): boolean {
  return TIPI_BLOCCABILI.includes(tipo);
}

export function eVocale(tipo: ChannelType): boolean {
  return VOCALI.includes(tipo);
}

/** Un canale come serve al piano: niente oggetti di discord.js. */
export interface CanaleDescritto {
  id: string;
  nome: string;
  tipo: ChannelType;
  sovrascritture: {
    id: string;
    /** 0 = ruolo, 1 = membro, come nell'API di Discord. */
    tipo: 0 | 1;
    allow: bigint;
    deny: bigint;
  }[];
}

export interface ContestoPiano {
  everyoneId: string;
  canaliEsenti: ReadonlySet<string>;
  /** Ruoli i cui permessi sul canale non si toccano: staff, moderazione, integrazioni. */
  ruoliIntoccabili: ReadonlySet<string>;
}

export interface PianoCanale {
  canaleId: string;
  nome: string;
  vocale: boolean;
  /** I bit che si negano a @everyone. Zero se il canale era già in sola lettura. */
  daNegare: bigint;
  /** Esisteva già una sovrascrittura per @everyone prima del blocco? */
  everyoneEsisteva: boolean;
  /** Fra i bit bloccati, quelli che @everyone aveva concessi esplicitamente. */
  everyoneConcessiPrima: bigint;
  /** Permessi di scrittura concessi a ruoli ordinari, da riportare a «eredita». */
  ruoli: { ruoloId: string; bit: bigint }[];
}

/**
 * Il piano per un insieme di canali.
 *
 * Un canale che nega già la scrittura a @everyone non riceve un secondo
 * divieto: lo staff lo ha voluto in sola lettura, e alla revoca verrebbe
 * riaperto un canale che doveva restare chiuso. I permessi concessi ai ruoli
 * ordinari invece si neutralizzano anche lì: in un canale di annunci, il
 * ruolo che vi scrive è esattamente quello da fermare se è in mano sbagliata.
 */
export function pianificaBlocco(
  canali: readonly CanaleDescritto[],
  contesto: ContestoPiano,
): PianoCanale[] {
  const piano: PianoCanale[] = [];

  for (const canale of canali) {
    if (!eBloccabile(canale.tipo)) continue;
    if (contesto.canaliEsenti.has(canale.id)) continue;

    const bit = bitScrittura(canale.tipo);
    const everyone = canale.sovrascritture.find((s) => s.id === contesto.everyoneId);
    const giaChiuso = everyone ? (everyone.deny & PermissionFlagsBits.SendMessages) !== 0n : false;

    const ruoli = canale.sovrascritture
      .filter(
        (s) =>
          s.tipo === 0 &&
          s.id !== contesto.everyoneId &&
          !contesto.ruoliIntoccabili.has(s.id) &&
          (s.allow & bit) !== 0n,
      )
      .map((s) => ({ ruoloId: s.id, bit: s.allow & bit }));

    const daNegare = giaChiuso ? 0n : bit;
    if (daNegare === 0n && ruoli.length === 0) continue;

    piano.push({
      canaleId: canale.id,
      nome: canale.nome,
      vocale: eVocale(canale.tipo),
      daNegare,
      everyoneEsisteva: Boolean(everyone),
      everyoneConcessiPrima: everyone ? everyone.allow & bit : 0n,
      ruoli,
    });
  }

  return piano;
}

type ModificaPermessi = Partial<Record<keyof typeof PermissionFlagsBits, boolean | null>>;

/**
 * Da un insieme di bit a un oggetto per `permissionOverwrites.edit`.
 *
 * Discord.js vuole i nomi dei permessi, non i bit: `{ SendMessages: false }`.
 * Il valore dice cosa diventano — `false` negato, `true` concesso, `null`
 * «eredita» — e si applica a tutti i bit dell'insieme.
 */
export function comeModifica(bit: bigint, valore: boolean | null): ModificaPermessi {
  const modifica: ModificaPermessi = {};
  for (const [nome, flag] of Object.entries(PermissionFlagsBits) as [
    keyof typeof PermissionFlagsBits,
    bigint,
  ][]) {
    if ((bit & flag) !== 0n) modifica[nome] = valore;
  }
  return modifica;
}

/**
 * Ciò che la revoca rimette su @everyone: concesso quello che era concesso,
 * «eredita» tutto il resto. Rimettere tutto a «eredita», come faceva la
 * versione precedente, cancellava in silenzio una concessione esplicita
 * fatta dallo staff prima del blocco.
 */
export function ripristinoEveryone(bitBloccati: bigint, concessiPrima: bigint): ModificaPermessi {
  return {
    ...comeModifica(bitBloccati & ~concessiPrima, null),
    ...comeModifica(bitBloccati & concessiPrima, true),
  };
}

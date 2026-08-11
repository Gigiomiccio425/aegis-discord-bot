import { z } from 'zod';
import { ActionKind, ActionLadder, ActiveModuleBase } from './common.js';

/* ═══════════════════════════════════════════════════════════════════════
   CONTENT SCANNER  —  minacce A2, A3, A4, C1, C2, C5, C6

   Premessa tecnica: un PNG o JPG su Discord non esegue codice. Le immagini
   delle campagne scam sono *veicoli di link* — testo sovrimpresso, QR code, o
   il messaggio che le accompagna. Perciò lo scanner estrae ogni URL visibile o
   codificato, ne verifica la reputazione, e riconosce la campagna tramite hash
   percettivo. Per gli allegati non-immagine il controllo è invece reale
   (magic bytes, doppia estensione, polyglot).
   ═══════════════════════════════════════════════════════════════════════ */

export const UrlScanConfig = z
  .object({
    enabled: z.boolean().default(true),
    /** Segue i redirect degli accorciatori per vedere la vera destinazione. */
    expandShorteners: z.boolean().default(true),
    maxRedirects: z.number().int().min(1).max(10).default(5),
    fetchTimeoutMs: z.number().int().min(500).max(15000).default(4000),
    /** Rileva punycode e omoglifi: `discοrd.com` con omicron greco. */
    detectHomoglyphs: z.boolean().default(true),
    /** Domini che imitiamo per il confronto omoglifi. */
    protectedDomains: z
      .array(z.string())
      .default([
        'discord.com',
        'discord.gg',
        'discordapp.com',
        'steamcommunity.com',
        'steampowered.com',
        'twitch.tv',
        'roblox.com',
        'epicgames.com',
      ]),
    /** Google Safe Browsing v4. Richiede GOOGLE_SAFE_BROWSING_KEY. */
    useSafeBrowsing: z.boolean().default(true),
    /** Blocklist pubbliche sincronizzate in locale (URLhaus, Phishing.Database). */
    useThreatFeeds: z.boolean().default(true),
    /** Blocklist e allowlist manuali del server. */
    blockedDomains: z.array(z.string()).default([]),
    allowedDomains: z.array(z.string()).default([]),
    /**
     * Link alla CDN Discord che puntano a file eseguibili: vettore documentato
     * di distribuzione infostealer (Lumma, Skuld, Vidar).
     */
    blockCdnExecutables: z.boolean().default(true),
    /**
     * Link `oauth2/authorize` verso applicazioni non approvate: l'utente che
     * autorizza consegna l'accesso all'account.
     */
    flagOAuthLinks: z.boolean().default(true),
    allowedOAuthAppIds: z.array(z.string()).default([]),
  })
  .default({});
export type UrlScanConfig = z.infer<typeof UrlScanConfig>;

export const ImageScanConfig = z
  .object({
    enabled: z.boolean().default(true),
    /** Dimensione massima dell'immagine da analizzare (MB). Oltre, si salta. */
    maxSizeMb: z.number().int().min(1).max(50).default(10),

    /** Decodifica i QR code presenti nell'immagine ed estrae la destinazione. */
    decodeQr: z.boolean().default(true),
    /**
     * Regola critica: un QR che punta a `discord.com/ra/*` è il flusso Remote
     * Auth. Chi lo inquadra consegna il proprio token — Discord stesso lo
     * trasmette all'attaccante, senza password, senza OAuth, senza avviso.
     * Non esiste un uso legittimo di questo QR postato in chat.
     */
    blockDiscordRemoteAuthQr: z.boolean().default(true),

    /** OCR del testo sovrimpresso, per trovare URL e frasi delle campagne scam. */
    ocr: z.boolean().default(true),
    ocrLanguages: z.array(z.string()).default(['ita', 'eng']),
    /** Sotto questa confidenza il testo riconosciuto viene ignorato (0-100). */
    ocrMinConfidence: z.number().int().min(0).max(100).default(60),

    /**
     * Hash percettivo: riconosce la stessa immagine anche se ricompressa,
     * ritagliata o leggermente modificata. È il modo per bloccare un'intera
     * campagna (es. l'ondata MrBeast) con una sola firma.
     */
    perceptualHash: z.boolean().default(true),
    /** Distanza di Hamming massima per considerare due immagini uguali (0-64). */
    phashMaxDistance: z.number().int().min(0).max(64).default(8),

    /** Confronta l'avatar dei nuovi membri con quello dello staff (impersonificazione). */
    compareAvatarsToStaff: z.boolean().default(true),
  })
  .default({});
export type ImageScanConfig = z.infer<typeof ImageScanConfig>;

export const FileScanConfig = z
  .object({
    enabled: z.boolean().default(true),
    /** Verifica che i magic bytes corrispondano all'estensione dichiarata. */
    verifyMagicBytes: z.boolean().default(true),
    /** `foto.png.exe`, `documento.pdf.scr`. */
    blockDoubleExtension: z.boolean().default(true),
    /** File che sono validi in due formati contemporaneamente. */
    detectPolyglot: z.boolean().default(true),
    blockedExtensions: z
      .array(z.string())
      .default([
        'exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse',
        'wsf', 'wsh', 'msi', 'msp', 'hta', 'cpl', 'jar', 'lnk', 'ps1', 'psm1',
        'reg', 'inf', 'apk', 'dll', 'sys',
      ]),
    /** Ispeziona gli archivi cercando eseguibili al loro interno. */
    inspectArchives: z.boolean().default(true),
    maxArchiveEntries: z.number().int().min(1).max(1000).default(100),
  })
  .default({});
export type FileScanConfig = z.infer<typeof FileScanConfig>;

export const ClickFixConfig = z
  .object({
    /**
     * ClickFix / finta CAPTCHA: la pagina dice "premi Win+R, incolla, Invio" e
     * negli appunti c'è già PowerShell offuscato. Cresciuto del 517% nel primo
     * semestre 2025, allerta FTC dell'8 giugno 2026. Il testo dell'istruzione
     * compare sia nei messaggi sia dentro gli screenshot: si controlla anche
     * l'OCR.
     */
    enabled: z.boolean().default(true),
    patterns: z
      .array(z.string())
      .default([
        'win\\s*\\+\\s*r',
        'ctrl\\s*\\+\\s*v',
        'windows\\s*\\+\\s*r',
        'powershell(\\.exe)?\\s+-',
        '-enc(odedcommand)?\\s',
        'iex\\s*\\(',
        'irm\\s+http',
        'invoke-(expression|webrequest|restmethod)',
        'mshta\\s+http',
        'curl\\s+[^|]+\\|\\s*(ba)?sh',
        'wget\\s+[^|]+\\|\\s*(ba)?sh',
        'certutil\\s+-urlcache',
        'bitsadmin\\s+/transfer',
        'premi\\s+(il\\s+tasto\\s+)?windows\\s*\\+\\s*r',
        'incolla.{0,20}(invio|enter)',
        'verifica.{0,20}(umano|human).{0,40}(win|ctrl)',
      ]),
    action: ActionKind.default('DELETE_MESSAGE'),
    /** Punteggio aggiunto al profilo di rischio di chi lo pubblica. */
    riskScore: z.number().int().min(0).max(100).default(70),
  })
  .default({});
export type ClickFixConfig = z.infer<typeof ClickFixConfig>;

export const ScannerConfig = ActiveModuleBase.extend({
  url: UrlScanConfig,
  image: ImageScanConfig,
  file: FileScanConfig,
  clickfix: ClickFixConfig,

  /**
   * Frasi delle campagne attive, cercate sia nel testo sia nell'OCR.
   * Modificabili dal pannello.
   */
  scamPhrases: z
    .array(z.string())
    .default([
      'free nitro',
      'nitro gratis',
      'steam gift',
      'connect your wallet',
      'collega il wallet',
      'claim your prize',
      'riscatta il premio',
      'you have been selected',
      'sei stato selezionato',
      'account will be deleted',
      'account sarà eliminato',
      'discord staff',
      'trust and safety',
      'verify your account',
      'verifica il tuo account',
      'scan this qr',
      'scansiona il qr',
    ]),

  /**
   * L'OCR costa 0,5-2 secondi per immagine: viene eseguito nel worker in
   * asincrono. Se il verdetto arriva dopo, il messaggio è eliminato a posteriori.
   */
  asyncDeepScan: z.boolean().default(true),

  ladder: ActionLadder.default([
    { atScore: 40, action: 'DELETE_MESSAGE', durationSec: 0 },
    { atScore: 60, action: 'WARN', durationSec: 0 },
    { atScore: 80, action: 'TIMEOUT', durationSec: 3600 },
    { atScore: 95, action: 'QUARANTINE', durationSec: 0 },
  ]),
}).default({});
export type ScannerConfig = z.infer<typeof ScannerConfig>;

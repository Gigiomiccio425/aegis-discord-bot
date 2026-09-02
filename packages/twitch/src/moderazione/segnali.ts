/* ═══════════════════════════════════════════════════════════════════════
   QUELLO CHE GIRA IN CHAT SU TWITCH

   Non è la stessa roba di Discord, e questo elenco esiste per quello.

   Su Discord il vettore sono i file e le immagini con dentro un QR; su Twitch
   non si può caricare niente, e resta il testo. Il risultato è che quasi tutto
   quello che va fermato è una **frase commerciale** — qualcuno che vende
   follower finti, o che finge di regalare qualcosa.

   Tre osservazioni che decidono come è scritto questo file:

   1. **I nomi cambiano ogni settimana, le frasi no.** I domini dei venditori
      di visualizzatori nascono e muoiono in giorni; «cheap viewers» è la
      stessa espressione da anni, perché è quella che vende. Le frasi pesano
      quindi più dei domini, e i domini valgono soprattutto come conferma.

   2. **Scrivono in Unicode strano apposta.** «Ch̍eap Vi̇ewers» e
      «Viewe𝗿𝘀 sᴛʀᴇᴀᴍʙᴏᴏ» non sono errori di battitura: sono matematici,
      corsivi e diacritici combinanti messi lì per passare i filtri letterali
      dei termini bloccati di Twitch. Il confronto va fatto sul testo
      normalizzato, sempre.

   3. **Il canale non è il bersaglio: lo è lo streamer.** Il messaggio è
      rivolto a chi trasmette, non alla chat, e per questo funziona anche su
      un canale con tre spettatori. È il motivo per cui questi bot arrivano
      *soprattutto* sui canali piccoli, dove non c'è nessuno a moderare.

   L'elenco è un punto di partenza, non un firewall: si estende dal pannello
   per canale, e le blocklist condivise con il bot Discord — URLhaus,
   Phishing.Database, Safe Browsing — coprono la parte malevola vera.
   ═══════════════════════════════════════════════════════════════════════ */

export type CategoriaSegnale =
  /** Vende follower, visualizzatori, «crescita». */
  | 'VENDITORE'
  /** Finti regali: carte Steam, skin, Nitro, giveaway. */
  | 'TRUFFA_REGALO'
  /** Finti grafici e montatori che cercano anticipi. */
  | 'FINTO_SERVIZIO'
  /** Porta la conversazione fuori da Twitch, dove nessuno modera. */
  | 'ADESCAMENTO'
  /** Cripto, wallet, airdrop. */
  | 'CRIPTO'
  /** Si spaccia per Twitch, Steam, Discord o l'assistenza. */
  | 'IMITAZIONE';

export interface Segnale {
  /** Testo o espressione da cercare nel messaggio normalizzato. */
  frase: string;
  categoria: CategoriaSegnale;
  /** Punti sul punteggio finale, 0-100. */
  peso: number;
}

const s = (categoria: CategoriaSegnale, peso: number, ...frasi: string[]): Segnale[] =>
  frasi.map((frase) => ({ frase, categoria, peso }));

/**
 * Frasi.
 *
 * I pesi non sono tutti uguali di proposito. «buy followers» è inequivocabile
 * e vale da solo una sanzione; «my username» compare in mille conversazioni
 * normali e vale solo come contorno di qualcos'altro. Un elenco con tutti i
 * pesi a cinquanta è un elenco che sanziona chi scambia il proprio contatto
 * con un amico.
 */
export const SEGNALI: Segnale[] = [
  /* ── Venditori di follower e visualizzatori ─────────────────────────
     La campagna più diffusa in assoluto, e la più facile da riconoscere:
     nessuno scrive «cheap viewers» per caso. */
  ...s(
    'VENDITORE',
    55,
    'buy followers',
    'buy viewers',
    'cheap viewers',
    'cheap followers',
    'best viewers on',
    'best viewers for',
    'viewers on',
    'upgrade your stream',
    'boost your stream',
    'promote your stream',
    'stream promotion',
    'grow your channel',
    'grow your stream',
    'grow the right way',
    'real viewers',
    'live viewers',
    'thousands of viewers',
    'increase your viewers',
    'more viewers on',
    'get more viewers',
    'primeviews',
    'streamboost',
    'viewer bot',
    'viewbot',
    'follow bot',
    'comprare follower',
    'aumenta gli spettatori',
    'più spettatori sul tuo canale',
  ),
  ...s(
    'VENDITORE',
    30,
    'we can help you grow',
    'want to grow',
    'need more viewers',
    'services for streamers',
    'affordable prices',
    'check our site',
    'visit our website',
  ),

  /* ── Finti regali ───────────────────────────────────────────────────
     Carte Steam, skin, Nitro. Il testo è sempre lo stesso perché è tradotto
     a macchina dallo stesso originale. */
  ...s(
    'TRUFFA_REGALO',
    60,
    'free steam gift',
    'steam gift card',
    'free gift card',
    'free skins',
    'free csgo',
    'free cs2 skins',
    'free nitro',
    'discord nitro free',
    'claim your prize',
    'you won a',
    'you have been selected',
    'congratulations you won',
    'giveaway winner',
    'hai vinto un',
    'carta regalo gratis',
    'regalo gratuito',
  ),
  ...s(
    'TRUFFA_REGALO',
    35,
    'giveaway ends today',
    'limited time offer',
    'first 100 people',
    'only today',
    'hurry up',
  ),

  /* ── Finti servizi ──────────────────────────────────────────────────
     Grafici, montatori, «manager». Chiedono un anticipo e spariscono. Il
     peso è medio: esistono grafici veri che si offrono in chat, e bandirli
     tutti sarebbe sbagliato. Serve un secondo segnale. */
  ...s(
    'FINTO_SERVIZIO',
    30,
    'see my work',
    'check my work',
    'logos banners overlays',
    'i make emotes',
    'i make overlays',
    'custom artist',
    'graphic designer here',
    'do you need a designer',
    'video editor here',
    'i can edit your',
    'cerchi un grafico',
    'faccio emote',
  ),

  /* ── Adescamento fuori piattaforma ──────────────────────────────────
     Portare la conversazione dove non c'è moderazione è il passo che precede
     ogni truffa più seria. Peso basso: in chat ci si scambia i contatti in
     buona fede tutto il giorno. */
  ...s(
    'ADESCAMENTO',
    18,
    'add me on insta',
    'add me on discord',
    'lets link on discord',
    'dm me on',
    'message me on telegram',
    'contact me on whatsapp',
    'my username is',
    'scrivimi in privato',
    'contattami su',
  ),

  /* ── Cripto ─────────────────────────────────────────────────────────
     Il wallet drainer è la coda di quasi tutte le truffe con regalo: la
     pagina chiede di collegare il portafoglio «per verificare». */
  ...s(
    'CRIPTO',
    55,
    'connect wallet',
    'connect your wallet',
    'claim airdrop',
    'free airdrop',
    'crypto giveaway',
    'double your bitcoin',
    'invest with me',
    'trading signals',
    'earn passive income',
    'guadagno garantito',
  ),

  /* ── Imitazione ─────────────────────────────────────────────────────
     «Il tuo account verrà sospeso». Funziona perché nessuno controlla il
     mittente in una chat che scorre. */
  ...s(
    'IMITAZIONE',
    65,
    'twitch support here',
    'official twitch',
    'your account will be suspended',
    'your account has been flagged',
    'verify your account',
    'account verification required',
    'staff di twitch',
    'il tuo account verra sospeso',
    'verifica il tuo account',
  ),
];

/**
 * Domini.
 *
 * Confermano, non decidono da soli — con l'eccezione dei venditori di
 * visualizzatori, che non hanno alcun uso legittimo. Vale la pena ripeterlo:
 * questa lista invecchia, e serve soprattutto per i primi giorni. Le
 * blocklist aggiornate ogni sei ore per il bot Discord sono la difesa vera.
 */
export const DOMINI_SOSPETTI: { dominio: string; categoria: CategoriaSegnale; peso: number }[] = [
  { dominio: 'bigfollows.com', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'streamrise.com', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'eliteviewers.ru', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'nezhna.com', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'streamboo.com', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'botsister.com', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'viewerlabs.com', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'streamboost.io', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'viewbotter.com', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'theviewbot.com', categoria: 'VENDITORE', peso: 70 },
  { dominio: 'viewraid.com', categoria: 'VENDITORE', peso: 70 },
];

/**
 * Marchi imitati nei nomi di dominio.
 *
 * Un dominio che *somiglia* a uno di questi senza esserlo è quasi sempre
 * phishing: `twitch-drops.com`, `steamcommunlty.com`, `discordapp.gift`.
 * Il confronto lo fa `rilevaImitazioneDominio`, qui c'è solo l'elenco di cosa
 * viene imitato e quali sono i domini veri.
 */
export const MARCHI: { nome: string; veri: string[] }[] = [
  { nome: 'twitch', veri: ['twitch.tv', 'twitchcdn.net', 'ttvnw.net', 'jtvnw.net'] },
  { nome: 'steam', veri: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com'] },
  { nome: 'discord', veri: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net'] },
  { nome: 'youtube', veri: ['youtube.com', 'youtu.be', 'ytimg.com'] },
  { nome: 'riotgames', veri: ['riotgames.com', 'leagueoflegends.com'] },
  { nome: 'epicgames', veri: ['epicgames.com', 'unrealengine.com'] },
  { nome: 'nintendo', veri: ['nintendo.com', 'nintendo.net'] },
  { nome: 'paypal', veri: ['paypal.com', 'paypal.me'] },
];

/**
 * Login di bot noti.
 *
 * Cortissimo apposta. Un elenco di nomi invecchia in giorni — chi vende
 * visualizzatori cambia account ogni volta che viene bandito — e un elenco
 * lungo di nomi morti dà l'impressione di una difesa che non c'è. Chi ne
 * incontra di nuovi li aggiunge dal pannello, o li lascia riconoscere alle
 * frasi, che restano.
 */
export const LOGIN_NOTI: string[] = ['clippit_exe', 'duskvtuber'];

/**
 * Bot legittimi da non toccare mai.
 *
 * Non è cortesia: è che silenziare Nightbot o StreamElements rompe il canale
 * di qualcun altro, e il primo sospettato sarebbe il nostro bot. Restano
 * esenti anche a livello BLINDATO.
 */
export const BOT_LEGITTIMI: string[] = [
  'nightbot',
  'streamelements',
  'streamlabs',
  'moobot',
  'fossabot',
  'wizebot',
  'sery_bot',
  'soundalerts',
  'pretzelrocks',
  'commanderroot',
  'own3d',
];

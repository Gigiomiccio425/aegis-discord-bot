import type { GuildConfig } from './index.js';

/* ═══════════════════════════════════════════════════════════════════════
   CONTROLLO DI COERENZA

   Il difetto che ha reso necessario questo file non era un errore di calcolo:
   era una funzione che dipendeva da un dato che nessuno scriveva. Il codice
   compilava, i test passavano, la configurazione sembrava a posto, e il
   comportamento era sbagliato in un modo che si poteva scoprire solo usandolo.

   Sono guasti che non si vedono guardando un modulo alla volta, perché non
   stanno dentro un modulo: stanno **fra** i moduli. Le tre forme sono sempre
   le stesse.

     1. **Dipendenza mancante.** Il modulo A si appoggia a B, e B è spento.
        Nessun errore, semplicemente A non fa più ciò che dice di fare.
     2. **Campo necessario vuoto.** L'azione «quarantena» senza il ruolo di
        quarantena non isola nessuno, e il registro senza un canale non si
        legge.
     3. **Contrasto.** Due impostazioni ragionevoli prese da sole che insieme
        producono un comportamento che nessuno voleva — lo stesso ruolo usato
        come «non ha ancora verificato» e come «è stato sanzionato».

   Il metodo scelto è dichiarativo e non automatico: le dipendenze si scrivono
   qui, un test verifica che parlino di moduli e campi che esistono davvero, e
   il risultato si legge nel pannello e da Discord. L'alternativa — dedurle dal
   codice — sarebbe sembrata più elegante e avrebbe scoperto esattamente ciò
   che il codice fa, cioè anche i difetti, spacciandoli per regole.

   Nessun controllo blocca il salvataggio. Una configurazione incoerente è
   spesso un passaggio intermedio verso quella giusta, e un pannello che
   impedisce di salvare a metà strada costringe a fare tutto in un colpo solo
   o a rinunciare.
   ═══════════════════════════════════════════════════════════════════════ */

export type LivelloProblema = 'errore' | 'avviso' | 'nota';

export interface Problema {
  /**
   * `errore`: il modulo è acceso e non può funzionare.
   * `avviso`: funziona, ma non come chi l'ha acceso si aspetta.
   * `nota`: è una scelta legittima che vale la pena rendere esplicita.
   */
  livello: LivelloProblema;
  /** Chiave del modulo in `MODULE_REGISTRY`, o `general`. */
  modulo: string;
  titolo: string;
  dettaglio: string;
  /** Percorso da aprire nella configurazione per rimediare. */
  campo?: string;
}

/** Cosa serve a un modulo per fare ciò che promette. */
export interface Dipendenze {
  /** Altri moduli che devono essere accesi. */
  richiede?: { modulo: string; perche: string; livello?: LivelloProblema }[];
  /** Campi che devono essere valorizzati. */
  campi?: { path: string; perche: string; livello?: LivelloProblema }[];
  /** Permessi Discord senza i quali il modulo non può agire. */
  permessi?: string[];
}

/**
 * Le dipendenze dichiarate, modulo per modulo.
 *
 * Vale la pena dire cosa **non** c'è: nessun modulo di sicurezza dipende da un
 * altro modulo di sicurezza per funzionare. È una proprietà voluta — le difese
 * sono componibili e si valutano in parallelo — e le poche dipendenze qui sotto
 * riguardano segnali che un modulo riceve da un altro, non il suo
 * funzionamento di base.
 */
export const MODULE_DEPS: Record<string, Dipendenze> = {
  'security.antiRaid': {
    campi: [
      {
        path: 'general.quarantineRoleId',
        perche: 'i livelli di risposta che mettono in quarantena non hanno dove isolare nessuno',
        livello: 'avviso',
      },
    ],
    permessi: ['Espellere membri', 'Bannare membri', 'Moderare membri'],
  },

  'security.antiNuke': {
    permessi: ['Gestire i ruoli', 'Visualizzare il registro di controllo'],
  },

  'security.antiSpam': {
    permessi: ['Gestire i messaggi', 'Moderare membri'],
  },

  'security.compromise': {
    richiede: [
      {
        modulo: 'scanner',
        perche:
          'due dei suoi segnali — il codice QR e l\'immagine con link — arrivano dallo scanner: con lo scanner spento restano sempre a zero',
        livello: 'avviso',
      },
    ],
    campi: [
      {
        path: 'general.quarantineRoleId',
        perche: 'sopra la soglia l\'account va isolato, e senza ruolo l\'isolamento non avviene',
      },
    ],
  },

  'security.accountGuard': {
    campi: [
      {
        path: 'general.staffRoleIds',
        perche:
          'il confronto con lo staff serve a riconoscere chi ne imita nome e avatar: senza ruoli staff quel segnale non esiste',
        livello: 'avviso',
      },
    ],
  },

  'security.inviteGuard': {},

  'security.webhookGuard': {
    permessi: ['Gestire i webhook'],
  },

  'security.botGuard': {
    permessi: ['Gestire i ruoli'],
  },

  'security.language': {
    permessi: ['Gestire i messaggi', 'Moderare membri'],
  },

  'security.flame': {
    richiede: [
      {
        modulo: 'security.language',
        perche:
          'riceve dal filtro sul linguaggio il punteggio delle offese: da solo vede il ritmo dello scambio ma non quanto è pesante',
        livello: 'nota',
      },
    ],
    permessi: ['Gestire i canali'],
  },

  'security.safety': {
    campi: [
      {
        path: 'security.safety.reportChannelId',
        perche: 'le segnalazioni con le prove congelate finirebbero nel canale di allerta generico',
        livello: 'nota',
      },
    ],
  },

  'security.verification': {
    campi: [
      {
        path: 'security.verification.verifiedRoleId',
        perche: 'chi supera la verifica non riceve niente, e resta fuori come prima',
      },
      {
        path: 'security.verification.unverifiedRoleId',
        perche: 'chi entra non viene marcato, quindi non c\'è nulla da cui liberarlo verificando',
      },
      {
        path: 'security.verification.verifyChannelId',
        perche: 'il pannello con il pulsante non è pubblicato da nessuna parte',
        livello: 'avviso',
      },
    ],
    permessi: ['Gestire i ruoli', 'Gestire i canali'],
  },

  'security.stickyRoles': {
    permessi: ['Gestire i ruoli'],
  },

  'security.links': {},

  'security.autoMod': {
    permessi: ['Gestire il server'],
  },

  scanner: {},

  logging: {
    campi: [
      {
        path: 'logging.defaultChannelId',
        perche: 'il registro viene scritto nel database ma non compare in nessun canale',
        livello: 'avviso',
      },
    ],
    permessi: ['Visualizzare il registro di controllo'],
  },

  'integrations.twitch': {
    campi: [
      { path: 'integrations.twitch.streamers', perche: 'non c\'è nessuno da seguire', livello: 'nota' },
    ],
  },

  'integrations.youtube': {
    campi: [
      { path: 'integrations.youtube.channels', perche: 'non c\'è nessun canale da seguire', livello: 'nota' },
    ],
  },

  'integrations.rss': {
    campi: [{ path: 'integrations.rss.feeds', perche: 'non c\'è nessun feed da seguire', livello: 'nota' }],
  },

  'integrations.polls': {},
  'integrations.events': {},
  'integrations.giveaways': {},
  'integrations.reactionRoles': {},

  'integrations.starboard': {
    campi: [
      { path: 'integrations.starboard.channelId', perche: 'i messaggi premiati non hanno dove finire' },
    ],
  },

  'integrations.tickets': {
    campi: [
      {
        path: 'integrations.tickets.categoryId',
        perche: 'i canali dei ticket verrebbero creati fuori da ogni categoria',
        livello: 'avviso',
      },
      {
        path: 'integrations.tickets.panelChannelId',
        perche: 'il pulsante per aprire un ticket non è pubblicato da nessuna parte',
        livello: 'avviso',
      },
    ],
    permessi: ['Gestire i canali'],
  },
};

/* ── Lettura dei percorsi ─────────────────────────────────────────────── */

function leggi(config: GuildConfig, path: string): unknown {
  return path.split('.').reduce<unknown>((valore, chiave) => {
    if (valore === null || typeof valore !== 'object') return undefined;
    return (valore as Record<string, unknown>)[chiave];
  }, config);
}

function vuoto(valore: unknown): boolean {
  if (valore === null || valore === undefined) return true;
  if (Array.isArray(valore)) return valore.length === 0;
  if (typeof valore === 'string') return valore.trim() === '';
  return false;
}

function acceso(config: GuildConfig, modulo: string): boolean {
  const sezione = leggi(config, modulo);
  return Boolean(sezione && typeof sezione === 'object' && (sezione as { enabled?: boolean }).enabled);
}

/* ── Analisi ──────────────────────────────────────────────────────────── */

/**
 * Tutti i problemi di una configurazione, dal più grave al più lieve.
 *
 * Pura: nessuna lettura da Discord, nessuna query. La stessa funzione risponde
 * al pannello, al comando `/diagnosi` e ai test, e questo è il punto — tre
 * risposte diverse alla stessa domanda sarebbero state tre occasioni di
 * divergere.
 */
export function analizzaConfigurazione(config: GuildConfig): Problema[] {
  const problemi: Problema[] = [];

  /* Interruttore generale e modalità prova: due impostazioni che spiegano da
     sole perché «il bot non fa niente», e che è meglio dire subito. */
  if (!config.general.masterEnabled) {
    problemi.push({
      livello: 'errore',
      modulo: 'general',
      titolo: 'Interruttore generale spento',
      dettaglio:
        'Tutti i moduli risultano disattivati, qualunque cosa dicano le loro spunte. La configurazione resta salvata com\'è: riaccendendolo si ritrova esattamente come l\'hai lasciata.',
      campo: 'general.masterEnabled',
    });
  }

  if (config.general.dryRun) {
    problemi.push({
      livello: 'nota',
      modulo: 'general',
      titolo: 'Modalità prova attiva',
      dettaglio:
        'I moduli valutano e registrano, ma nessuna sanzione viene applicata. È il modo giusto per tarare le soglie; ricordarsi di spegnerla quando la taratura è finita.',
      campo: 'general.dryRun',
    });
  }

  /* Dipendenze dichiarate. */
  for (const [modulo, dipendenze] of Object.entries(MODULE_DEPS)) {
    if (!acceso(config, modulo)) continue;

    for (const richiesta of dipendenze.richiede ?? []) {
      if (acceso(config, richiesta.modulo)) continue;
      problemi.push({
        livello: richiesta.livello ?? 'avviso',
        modulo,
        titolo: `Dipende da un modulo spento`,
        dettaglio: `Serve **${richiesta.modulo}**, che è spento: ${richiesta.perche}.`,
        campo: `${richiesta.modulo}.enabled`,
      });
    }

    for (const campo of dipendenze.campi ?? []) {
      if (!vuoto(leggi(config, campo.path))) continue;
      problemi.push({
        livello: campo.livello ?? 'errore',
        modulo,
        titolo: 'Campo necessario non impostato',
        dettaglio: `Manca **${campo.path.split('.').pop()}**: ${campo.perche}.`,
        campo: campo.path,
      });
    }
  }

  problemi.push(...contrasti(config));
  problemi.push(...moduliSenzaContenuto(config));

  const ordine: Record<LivelloProblema, number> = { errore: 0, avviso: 1, nota: 2 };
  return problemi.sort((a, b) => ordine[a.livello] - ordine[b.livello]);
}

/**
 * Impostazioni che, prese da sole, sono tutte ragionevoli.
 *
 * È la categoria che nessun controllo per modulo può trovare, perché ogni
 * modulo coinvolto risulta configurato correttamente.
 */
function contrasti(config: GuildConfig): Problema[] {
  const problemi: Problema[] = [];
  const verifica = config.security.verification;

  if (
    verifica.unverifiedRoleId &&
    verifica.unverifiedRoleId === config.general.quarantineRoleId
  ) {
    problemi.push({
      livello: 'errore',
      modulo: 'security.verification',
      titolo: 'Stesso ruolo per «non ha verificato» e «è stato sanzionato»',
      dettaglio:
        'Chi entra verrebbe segnato come quarantenato senza aver fatto nulla, e l\'elenco dei quarantenati — quello che si guarda per capire chi è stato sanzionato — si riempirebbe di persone appena arrivate. I due ruoli hanno anche effetti opposti: chi non ha verificato non deve vedere il server, chi è in quarantena lo vede e non può scrivere.',
      campo: 'security.verification.unverifiedRoleId',
    });
  }

  if (verifica.verifiedRoleId && verifica.verifiedRoleId === verifica.unverifiedRoleId) {
    problemi.push({
      livello: 'errore',
      modulo: 'security.verification',
      titolo: 'Il ruolo dato dalla verifica è lo stesso che marca chi non ha verificato',
      dettaglio: 'Verificare non cambierebbe nulla: si toglie e si rimette lo stesso ruolo.',
      campo: 'security.verification.verifiedRoleId',
    });
  }

  if (
    config.general.quarantineRoleId &&
    config.general.staffRoleIds.includes(config.general.quarantineRoleId)
  ) {
    problemi.push({
      livello: 'errore',
      modulo: 'general',
      titolo: 'Il ruolo di quarantena è fra i ruoli staff',
      dettaglio:
        'Chi viene messo in quarantena diventa staff, quindi esente da tutti i moduli: la sanzione lo rende immune alle sanzioni.',
      campo: 'general.staffRoleIds',
    });
  }

  const compromise = config.security.compromise;
  if (compromise.deleteAtScore > compromise.quarantineAtScore) {
    problemi.push({
      livello: 'errore',
      modulo: 'security.compromise',
      titolo: 'Soglie invertite',
      dettaglio:
        'La soglia di eliminazione è più alta di quella di quarantena: esiste un intervallo in cui la persona viene isolata mentre il suo messaggio resta in chat.',
      campo: 'security.compromise.deleteAtScore',
    });
  }

  if (config.security.autoMod.enabled && config.security.language.enabled) {
    problemi.push({
      livello: 'nota',
      modulo: 'security.autoMod',
      titolo: 'Due filtri sulle stesse parole',
      dettaglio:
        'AutoMod di Discord blocca prima della pubblicazione, il filtro di ANGEL agisce dopo e sa contare le recidive. Insieme funzionano — il primo ferma, il secondo tiene il conto — ma un messaggio bloccato da AutoMod non arriva mai al secondo, quindi non fa punteggio.',
    });
  }

  if (config.logging.enabled && config.logging.messageContent === 'CHANNEL_ONLY') {
    problemi.push({
      livello: 'avviso',
      modulo: 'logging',
      titolo: 'Contenuto dei messaggi non conservato',
      dettaglio:
        'Con questa impostazione l\'archivio resta vuoto: la trascrizione di un ticket, la scheda utente e il recupero dei messaggi eliminati non hanno da dove attingere.',
      campo: 'logging.messageContent',
    });
  }

  if (config.logging.enabled && config.logging.ignoredChannelIds.length > 0) {
    const canaleLog = config.logging.defaultChannelId;
    if (canaleLog && config.logging.ignoredChannelIds.includes(canaleLog)) {
      problemi.push({
        livello: 'nota',
        modulo: 'logging',
        titolo: 'Il canale del registro è fra quelli ignorati',
        dettaglio:
          'È probabilmente voluto — evita che il registro registri se stesso — ma vale la pena saperlo.',
        campo: 'logging.ignoredChannelIds',
      });
    }
  }

  const links = config.security.links;
  if (links.enabled && links.linkChannelIds.length === 0 && links.gifChannelIds.length === 0) {
    problemi.push({
      livello: 'nota',
      modulo: 'security.links',
      titolo: 'Acceso, ma non vieta nulla',
      dettaglio:
        'Nessun canale indicato significa «ovunque»: il modulo è acceso e lascia passare tutto. È lo stato giusto per tenerlo pronto senza applicarlo.',
      campo: 'security.links.linkChannelIds',
    });
  }

  /* Le voci degli annunci: configurate a metà non danno errore, semplicemente
     non pubblicano mai niente. */
  for (const streamer of config.integrations.twitch.streamers) {
    if (!streamer.enabled) continue;
    if (!streamer.announceChannelId) {
      problemi.push({
        livello: 'avviso',
        modulo: 'integrations.twitch',
        titolo: `«${streamer.login}» non ha un canale dove annunciare`,
        dettaglio: 'La diretta viene rilevata e l\'annuncio non parte.',
        campo: 'integrations.twitch.streamers',
      });
    }
    if (streamer.liveRoleId && !streamer.discordUserId) {
      problemi.push({
        livello: 'avviso',
        modulo: 'integrations.twitch',
        titolo: `«${streamer.login}»: ruolo in diretta senza destinatario`,
        dettaglio:
          'Twitch e Discord non hanno niente in comune: senza indicare chi sia questo streamer sul server, il ruolo non viene dato a nessuno.',
        campo: 'integrations.twitch.streamers',
      });
    }
  }

  for (const canale of config.integrations.youtube.channels) {
    if (canale.enabled && !canale.announceChannelId) {
      problemi.push({
        livello: 'avviso',
        modulo: 'integrations.youtube',
        titolo: `«${canale.channel}» non ha un canale dove annunciare`,
        dettaglio: 'Il video viene rilevato e l\'annuncio non parte.',
        campo: 'integrations.youtube.channels',
      });
    }
  }

  for (const feed of config.integrations.rss.feeds) {
    if (feed.enabled && !feed.announceChannelId) {
      problemi.push({
        livello: 'avviso',
        modulo: 'integrations.rss',
        titolo: `«${feed.label || feed.url}» non ha un canale dove annunciare`,
        dettaglio: 'Le novità vengono lette e non pubblicate.',
        campo: 'integrations.rss.feeds',
      });
    }
  }

  return problemi;
}

/** Moduli accesi che, per come sono impostati, non hanno nulla da fare. */
function moduliSenzaContenuto(config: GuildConfig): Problema[] {
  const problemi: Problema[] = [];
  const lingua = config.security.language;

  if (lingua.enabled) {
    const categorieAttive = Object.values(lingua.categories).some(Boolean);
    if (!categorieAttive) {
      problemi.push({
        livello: 'avviso',
        modulo: 'security.language',
        titolo: 'Tutte le categorie sono spente',
        dettaglio:
          'Il filtro è acceso ma non cerca niente: le parole delle categorie spente non vengono confrontate.',
        campo: 'security.language.categories',
      });
    }
    if (lingua.terms.length === 0 && !lingua.usePresetProfanity && !lingua.usePresetSlurs) {
      problemi.push({
        livello: 'avviso',
        modulo: 'security.language',
        titolo: 'Nessuna parola da cercare',
        dettaglio:
          'L\'elenco è vuoto e i filtri predefiniti di Discord sono spenti: non resta nulla da riconoscere.',
        campo: 'security.language.terms',
      });
    }
  }

  const ladders: { modulo: string; path: string; ladder: { action: string }[] }[] = [
    { modulo: 'security.antiSpam', path: 'security.antiSpam.ladder', ladder: config.security.antiSpam.ladder },
    { modulo: 'scanner', path: 'scanner.ladder', ladder: config.scanner.ladder },
    {
      modulo: 'security.accountGuard',
      path: 'security.accountGuard.ladder',
      ladder: config.security.accountGuard.ladder,
    },
  ];

  for (const { modulo, path, ladder } of ladders) {
    if (!acceso(config, modulo)) continue;

    if (ladder.length === 0) {
      problemi.push({
        livello: 'avviso',
        modulo,
        titolo: 'Nessuna azione impostata',
        dettaglio: 'Il modulo valuta e assegna un punteggio, ma non c\'è nessuna soglia che faccia qualcosa.',
        campo: path,
      });
      continue;
    }

    const chiedeQuarantena = ladder.some((gradino) => gradino.action === 'QUARANTINE');
    if (chiedeQuarantena && !config.general.quarantineRoleId) {
      problemi.push({
        livello: 'errore',
        modulo,
        titolo: 'La quarantena non ha un ruolo',
        dettaglio:
          'Una delle soglie mette in quarantena, ma il ruolo di quarantena non è impostato: l\'azione non isola nessuno.',
        campo: 'general.quarantineRoleId',
      });
    }
  }

  return problemi;
}

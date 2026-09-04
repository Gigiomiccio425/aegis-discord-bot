/* ═══════════════════════════════════════════════════════════════════════
   KIT DI TRASLOCO

   Una cartella sola con dentro tutto quello che serve per rimettere in piedi
   ANGEL altrove: i dati, i file archiviati, e — la parte che mancava — un
   file di testo con scritto **quali valori** vanno riportati sulla macchina
   nuova, già pronti da incollare nel compose.

   Perché non basta il backup notturno. Il backup contiene i dati; i dati da
   soli non fanno ripartire nulla. Servono il token del bot, gli identificativi
   dell'applicazione Discord, le chiavi delle integrazioni, e soprattutto la
   ENCRYPTION_KEY — senza la quale i token cifrati dentro il database tornano
   indietro come stringhe illeggibili. Quei valori stanno nel compose della
   macchina vecchia, e la macchina vecchia è precisamente la cosa che nel
   momento del trasloco potrebbe non esserci più.

   ⚠️ IL FILE `TRASLOCO.txt` CONTIENE SEGRETI IN CHIARO.

   È deliberato: un kit che elenca i nomi delle variabili senza i valori
   costringe ad andarli a cercare, cioè esattamente il passaggio che fallisce
   quando la macchina vecchia non risponde più. Le contromisure sono tre: il
   file nasce con permessi 600, si scrive solo su richiesta esplicita (mai in
   automatico, mai di notte), e ogni pagina del pannello che lo riguarda dice
   di cancellarlo a trasloco finito.

   Chi preferisce non averli su disco può chiedere il kit senza segreti: al
   loro posto restano i nomi e le impronte, che bastano a verificare di aver
   riportato i valori giusti ma non a ricostruirli.
   ═══════════════════════════════════════════════════════════════════════ */

import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { getPrisma } from '@angel/db';
import { runningVersion } from '@angel/shared';
import { logger } from '../logger.js';
import {
  controllaSpazio,
  pesoCartella,
  radiceBackup,
  scriviContenuto,
  stampaOra,
} from '../jobs/selfBackup.js';
import { improntaChiave, type Manifesto } from './formato.js';

/** Prefisso delle cartelle di trasloco: distinto da quello delle copie notturne. */
export const PREFISSO_TRASLOCO = 'trasloco-';

/** Quanti kit tenere. Contengono segreti: accumularli è un rischio, non una prudenza. */
const KIT_DA_TENERE = 2;

/**
 * Variabili da riportare, raggruppate per quello che succede se si sbagliano.
 *
 * Il raggruppamento è l'informazione utile. Un elenco piatto di venti variabili
 * costringe a decidere per ognuna se vada copiata o cambiata, venti volte, con
 * la fretta addosso; e l'unica che conta davvero — la chiave di cifratura —
 * sparisce in mezzo alle altre.
 */
export const GRUPPI: { titolo: string; nota: string; segrete: boolean; nomi: string[] }[] = [
  {
    titolo: 'DEVONO ESSERE IDENTICHE',
    nota:
      'Cambiarne una qui significa perdere qualcosa in silenzio: i token cifrati nel\n' +
      'database, o il collegamento fra il bot e la sua applicazione Discord.',
    segrete: true,
    nomi: ['ENCRYPTION_KEY', 'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
  },
  {
    titolo: 'DA RIPORTARE UGUALI (ma se sbagli te ne accorgi subito)',
    nota: 'Un errore qui si vede al primo accesso al pannello o al primo comando.',
    segrete: true,
    nomi: ['OWNER_IDS', 'PANEL_OWNERS_ONLY', 'SESSION_SECRET'],
  },
  {
    titolo: 'CAMBIANO CON LA MACCHINA',
    nota:
      'PUBLIC_URL deve combaciare **esattamente** con l’indirizzo che digiterai nel\n' +
      'browser, porta compresa, e va aggiunto ai redirect OAuth2 nel Developer Portal\n' +
      'di Discord con /api/auth/callback in fondo. Se non combaciano, l’accesso al\n' +
      'pannello fallisce con «stato non valido» e non c’è nient’altro che lo spieghi.',
    segrete: false,
    nomi: ['PUBLIC_URL', 'API_PORT'],
  },
  {
    titolo: 'DATABASE E CODE',
    nota:
      'La password del database sta dentro DATABASE_URL e va ripetuta identica in\n' +
      'POSTGRES_PASSWORD nel compose: sono lo stesso valore scritto in due punti.\n' +
      'Se installi da zero puoi anche inventarne una nuova, purché la cambi in\n' +
      'tutti e due i posti.',
    segrete: true,
    nomi: ['DATABASE_URL', 'REDIS_URL'],
  },
  {
    titolo: 'INTEGRAZIONI (facoltative)',
    nota:
      'Senza queste il bot funziona: lo scanner usa le sole blocklist locali e le\n' +
      'notifiche Twitch restano spente. TWITCH_EVENTSUB_SECRET va riportata uguale,\n' +
      'altrimenti le sottoscrizioni già registrate su Twitch smettono di validare\n' +
      'la firma e gli annunci di diretta spariscono senza errori.',
    segrete: true,
    nomi: [
      'GOOGLE_SAFE_BROWSING_KEY',
      'ABUSECH_AUTH_KEY',
      'THREAT_FEEDS_ENABLED',
      'THREAT_FEED_MAX',
      'TWITCH_CLIENT_ID',
      'TWITCH_CLIENT_SECRET',
      'TWITCH_EVENTSUB_SECRET',
    ],
  },
  {
    titolo: 'BOT TWITCH',
    nota:
      "L'account da cui il bot parla in chat. Vanno riportate identiche: sono le\n" +
      'credenziali di un account Twitch, non di un canale, e senza il bot legge la\n' +
      'chat ma non può scrivere.\n' +
      '\n' +
      'TWITCH_PUBLIC_URL invece cambia con la macchina, e il nuovo indirizzo va\n' +
      'registrato come «OAuth Redirect URL» sul Developer Portal di Twitch con\n' +
      '/api/auth/callback in fondo — altrimenti nessuno streamer riesce a entrare.\n' +
      '\n' +
      'TWITCH_SETUP_KEY non compare di proposito: è la chiave temporanea che apre\n' +
      'la rotta dei token, e portarsela dietro vorrebbe dire lasciare aperta una\n' +
      'porta che serviva dieci minuti.',
    segrete: true,
    nomi: [
      'TWITCH_BOT_USER_ID',
      'TWITCH_BOT_LOGIN',
      'TWITCH_BOT_ACCESS_TOKEN',
      'TWITCH_BOT_REFRESH_TOKEN',
      'TWITCH_PUBLIC_URL',
      'TWITCH_PANEL_PORT',
    ],
  },
  {
    titolo: 'PERCORSI E COPIE',
    nota:
      'Sono percorsi visti da dentro il container: cambiali solo se cambi anche i\n' +
      'volumi nel compose.',
    segrete: false,
    nomi: [
      'SHARD_COUNT',
      'STORAGE_DIR',
      'BACKUP_DIR',
      'BACKUP_KEEP',
      'BACKUP_INCLUDE_STORAGE',
      'BACKUP_STORAGE_MAX_MB',
      'LOG_LEVEL',
      'TZ',
    ],
  },
];

export interface EsitoTrasloco {
  cartella: string;
  righe: number;
  tabelle: number;
  server: number;
  byte: number;
  conSegreti: boolean;
  archivioIncluso: boolean;
}

export interface OpzioniTrasloco {
  /**
   * Scrive i valori dei segreti in chiaro dentro TRASLOCO.txt.
   *
   * Vero è il predefinito perché è il motivo per cui il kit esiste. Falso
   * produce un kit che si può conservare senza pensieri e che va completato a
   * mano con i valori presi dal compose della macchina vecchia.
   */
  conSegreti?: boolean;
}

/* ── Ingresso ─────────────────────────────────────────────────────────── */

export async function preparaTrasloco(opzioni: OpzioniTrasloco = {}): Promise<EsitoTrasloco> {
  const conSegreti = opzioni.conSegreti ?? true;
  const radice = radiceBackup();
  const stampa = stampaOra();
  const cartella = path.join(radice, `${PREFISSO_TRASLOCO}${stampa}`);
  const lavoro = path.join(radice, `.trasloco-in-corso-${stampa}`);

  await fs.mkdir(radice, { recursive: true });
  await controllaSpazio(radice);

  let esito: EsitoTrasloco;

  try {
    // I dati si producono adesso e non si copiano dall'ultima notturna:
    // quella può avere venti ore, e venti ore di registro perse durante un
    // trasloco sono i dati di cui poi si sente la mancanza.
    const { manifesto, risultato } = await scriviContenuto(
      lavoro,
      `${PREFISSO_TRASLOCO}${stampa}`,
    );

    const server = await elencoServer();
    const impronte = await improntaFile(lavoro);

    const testo = await componiTesto({
      manifesto,
      server,
      impronte,
      conSegreti,
      nomeCartella: `${PREFISSO_TRASLOCO}${stampa}`,
    });

    const file = path.join(lavoro, 'TRASLOCO.txt');
    await fs.writeFile(file, testo, 'utf8');
    // 0600: leggibile solo da chi possiede il file. Su un volume Docker non è
    // una barriera contro chi ha accesso all'host, ma toglie di mezzo il caso
    // banale — la cartella condivisa, il backup automatico dell'host, l'altro
    // utente della macchina.
    await fs.chmod(file, 0o600).catch(() => undefined);

    await fs.rename(lavoro, cartella);

    esito = {
      cartella,
      righe: risultato.righe,
      tabelle: risultato.tabelle,
      server: server.length,
      byte: await pesoCartella(cartella),
      conSegreti,
      archivioIncluso: risultato.archivio.incluso,
    };
  } catch (errore) {
    await fs.rm(lavoro, { recursive: true, force: true }).catch(() => undefined);
    throw errore;
  }

  await potaKit(radice);

  logger.warn(
    { cartella, conSegreti },
    conSegreti
      ? 'kit di trasloco pronto — contiene segreti in chiaro, cancellalo a trasloco finito'
      : 'kit di trasloco pronto, senza segreti',
  );
  return esito;
}

/* ── Raccolta ─────────────────────────────────────────────────────────── */

interface ServerRiga {
  id: string;
  name: string;
  memberCount: number;
  active: boolean;
}

/**
 * L'elenco dei server serve a una cosa sola, e non è la nostalgia: dopo il
 * trasloco si apre il pannello e si confronta. Se ne manca uno, o se i
 * conteggi sono a zero, il ripristino è andato a metà — e senza un elenco di
 * riferimento quella verifica non si può fare, perché il pannello nuovo mostra
 * quello che ha, non quello che dovrebbe avere.
 */
async function elencoServer(): Promise<ServerRiga[]> {
  try {
    return await getPrisma().guild.findMany({
      select: { id: true, name: true, memberCount: true, active: true },
      orderBy: { memberCount: 'desc' },
    });
  } catch (errore) {
    logger.warn({ err: errore }, 'elenco dei server non letto per il kit di trasloco');
    return [];
  }
}

/**
 * SHA-256 dei file pesanti.
 *
 * Un archivio che arriva troncato — connessione caduta a metà dello `scp`,
 * chiavetta estratta troppo presto — si estrae comunque per buona parte, e il
 * ripristino sembra riuscito con qualche tabella in meno. Il confronto delle
 * impronte trasforma quel caso in una riga che dice «questo file non è quello
 * che è partito».
 */
async function improntaFile(cartella: string): Promise<Record<string, { sha: string; byte: number }>> {
  const impronte: Record<string, { sha: string; byte: number }> = {};

  for (const nome of ['dati.tar.gz', 'archivio.tar.gz']) {
    const percorso = path.join(cartella, nome);
    const stato = await fs.stat(percorso).catch(() => null);
    if (!stato?.isFile()) continue;

    const sha = await new Promise<string>((risolvi, rifiuta) => {
      const hash = createHash('sha256');
      const flusso = createReadStream(percorso);
      flusso.on('data', (pezzo) => hash.update(pezzo));
      flusso.on('end', () => risolvi(hash.digest('hex')));
      flusso.on('error', rifiuta);
    });

    impronte[nome] = { sha, byte: stato.size };
  }

  return impronte;
}

/* ── Il file di testo ─────────────────────────────────────────────────── */

function valore(nome: string): string | undefined {
  const letto = process.env[nome];
  return letto === undefined || letto === '' ? undefined : letto;
}

/** Impronta di un segreto: riconoscibile, non ricostruibile. */
function impronta(testo: string): string {
  return createHash('sha256').update(testo).digest('hex').slice(0, 12);
}

function riquadro(titolo: string): string {
  const linea = '═'.repeat(74);
  return `\n${linea}\n  ${titolo}\n${linea}\n`;
}

function peso(byte: number): string {
  if (byte >= 1024 * 1024 * 1024) return `${(byte / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (byte >= 1024 * 1024) return `${(byte / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(byte / 1024))} KB`;
}

export async function componiTesto(dati: {
  manifesto: Manifesto;
  server: ServerRiga[];
  impronte: Record<string, { sha: string; byte: number }>;
  conSegreti: boolean;
  nomeCartella: string;
}): Promise<string> {
  const { manifesto, server, impronte, conSegreti, nomeCartella } = dati;
  const parti: string[] = [];

  /* ── Intestazione ────────────────────────────────────── */
  parti.push(
    `TRASLOCO DI ANGEL\n` +
      `${'─'.repeat(74)}\n` +
      `Preparato il      ${new Date().toISOString()}\n` +
      `Versione          ${runningVersion()}\n` +
      `Cartella          ${nomeCartella}\n` +
      `Server nel bot    ${server.length}\n` +
      `Righe esportate   ${manifesto.totaleRighe.toLocaleString('it-IT')} in ` +
      `${Object.keys(manifesto.righe).length} tabelle\n`,
  );

  if (conSegreti) {
    parti.push(
      `\n${'!'.repeat(74)}\n` +
        `  QUESTO FILE CONTIENE SEGRETI IN CHIARO\n` +
        `\n` +
        `  Token del bot, chiave di cifratura, password del database. Chi lo legge\n` +
        `  può prendere il controllo del bot e di ogni server dove si trova.\n` +
        `\n` +
        `  • non passarlo su canali che conservano i messaggi (Discord, email, chat)\n` +
        `  • cancellalo da tutte e due le macchine appena il trasloco è finito\n` +
        `  • se pensi che qualcuno l'abbia visto, rigenera token e segreti dal\n` +
        `    Developer Portal di Discord: è veloce, e l'alternativa non esiste\n` +
        `${'!'.repeat(74)}\n`,
    );
  } else {
    parti.push(
      `\nKit SENZA SEGRETI. Al posto dei valori trovi le loro impronte: servono a\n` +
        `verificare di aver riportato quello giusto, non a ricostruirlo. I valori\n` +
        `vanno presi dal compose della macchina vecchia.\n`,
    );
  }

  /* ── Cosa c'è nella cartella ─────────────────────────── */
  parti.push(riquadro('1. COSA C’È IN QUESTA CARTELLA'));
  parti.push(
    `TRASLOCO.txt     questo file\n` +
      `MANIFESTO.json   cosa contiene la copia, in forma leggibile da un programma\n` +
      `ISTRUZIONI.md    come rileggere la copia\n` +
      `dati.tar.gz      il database: una cartella tabelle/ con un file per tabella\n` +
      `archivio.tar.gz  allegati archiviati e trascrizioni dei ticket\n`,
  );

  if (Object.keys(impronte).length > 0) {
    parti.push(`\nImpronte SHA-256 — confrontale dopo aver copiato, prima di ripristinare:\n\n`);
    for (const [nome, { sha, byte }] of Object.entries(impronte)) {
      parti.push(`  ${nome.padEnd(18)} ${peso(byte).padStart(10)}  ${sha}\n`);
    }
    parti.push(
      `\n  Sulla macchina nuova:  sha256sum dati.tar.gz\n` +
        `  Se non combacia, il file è arrivato troncato: ricopialo. Un archivio\n` +
        `  troncato si estrae comunque per buona parte, e il ripristino sembra\n` +
        `  riuscito con qualche tabella in meno.\n`,
    );
  }

  if (!manifesto.archivio.incluso) {
    parti.push(
      `\n⚠️  archivio.tar.gz NON è in questa cartella: ${manifesto.archivio.motivo ?? 'non incluso'}.\n` +
        `   Allegati e trascrizioni dei ticket vanno copiati a mano dalla cartella\n` +
        `   ${valore('STORAGE_DIR') ?? '/data/storage'} del container vecchio, altrimenti nel\n` +
        `   database restano i percorsi e i file non ci sono più.\n`,
    );
  }

  /* ── I dati ──────────────────────────────────────────── */
  parti.push(riquadro('2. COSA DEVI RITROVARE DOPO IL TRASLOCO'));
  parti.push(
    `Se dopo il ripristino il pannello mostra numeri diversi da questi, il\n` +
      `trasloco è andato a metà. Sono la lista di controllo.\n\n`,
  );

  if (server.length > 0) {
    parti.push(`Server (${server.length}):\n\n`);
    for (const riga of server) {
      const stato = riga.active ? '' : '  [bot rimosso]';
      parti.push(
        `  ${riga.id.padEnd(20)} ${String(riga.memberCount).padStart(7)} membri  ` +
          `${riga.name}${stato}\n`,
      );
    }
    parti.push('\n');
  }

  parti.push(`Righe per tabella:\n\n`);
  for (const [tabella, righe] of Object.entries(manifesto.righe).sort(
    (a, b) => b[1] - a[1],
  )) {
    parti.push(`  ${tabella.padEnd(22)} ${righe.toLocaleString('it-IT').padStart(10)}\n`);
  }

  if (manifesto.errori.length > 0) {
    parti.push(
      `\n⚠️  Tabelle che hanno dato errore durante l'esportazione: ` +
        `${manifesto.errori.join(', ')}\n` +
        `   Quelle righe NON sono in questa copia.\n`,
    );
  }

  /* ── Le variabili ────────────────────────────────────── */
  parti.push(riquadro('3. I VALORI DA RIPORTARE'));

  for (const gruppo of GRUPPI) {
    parti.push(`\n── ${gruppo.titolo} ${'─'.repeat(Math.max(0, 68 - gruppo.titolo.length))}\n`);
    parti.push(`${gruppo.nota}\n\n`);

    for (const nome of gruppo.nomi) {
      const letto = valore(nome);
      // Le assenti restano nell'elenco, commentate: sapere che una variabile
      // esiste e non è impostata è diverso dal non sapere che esiste. La prima
      // si valuta e si scarta, la seconda si scopre quando manca qualcosa.
      if (letto === undefined) {
        parti.push(`  # ${nome} — non impostata su questa macchina\n`);
        continue;
      }
      if (gruppo.segrete && !conSegreti) {
        parti.push(`  ${nome}=XXXXX   # segreto — impronta ${impronta(letto)}\n`);
        continue;
      }
      parti.push(`  ${nome}=${letto}\n`);
    }
  }

  // L'impronta si prende dal manifesto e non dall'ambiente: è quella della
  // chiave con cui *questa* copia è stata scritta, ed è quella che il
  // ripristino confronterà. Ricalcolarla dall'ambiente darebbe la stessa
  // risposta quasi sempre, e quel «quasi» è esattamente il caso da scoprire.
  parti.push(
    `\nImpronta della ENCRYPTION_KEY: ${
      manifesto.improntaChiave ?? improntaChiave() ?? 'nessuna chiave impostata'
    }\n` +
      `È la stessa che sta nel MANIFESTO.json. Il ripristino le confronta e si\n` +
      `ferma se non combaciano: i dati tornerebbero tutti e i token delle\n` +
      `integrazioni resterebbero illeggibili, senza che niente lo dica.\n`,
  );

  /* ── Blocco da incollare ─────────────────────────────── */
  parti.push(riquadro('4. BLOCCO PRONTO DA INCOLLARE NEL COMPOSE'));
  parti.push(
    conSegreti
      ? `Va sotto \`environment:\` del servizio \`angel\`. PUBLIC_URL è già da\n` +
          `cambiare con l'indirizzo della macchina nuova.\n\n`
      : `Kit senza segreti: dove c'è XXXXX metti il valore preso dal compose\n` +
          `della macchina vecchia, e verifica con l'impronta qui sopra.\n\n`,
  );

  for (const gruppo of GRUPPI) {
    for (const nome of gruppo.nomi) {
      const letto = valore(nome);
      if (letto === undefined) continue;
      const mostrato = gruppo.segrete && !conSegreti ? 'XXXXX' : letto;
      // Le virgolette servono a YAML per i valori che sembrano numeri o
      // booleani: '780' senza virgolette diventa il numero 780, e Docker
      // rifiuta una porta che non è una stringa.
      parti.push(`      ${nome}: '${mostrato.replace(/'/g, "''")}'\n`);
    }
  }

  parti.push(
    `\nE la password del database, che va scritta anche nel servizio postgres:\n\n` +
      `      POSTGRES_PASSWORD: '${
        conSegreti ? estraiPassword(valore('DATABASE_URL')) ?? 'XXXXX' : 'XXXXX'
      }'\n`,
  );

  /* ── Procedura ───────────────────────────────────────── */
  parti.push(riquadro('5. COSA FARE, NELL’ORDINE'));
  parti.push(
    `1.  Sulla macchina NUOVA, installa ANGEL con il compose di sempre e i valori\n` +
      `    del punto 4. Cambia PUBLIC_URL con il nuovo indirizzo.\n` +
      `\n` +
      `2.  Fallo partire UNA VOLTA e aspetta che il pannello si apra. Serve che le\n` +
      `    migrazioni creino le tabelle vuote in cui versare i dati. Non\n` +
      `    configurare niente: verrebbe sovrascritto.\n` +
      `\n` +
      `3.  Copia questa cartella intera dentro BACKUP_DIR della macchina nuova\n` +
      `    (con il compose predefinito: /DATA/angel-backup).\n` +
      `\n` +
      `4.  Confronta le impronte SHA-256 del punto 1. Se una non combacia, il file\n` +
      `    è arrivato rotto: ricopialo prima di andare avanti.\n` +
      `\n` +
      `5.  SPEGNI IL BOT SULLA MACCHINA VECCHIA. Due processi collegati allo stesso\n` +
      `    token si contendono il gateway: Discord ne fa cadere uno di continuo, e\n` +
      `    ogni sanzione rischia di essere applicata due volte.\n` +
      `\n` +
      `6.  Nel compose della macchina nuova, sotto environment:\n` +
      `\n` +
      `      RESTORE_FROM: /backup/${nomeCartella}\n` +
      `\n` +
      `    Riavvia l'app. Il ripristino avviene prima che il bot si colleghi, una\n` +
      `    volta sola, e lascia qui dentro un file RIPRISTINATO perché non si\n` +
      `    ripeta al riavvio successivo.\n` +
      `\n` +
      `7.  Togli RESTORE_FROM dal compose.\n` +
      `\n` +
      `8.  Nel Developer Portal di Discord → OAuth2, aggiungi il redirect:\n` +
      `      ${valore('PUBLIC_URL') ?? 'http://NUOVO-INDIRIZZO'}/api/auth/callback\n` +
      `    con il NUOVO indirizzo. Senza, l'accesso al pannello fallisce con\n` +
      `    «stato non valido» e non c'è nient'altro che lo spieghi.\n`,
  );

  /* ── Verifiche ───────────────────────────────────────── */
  parti.push(riquadro('6. VERIFICHE, IN QUEST’ORDINE'));
  parti.push(
    `[ ] il pannello si apre e mostra tutti i ${server.length} server del punto 2\n` +
      `[ ] il registro contiene eventi vecchi di giorni, non solo di adesso\n` +
      `[ ] un ticket chiuso tempo fa ha ancora la sua trascrizione\n` +
      `[ ] /salute risponde e mostra database e Redis verdi\n` +
      `[ ] le integrazioni Twitch e YouTube funzionano\n` +
      `        (se no: ENCRYPTION_KEY sbagliata — i dati ci sono, i token no)\n` +
      `[ ] il bot risponde a un comando in un server\n`,
  );

  /* ── Se va male ──────────────────────────────────────── */
  parti.push(riquadro('7. SE QUALCOSA VA STORTO'));
  parti.push(
    `Il ripristino si ferma da solo in tre casi, e in tutti e tre dice quale:\n` +
      `\n` +
      `  «ENCRYPTION_KEY diversa»\n` +
      `      Hai messo una chiave nuova. Rimetti quella del punto 3 e riavvia.\n` +
      `      Per procedere lo stesso — i dati tornano, le integrazioni vanno\n` +
      `      riconfigurate a mano — aggiungi:  RESTORE_ACCEPT_KEY_MISMATCH: '1'\n` +
      `\n` +
      `  «il database non è vuoto»\n` +
      `      Sulla macchina nuova c'è già qualcosa. Per sostituirlo davvero:\n` +
      `        RESTORE_OVERWRITE: '1'\n` +
      `      Svuota le tabelle prima di riempirle. Non è reversibile.\n` +
      `\n` +
      `  «MANIFESTO.json non trovato»\n` +
      `      RESTORE_FROM deve indicare QUESTA cartella, non quella che le\n` +
      `      contiene tutte, e con il percorso visto da dentro il container.\n` +
      `\n` +
      `Se non riparte niente: la macchina vecchia non è stata toccata da questa\n` +
      `procedura. Riaccendila e riprova con calma.\n`,
  );

  parti.push(riquadro('8. FINITO'));
  parti.push(
    conSegreti
      ? `Cancella questo file da tutte e due le macchine:\n` +
          `\n` +
          `  shred -u TRASLOCO.txt        (oppure: rm TRASLOCO.txt)\n` +
          `\n` +
          `Il resto della cartella si può tenere: è una copia di sicurezza come le\n` +
          `altre, e senza TRASLOCO.txt non contiene nessun segreto.\n`
      : `Questa cartella non contiene segreti: si può conservare come una copia di\n` +
          `sicurezza qualsiasi.\n`,
  );

  return parti.join('');
}

/**
 * Tira fuori la password da un URL di connessione.
 *
 * Sta scritta in due posti che devono coincidere — dentro DATABASE_URL e in
 * POSTGRES_PASSWORD — e le àncore YAML sanno copiare un valore intero, non
 * inserirlo dentro una stringa più lunga. Chi ricopia a mano ne sbaglia una
 * delle due, e il sintomo è un Postgres che rifiuta l'autenticazione senza
 * dire quale delle due copie è quella buona.
 */
export function estraiPassword(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).password) || null;
  } catch {
    return null;
  }
}

/** Tiene solo gli ultimi kit: contengono segreti, accumularli non è prudenza. */
async function potaKit(radice: string): Promise<void> {
  const voci = await fs.readdir(radice, { withFileTypes: true }).catch(() => []);

  for (const voce of voci) {
    if (voce.isDirectory() && voce.name.startsWith('.trasloco-in-corso-')) {
      await fs
        .rm(path.join(radice, voce.name), { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  const kit = voci
    .filter((voce) => voce.isDirectory() && voce.name.startsWith(PREFISSO_TRASLOCO))
    .map((voce) => voce.name)
    .sort()
    .reverse();

  for (const vecchio of kit.slice(KIT_DA_TENERE)) {
    await fs.rm(path.join(radice, vecchio), { recursive: true, force: true }).catch(() => undefined);
    logger.info({ cartella: vecchio }, 'kit di trasloco vecchio rimosso');
  }
}

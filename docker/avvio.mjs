/* ═══════════════════════════════════════════════════════════════════════
   AVVIO UNICO

   Fa partire migrazione, bot, worker e pannello in un solo container.

   La ragione è la manutenzione, non l'eleganza. Con quattro container che
   condividono la stessa immagine, aggiornare significa aggiornarne quattro, e
   basta che uno resti indietro perché il sistema si comporti in modo
   incomprensibile: il pannello mostra la versione nuova, il bot fa quello che
   faceva prima, e sembra che la correzione non funzioni. È successo davvero,
   perché l'app store di ZimaOS espande le àncore YAML al momento
   dell'installazione e conserva quattro righe `image:` separate.

   Con un container solo quel problema non esiste più: c'è una riga da cambiare
   e una cosa da riavviare.

   Il prezzo è che serve un supervisore, perché Docker sorveglia il processo
   numero uno e non i suoi figli. Se il bot muore, senza qualcuno che se ne
   accorga il container resta vivo e vuoto — apparentemente sano, in realtà
   spento. Questo file è quel qualcuno.
   ═══════════════════════════════════════════════════════════════════════ */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** I tre processi di lunga durata. La migrazione è a parte: finisce e basta. */
const SERVIZI = [
  { nome: 'bot', comando: ['node', 'apps/bot/dist/index.js'] },
  { nome: 'worker', comando: ['node', 'apps/worker/dist/index.js'] },
  { nome: 'api', comando: ['node', 'apps/api/dist/index.js'] },
];

/** Tentativi di migrazione prima di arrendersi, uno ogni tre secondi. */
const TENTATIVI_MIGRAZIONE = 40;
/** Attesa minima e massima fra due riavvii dello stesso processo. */
const RIAVVIO_MIN_MS = 1000;
const RIAVVIO_MAX_MS = 30_000;

let inChiusura = false;
const figli = new Map();

function log(messaggio) {
  // Una riga sola, con l'ora: questi messaggi finiscono mescolati all'output
  // JSON dei tre processi, e devono restare distinguibili a occhio.
  console.log(`[avvio] ${new Date().toISOString()} ${messaggio}`);
}

/**
 * Applica le migrazioni, riprovando finché il database non risponde.
 *
 * `depends_on` garantisce l'ordine di avvio dei container, non che Postgres
 * sia pronto ad accettare connessioni: fra i due momenti passano secondi, e
 * senza attesa la prima migrazione fallirebbe sempre.
 */
function migra() {
  return new Promise((risolvi, rifiuta) => {
    let tentativo = 0;

    const prova = () => {
      tentativo += 1;
      const processo = spawn('npm', ['run', 'deploy', '-w', '@angel/db'], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });

      processo.on('exit', (codice) => {
        if (codice === 0) {
          log('migrazioni applicate');
          risolvi();
          return;
        }
        if (tentativo >= TENTATIVI_MIGRAZIONE) {
          rifiuta(
            new Error(
              `database irraggiungibile dopo ${TENTATIVI_MIGRAZIONE} tentativi. ` +
                'Controlla i log del container Postgres.',
            ),
          );
          return;
        }
        log(`database non ancora pronto (${tentativo}/${TENTATIVI_MIGRAZIONE}), riprovo fra 3s`);
        setTimeout(prova, 3000);
      });

      processo.on('error', (errore) => rifiuta(errore));
    };

    prova();
  });
}

/**
 * Avvia un servizio e lo tiene in vita.
 *
 * L'attesa fra i riavvii cresce a ogni fallimento consecutivo. Senza, un
 * processo che non riesce a partire — token rifiutato, database irraggiungibile
 * — verrebbe rilanciato centinaia di volte al minuto, riempiendo i log e
 * nascondendo la riga che spiega il motivo.
 */
function avvia(servizio) {
  if (inChiusura) return;

  const [comando, ...argomenti] = servizio.comando;
  const processo = spawn(comando, argomenti, { stdio: 'inherit' });
  figli.set(servizio.nome, processo);

  processo.on('exit', (codice, segnale) => {
    figli.delete(servizio.nome);
    if (inChiusura) return;

    servizio.fallimenti = (servizio.fallimenti ?? 0) + 1;
    const attesa = Math.min(RIAVVIO_MIN_MS * 2 ** (servizio.fallimenti - 1), RIAVVIO_MAX_MS);

    log(
      `${servizio.nome} terminato (${segnale ?? `codice ${codice}`}), ` +
        `riavvio fra ${Math.round(attesa / 1000)}s`,
    );
    setTimeout(() => avvia(servizio), attesa);
  });

  // Un processo che regge un minuto è ripartito davvero: il conteggio dei
  // fallimenti riparte da zero, così un problema di ieri non rallenta la
  // ripresa di oggi.
  setTimeout(() => {
    if (figli.get(servizio.nome) === processo) servizio.fallimenti = 0;
  }, 60_000);
}

/** Propaga la richiesta di spegnimento e attende che i figli chiudano. */
function chiudi(segnale) {
  if (inChiusura) return;
  inChiusura = true;
  log(`ricevuto ${segnale}, spengo i servizi`);

  for (const [nome, processo] of figli) {
    log(`fermo ${nome}`);
    processo.kill('SIGTERM');
  }

  // I processi svuotano le code dei log prima di uscire: se dopo dieci secondi
  // qualcuno è ancora lì, ha smesso di rispondere e va chiuso comunque.
  const limite = setTimeout(() => {
    for (const [nome, processo] of figli) {
      log(`${nome} non risponde, chiusura forzata`);
      processo.kill('SIGKILL');
    }
    process.exit(0);
  }, 10_000);
  limite.unref?.();

  const attendi = setInterval(() => {
    if (figli.size === 0) {
      clearInterval(attendi);
      clearTimeout(limite);
      log('tutti i servizi fermi');
      process.exit(0);
    }
  }, 200);
}

process.on('SIGTERM', () => chiudi('SIGTERM'));
process.on('SIGINT', () => chiudi('SIGINT'));

/* ═══════════════════════════════════════════════════════════════════════
   CONTROLLO DI INTEGRITÀ

   Dopo un aggiornamento si verifica che l'immagine contenga davvero ciò che
   deve eseguire. Sembra superfluo — l'immagine o c'è o non c'è — e invece
   copre il caso in cui la build è riuscita a metà: `tsc` fallisce su un
   pacchetto, la CI pubblica lo stesso perché i job sono indipendenti, e il
   container parte con un `dist` incompleto. Il sintomo è un processo che
   muore subito con «Cannot find module», ripetuto all'infinito dal riavvio
   automatico.

   Controllarlo qui costa millisecondi e trasforma quel ciclo in una riga che
   dice cosa manca.
   ═══════════════════════════════════════════════════════════════════════ */
const PACCHETTI = ['db', 'shared', 'scanner'];

/**
 * I file che devono esistere, ricavati e non scritti a mano.
 *
 * La prima versione elencava percorsi fissi e ne sbagliava uno: `@angel/db`
 * compila in `dist/src/index.js` e non in `dist/index.js`, perché il suo
 * tsconfig comprende anche il client Prisma generato e TypeScript conserva la
 * struttura delle cartelle. Il risultato è stato un controllo che bloccava
 * un'immagine perfettamente valida — un guasto peggiore di quello che doveva
 * prevenire.
 *
 * Ora i percorsi arrivano da dove sono già dichiarati: i comandi dei servizi
 * qui sotto, e il campo `main` di ciascun pacchetto. Se un giorno cambia
 * l'output di una build, cambia anche il controllo, da solo.
 */
function fileRichiesti() {
  const richiesti = SERVIZI.map((servizio) => servizio.comando[1]);

  for (const nome of PACCHETTI) {
    const manifesto = path.join('packages', nome, 'package.json');
    if (!existsSync(manifesto)) {
      richiesti.push(manifesto);
      continue;
    }
    try {
      const { main } = JSON.parse(readFileSync(manifesto, 'utf8'));
      if (main) richiesti.push(path.join('packages', nome, main));
    } catch {
      richiesti.push(manifesto);
    }
  }

  // Il pannello non è un modulo: è servito come file statico dall'API.
  richiesti.push('apps/web/dist/index.html');
  return richiesti;
}

function verificaFile() {
  const richiesti = fileRichiesti();
  const mancanti = richiesti.filter((file) => !existsSync(file));

  if (mancanti.length === 0) {
    log(`verifica file: ${richiesti.length} presenti`);
    return true;
  }

  console.error(
    `[avvio] IMMAGINE INCOMPLETA — mancano ${mancanti.length} file:\n` +
      mancanti.map((file) => `  ${file}`).join('\n') +
      '\n[avvio] La build è riuscita a metà. Torna alla versione precedente ' +
      'cambiando la riga image: nel compose.',
  );
  return false;
}

/**
 * Segna la versione con cui i dati sono stati usati l'ultima volta.
 *
 * Serve a due cose: riconoscere che è appena avvenuto un aggiornamento, e
 * lasciare accanto ai dati una traccia di quale codice li ha scritti. Senza,
 * chi ritrova una cartella di backup fra un anno non ha modo di sapere quali
 * migrazioni erano state applicate.
 */
async function registraVersione() {
  const cartella = process.env.BACKUP_DIR ?? '/backup';
  const segnale = path.join(cartella, 'VERSIONE');
  const attuale = process.env.ANGEL_VERSION ?? 'sviluppo';

  try {
    await fs.mkdir(cartella, { recursive: true });
    const precedente = await fs.readFile(segnale, 'utf8').catch(() => null);
    await fs.writeFile(segnale, `${attuale}\n${new Date().toISOString()}\n`, 'utf8');

    const prima = precedente?.split('\n')[0]?.trim();
    if (prima && prima !== attuale) {
      log(`aggiornamento rilevato: ${prima} → ${attuale}`);
      return true;
    }
  } catch (errore) {
    // La cartella di backup non è montata: non è un motivo per non partire.
    log(`cartella di backup non disponibile (${errore.code ?? errore.message})`);
  }
  return false;
}

log(`ANGEL ${process.env.ANGEL_VERSION ?? 'sviluppo'} — avvio`);

if (!verificaFile()) process.exit(1);

const aggiornato = await registraVersione();

let databasePronto = true;

try {
  await migra();
} catch (errore) {
  /*
   * Il database non risponde. Fino alla 1.21.2 qui si usciva con codice 1, il
   * container ripartiva, riprovava, usciva di nuovo — e il pannello non si
   * apriva mai. Con Postgres fermo per disco pieno l'unica cosa visibile era
   * un ciclo di errori nei log, cioè proprio dove non guarda chi sta cercando
   * di capire perché il bot non c'è più.
   *
   * Ora si parte lo stesso, ma **solo con il pannello**: senza database non
   * può moderare nulla, mentre può dire cosa non va e a quel punto è l'unica
   * cosa che serve. Le migrazioni continuano a essere ritentate in
   * sottofondo, e quando passano parte tutto il resto senza riavvii.
   */
  databasePronto = false;
  console.error(`[avvio] ${errore.message}`);
  log('parto in modalità ridotta: solo il pannello, per poter dire cosa non va');
  process.env.ANGEL_DEGRADATO = '1';
}

if (aggiornato) {
  // La copia si chiede **dopo** le migrazioni e non prima: prima il database
  // sarebbe ancora quello vecchio e la copia non rifletterebbe lo schema con
  // cui verrà riletta. Il rollback vero si fa con il dump di aggiorna.sh, che
  // gira sull'host prima che l'immagine cambi.
  log('richiedo una copia di sicurezza dei dati');
  process.env.BACKUP_ON_START = '1';
}

const daAvviare = databasePronto ? SERVIZI : SERVIZI.filter((servizio) => servizio.nome === 'api');

for (const servizio of daAvviare) {
  log(`avvio ${servizio.nome}`);
  avvia(servizio);
}

if (!databasePronto) {
  /*
   * Ritentativo in sottofondo, con calma: ogni trenta secondi. Chi deve fare
   * spazio sul disco ci mette minuti, non secondi, e riprovare più spesso
   * riempirebbe i log della stessa riga senza avvicinare la soluzione.
   */
  const riprova = setInterval(() => {
    void migra()
      .then(() => {
        clearInterval(riprova);
        delete process.env.ANGEL_DEGRADATO;
        log('database tornato disponibile: avvio i servizi rimanenti');
        for (const servizio of SERVIZI) {
          if (servizio.nome === 'api') continue;
          log(`avvio ${servizio.nome}`);
          avvia(servizio);
        }
      })
      .catch(() => log('database ancora irraggiungibile, continuo a riprovare'));
  }, 30_000);
  riprova.unref?.();
}

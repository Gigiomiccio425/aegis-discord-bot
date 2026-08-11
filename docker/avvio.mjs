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

log(`ANGEL ${process.env.ANGEL_VERSION ?? 'sviluppo'} — avvio`);

try {
  await migra();
} catch (errore) {
  console.error(`[avvio] ${errore.message}`);
  process.exit(1);
}

for (const servizio of SERVIZI) {
  log(`avvio ${servizio.nome}`);
  avvia(servizio);
}

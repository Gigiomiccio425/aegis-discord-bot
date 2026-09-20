import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  applicaSegreti,
  FILE_SEGRETI,
  SEGRETI_GENERABILI,
  segretiDaCompilare,
  valoreMancante,
} from '@angel/shared';

/* ═══════════════════════════════════════════════════════════════════════
   I SEGRETI STANNO IN UNA CARTELLA, NON NEL COMPOSE

   Il `docker-compose.yml` di un'app umbrelOS appartiene al repository: a
   ogni aggiornamento viene riscritto da lì. Tutto quello che ci si scrive
   dentro — token, chiavi, password — sparisce, e nel frattempo sta anche in
   un file di testo che chiunque abbia accesso alla macchina può leggere.

   Qui i valori vivono in `/segreti`, dentro i dati dell'app: un posto che
   gli aggiornamenti non toccano, con i permessi stretti, fuori da qualunque
   repository.

   ── Tre categorie, tre comportamenti ───────────────────────────────────

   • **Generabili** — `SESSION_SECRET`, `ENCRYPTION_KEY`, la password del
     database. Sono numeri casuali: chiederli a chi installa significa solo
     dargli il modo di sbagliarli. Si generano al primo avvio e restano.

   • **Richiesti** — il token del bot, l'applicazione Discord, l'indirizzo
     del pannello. Non si indovinano. Se mancano, il supervisore **aspetta**:
     non fa partire un bot che non può collegarsi, e ricontrolla finché non
     compaiono. Nessun riavvio, nessun ciclo di errori.

   • **Facoltativi** — Twitch, le chiavi dello scanner. Assenti, quelle
     parti restano spente e basta.

   La password del database ha un trattamento suo: sta in un file separato
   perché **anche il container di Postgres deve leggerla**, e lui sa farlo
   solo così (`POSTGRES_PASSWORD_FILE`). Da lì il supervisore compone
   `DATABASE_URL`, che quindi non serve scrivere da nessuna parte.
   ═══════════════════════════════════════════════════════════════════════ */

export { FILE_SEGRETI };

/** La password del database: un file suo, perché lo legge anche Postgres. */
export const FILE_PASSWORD_DB = 'postgres_password';

const chiaveEsadecimale = (byte = 32) => randomBytes(byte).toString('hex');

/**
 * La cartella dei segreti.
 *
 * `SEGRETI_DIR` la sceglie; senza, si ripiega su `STORAGE_DIR`, dove la
 * tenevano le prime installazioni. Il ripiego serve a non far sparire i
 * valori a chi il file l'aveva già scritto lì.
 */
export function cartellaSegreti(ambiente = process.env) {
  return ambiente.SEGRETI_DIR || ambiente.STORAGE_DIR || '/data/storage';
}

/**
 * Dove stava il file prima che i segreti avessero una cartella loro.
 *
 * Fino alla 1.28.1 si scriveva in `STORAGE_DIR`, insieme ai dati. Adesso la
 * cartella è separata — permessi stretti, e Postgres ci entra in sola
 * lettura — ma chi aveva già compilato il vecchio file non deve accorgersene:
 * se il nuovo non c'è ancora, si legge quello. Senza questo ripiego un
 * aggiornamento farebbe sparire i valori senza dire niente, che è esattamente
 * il guasto da cui nasce tutto il meccanismo.
 */
function percorsoVecchio(cartella, ambiente) {
  const vecchia = ambiente.STORAGE_DIR || '/data/storage';
  if (path.resolve(vecchia) === path.resolve(cartella)) return null;
  return path.join(vecchia, FILE_SEGRETI);
}

async function leggiFile(percorso) {
  return fs.readFile(percorso, 'utf8').catch(() => null);
}

/**
 * Prepara i segreti e dice cosa manca ancora.
 *
 * Non lancia mai: un errore qui non deve impedire al pannello di partire —
 * è proprio il pannello che poi spiega cosa non va.
 */
export async function assicuraSegreti(cartella, ambiente = process.env) {
  const percorso = path.join(cartella, FILE_SEGRETI);
  const percorsoDb = path.join(cartella, FILE_PASSWORD_DB);

  const esito = {
    cartella,
    percorso,
    letti: [],
    generati: [],
    mancanti: [],
    avvisi: [],
    scrivibile: true,
  };

  /*
   * Prima il vecchio, poi il nuovo: applicati in quest'ordine, un valore
   * riscritto nella cartella nuova vince su quello di prima. Il contrario
   * renderebbe impossibile correggerlo.
   */
  const vecchio = percorsoVecchio(cartella, ambiente);
  if (vecchio) {
    const testoVecchio = await leggiFile(vecchio);
    if (testoVecchio) {
      const { nomi } = applicaSegreti(testoVecchio, ambiente);
      esito.letti = nomi;
      if (nomi.length > 0) {
        esito.avvisi.push(
          `letti ${nomi.length} valori dal vecchio ${vecchio}. ` +
            `Spostalo quando puoi:  mv ${vecchio} ${percorso}`,
        );
      }
    }
  }

  const testo = (await leggiFile(percorso)) ?? '';
  if (testo) {
    const { nomi } = applicaSegreti(testo, ambiente);
    esito.letti = [...new Set([...esito.letti, ...nomi])];
  }

  /* ── Permessi: un file di segreti non è per tutti ─────────────── */
  await fs
    .stat(percorso)
    .then((stato) => {
      if ((stato.mode & 0o044) !== 0) {
        esito.avvisi.push(`${percorso} è leggibile da altri — chiudilo: chmod 600 ${percorso}`);
      }
    })
    .catch(() => undefined);

  /* ── Quello che si genera da solo ─────────────────────────────── */
  const daScrivere = [];
  for (const nome of SEGRETI_GENERABILI) {
    if (!valoreMancante(ambiente[nome])) continue;
    const valore = chiaveEsadecimale(32);
    ambiente[nome] = valore;
    daScrivere.push(`${nome}=${valore}`);
    esito.generati.push(nome);
  }

  /* ── La password del database, e l'indirizzo che ne deriva ────── */
  let passwordDb = (await leggiFile(percorsoDb))?.trim();
  if (!passwordDb) {
    passwordDb = chiaveEsadecimale(24);
    try {
      await fs.mkdir(cartella, { recursive: true });
      await fs.writeFile(percorsoDb, `${passwordDb}\n`, { mode: 0o600 });
      esito.generati.push(FILE_PASSWORD_DB);
    } catch (errore) {
      esito.scrivibile = false;
      esito.avvisi.push(
        `non riesco a scrivere in ${cartella} (${errore.code ?? errore.message}). ` +
          'Le cartelle di bind-mount le crea Docker, e le crea di root; io giro con ' +
          'uid 1000. Senza questo file **Postgres non parte**: è lui a leggerlo. ' +
          `Sulla macchina, una volta sola:  sudo chown -R 1000:1000 ${cartella}`,
      );
      passwordDb = null;
    }
  }

  if (valoreMancante(ambiente.DATABASE_URL) && passwordDb) {
    const utente = ambiente.POSTGRES_USER || 'angel';
    const db = ambiente.POSTGRES_DB || 'angel';
    const host = ambiente.POSTGRES_HOST || 'postgres';
    ambiente.DATABASE_URL = `postgresql://${utente}:${encodeURIComponent(passwordDb)}@${host}:5432/${db}?schema=public`;
  }

  /* ── Si scrive solo quello che è stato generato ────────────────── */
  if (daScrivere.length > 0) {
    try {
      await fs.mkdir(cartella, { recursive: true });
      const intestazione = testo
        ? ''
        : '# Segreti di ANGEL. Questo file non viene toccato dagli aggiornamenti.\n' +
          '# Una riga per valore, senza virgolette.\n';
      await fs.appendFile(percorso, `${intestazione}${daScrivere.join('\n')}\n`, { mode: 0o600 });
      await fs.chmod(percorso, 0o600).catch(() => undefined);
    } catch (errore) {
      esito.scrivibile = false;
      esito.avvisi.push(
        `${esito.generati.join(', ')} generati ma non salvati (${errore.code ?? errore.message}): ` +
          'al prossimo riavvio sarebbero diversi, e i token cifrati nel database ' +
          'diventerebbero illeggibili. Da sistemare prima di usarlo sul serio.',
      );
    }
  }

  esito.mancanti = segretiDaCompilare(ambiente);
  return esito;
}

/** Il testo da stampare a chi deve ancora compilare qualcosa. */
export function istruzioni(esito) {
  const esempi = {
    DISCORD_TOKEN: 'DISCORD_TOKEN=…            Developer Portal → Bot → Reset Token',
    DISCORD_CLIENT_ID: 'DISCORD_CLIENT_ID=…        Developer Portal → General Information',
    DISCORD_CLIENT_SECRET: 'DISCORD_CLIENT_SECRET=…    Developer Portal → OAuth2',
    PUBLIC_URL: 'PUBLIC_URL=http://…:780    l’indirizzo con cui apri il pannello',
    OWNER_IDS: 'OWNER_IDS=…                il tuo ID Discord',
  };

  return [
    `mancano ${esito.mancanti.length} valori che devo ricevere da te: ${esito.mancanti.join(', ')}`,
    '',
    `scrivili in  ${esito.percorso}  — una riga per valore, senza virgolette:`,
    '',
    ...esito.mancanti.map((nome) => `  ${esempi[nome] ?? `${nome}=…`}`),
    '',
    'non serve riavviare: ricontrollo da solo ogni 15 secondi e parto appena ci sono.',
  ].join('\n');
}

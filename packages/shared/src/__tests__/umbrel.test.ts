import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/* ═══════════════════════════════════════════════════════════════════════
   IL PACCHETTO PER UMBRELOS SI TIENE INSIEME?

   Niente di quello che c'è qui sotto lo verifica umbrelOS. L'app si
   installa lo stesso e fallisce dopo, in modi che non assomigliano alla
   causa:

   • `APP_HOST` sbagliato → l'app parte e mostra una pagina bianca;
   • password del database scritta in due modi → Postgres rifiuta
     l'autenticazione senza dire quale delle due copie fosse quella buona;
   • `version` diversa dal tag dell'immagine → un aggiornamento che dice di
     aver funzionato e non ha scaricato niente, o il contrario.

   Sono tutte informazioni scritte due volte in file diversi, che è la
   forma esatta dei tre guasti già capitati in questo progetto: la
   migrazione mancante, le variabili del trasloco, i workspace fuori dal
   Dockerfile. Il confronto è testuale — nessun parser YAML, nessuna
   dipendenza in più — perché le righe che conta sono `CHIAVE: valore`.
   ═══════════════════════════════════════════════════════════════════════ */

const qui = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(qui, '../../../../umbrel-appstore');
const APP = 'gigiodany-angel';

const store = readFileSync(path.join(BASE, 'umbrel-app-store.yml'), 'utf8');
const manifesto = readFileSync(path.join(BASE, APP, 'umbrel-app.yml'), 'utf8');
const compose = readFileSync(path.join(BASE, APP, 'docker-compose.yml'), 'utf8');

/** Il valore di una riga `chiave: valore`, senza virgolette. */
function valore(testo: string, chiave: string): string | null {
  const trovato = new RegExp(`^\\s*${chiave}:\\s*(.+?)\\s*$`, 'm').exec(testo);
  return trovato ? trovato[1]!.replace(/^["']|["']$/g, '') : null;
}

describe('pacchetto per umbrelOS', () => {
  it('i tre file esistono', () => {
    expect(existsSync(path.join(BASE, 'umbrel-app-store.yml'))).toBe(true);
    expect(existsSync(path.join(BASE, APP, 'umbrel-app.yml'))).toBe(true);
    expect(existsSync(path.join(BASE, APP, 'docker-compose.yml'))).toBe(true);
  });

  /*
   * umbrelOS pretende che l'id dell'app cominci con quello dello store, e
   * che la cartella si chiami come l'id. Non è una convenzione: è il
   * prefisso con cui compose battezza i container, quindi la stringa che
   * deve comparire in `APP_HOST`.
   */
  it("l'id dell'app comincia con quello dello store e dà il nome alla cartella", () => {
    const idStore = valore(store, 'id');
    const idApp = valore(manifesto, 'id');

    expect(idStore).toBeTruthy();
    expect(idApp).toBe(APP);
    expect(idApp!.startsWith(`${idStore}-`)).toBe(true);
  });

  /*
   * Il test per il guasto più silenzioso di tutti.
   *
   * `APP_HOST` è il nome del container come lo genera compose:
   * `<id-app>_<servizio>_1`. Se non combacia, umbrelOS pubblica l'app su
   * una porta che non ha nessuno dietro — e quello che si vede è una
   * pagina bianca, senza un errore da nessuna parte.
   */
  it('APP_HOST punta a un servizio che esiste davvero', () => {
    const host = valore(compose, 'APP_HOST');
    expect(host).toBe(`${APP}_angel_1`);

    const servizio = /^\s{2}(\w+):$/m.exec(compose.slice(compose.indexOf('\n  angel:')));
    expect(servizio?.[1], 'il servizio angel non esiste nel compose').toBe('angel');
  });

  it('la porta è la stessa ovunque', () => {
    const porta = valore(manifesto, 'port');
    expect(porta).toBe('780');
    expect(valore(compose, 'APP_PORT')).toBe(valore(compose, 'API_PORT'));
    expect(valore(compose, 'PUBLIC_URL')).toContain(`:${porta}`);
  });

  it('il pannello Twitch è pubblicato sulla porta che dichiara', () => {
    const porta = valore(compose, 'TWITCH_PANEL_PORT');
    expect(porta).toBeTruthy();
    expect(valore(compose, 'TWITCH_PUBLIC_URL')).toContain(`:${porta}`);
    // Direttamente e non attraverso app_proxy: quello chiede l'accesso a
    // umbrelOS, e gli streamer un account su quella macchina non ce l'hanno.
    expect(compose).toContain(`"${porta}:${porta}"`);
  });

  /*
   * La password del database sta in due punti che devono coincidere:
   * dentro l'URL di connessione e come variabile di Postgres. Le àncore
   * YAML sanno copiare un valore intero, non inserirlo dentro una stringa
   * più lunga — quindi si scrive due volte, e due volte si può sbagliare.
   */
  it('la password del database combacia nei due punti in cui è scritta', () => {
    const url = valore(compose, 'DATABASE_URL');
    const dichiarata = valore(compose, 'POSTGRES_PASSWORD');

    expect(url).toBeTruthy();
    expect(dichiarata).toBeTruthy();

    const dentro = new URL(url!);
    expect(decodeURIComponent(dentro.password)).toBe(dichiarata);
    expect(dentro.username).toBe(valore(compose, 'POSTGRES_USER'));
    // L'host è il nome del servizio: dentro la rete dell'app si raggiunge
    // così, e un indirizzo scritto a mano sarebbe sbagliato al primo
    // riavvio.
    expect(dentro.hostname).toBe('postgres');
  });

  it('Redis si raggiunge per nome di servizio', () => {
    expect(new URL(valore(compose, 'REDIS_URL')!).hostname).toBe('redis');
  });

  /*
   * `version` è quella che umbrelOS mostra e confronta per proporre un
   * aggiornamento; il tag è quello che scarica davvero. Cambiarne uno solo
   * produce un aggiornamento che dice di aver funzionato senza fare
   * niente, o un'immagine nuova che si dichiara vecchia.
   */
  it('la versione dichiarata è il tag dell’immagine', () => {
    const tag = /image:\s*ghcr\.io\/[\w/-]+:([\w.]+)/.exec(compose)?.[1];
    expect(tag).toBeTruthy();
    expect(valore(manifesto, 'version')).toBe(tag);
  });

  /*
   * Le due impostazioni di Redis che sulla VPS erano sbagliate, e che
   * BullMQ segnalava a ogni avvio.
   *
   * `volatile-lru` sfratta le chiavi con scadenza quando la memoria si
   * riempie: fra quelle ci sono le code, e perdere un lavoro in attesa non
   * produce nessun errore. L'AOF acceso su disco lento produceva «fsync is
   * taking too long» a ripetizione, per riguadagnare nel caso peggiore
   * qualche minuto di coda che i lavori periodici ricreano da soli.
   */
  it('Redis non sfratta le code e non scrive l’AOF', () => {
    /*
     * Solo le direttive, senza i commenti.
     *
     * Il compose *spiega* perché non si usa `volatile-lru`, quindi quella
     * stringa nel file c'è: cercarla nel testo intero segnalerebbe come
     * guasto proprio la frase che dice di averlo evitato. Un test che si
     * sbaglia così è un test che qualcuno disattiva.
     */
    const direttive = compose
      .slice(compose.indexOf('command:', compose.indexOf('\n  redis:')))
      .split('\n')
      .map((riga) => riga.trim())
      .filter((riga) => riga.startsWith('- '))
      .map((riga) => riga.slice(2).replace(/^["']|["']$/g, ''));

    // La controprova: senza, una lettura sbagliata farebbe passare tutto.
    expect(direttive, 'nessuna direttiva di Redis letta').toContain('redis-server');

    expect(direttive[direttive.indexOf('--maxmemory-policy') + 1]).toBe('noeviction');
    expect(direttive[direttive.indexOf('--appendonly') + 1]).toBe('no');
  });

  /*
   * I dati passano da `${APP_DATA_DIR}`, che umbrelOS sostituisce con la
   * cartella dell'app. Un percorso assoluto come su ZimaOS funzionerebbe
   * finché qualcuno non sposta i dati, e poi smetterebbe senza dirlo.
   */
  it('i volumi stanno dentro la cartella dei dati dell’app', () => {
    const volumi = [...compose.matchAll(/^\s+- (\S+):(\S+)$/gm)].map((riga) => riga[1]!);
    const bind = volumi.filter((v) => v.startsWith('/') || v.startsWith('$'));

    expect(bind.length).toBeGreaterThan(0);
    expect(bind.every((v) => v.startsWith('${APP_DATA_DIR}'))).toBe(true);
  });
});

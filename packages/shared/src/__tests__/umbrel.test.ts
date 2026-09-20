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
const APP = 'g-d-app-store-gd-angel';

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

  /*
   * `PUBLIC_URL` non sta più nel compose — sta nel file dei segreti, perché
   * è l'indirizzo di quella macchina e un aggiornamento lo riportava a
   * `umbrel.local`, rompendo l'accesso al pannello.
   *
   * Resta però scritto **due volte**: la porta che umbrelOS pubblica, e la
   * porta dentro l'esempio che il compose dà a chi deve compilare il file.
   * Cambiarne una sola significa dare istruzioni sbagliate a chi installa.
   */
  it('la porta è la stessa ovunque', () => {
    const porta = valore(manifesto, 'port');
    expect(porta).toBe('780');
    expect(valore(compose, 'APP_PORT')).toBe(valore(compose, 'API_PORT'));

    const esempio = /PUBLIC_URL=http:\/\/[\w.-]+:(\d+)/.exec(compose)?.[1];
    expect(esempio, "l'esempio di PUBLIC_URL non c'è più nel compose").toBe(porta);
  });

  it('il pannello Twitch è pubblicato sulla porta che dichiara', () => {
    const porta = valore(compose, 'TWITCH_PANEL_PORT');
    expect(porta).toBeTruthy();

    const esempio = /TWITCH_PUBLIC_URL=http:\/\/[\w.-]+:(\d+)/.exec(compose)?.[1];
    expect(esempio, "l'esempio di TWITCH_PUBLIC_URL non c'è più nel compose").toBe(porta);

    // Direttamente e non attraverso app_proxy: quello chiede l'accesso a
    // umbrelOS, e gli streamer un account su quella macchina non ce l'hanno.
    expect(compose).toContain(`"${porta}:${porta}"`);
  });

  /*
   * Nel compose non deve finire niente di sensibile.
   *
   * Non è una raccomandazione: umbrelOS riscrive questo file dal
   * repository a ogni aggiornamento, quindi un valore messo qui va perso —
   * e finché ci sta, sta in chiaro in un file che chiunque abbia accesso
   * alla macchina può leggere. I valori vivono nella cartella dei segreti;
   * qui resta solo dove trovarla.
   */
  it('non contiene valori sensibili', () => {
    const sensibili = [
      'DISCORD_TOKEN',
      'DISCORD_CLIENT_SECRET',
      'SESSION_SECRET',
      'ENCRYPTION_KEY',
      'DATABASE_URL',
      'POSTGRES_PASSWORD',
      'TWITCH_CLIENT_SECRET',
      'TWITCH_BOT_ACCESS_TOKEN',
      'TWITCH_BOT_REFRESH_TOKEN',
    ];

    // Solo le righe vere: negli esempi dentro i commenti quei nomi ci
    // sono, ed è giusto che ci siano.
    const righe = compose.split('\n').filter((riga) => !riga.trim().startsWith('#'));

    // La controprova: senza, una lettura sbagliata non troverebbe niente
    // e il test passerebbe su qualunque file.
    expect(righe.some((riga) => riga.includes('REDIS_URL')), 'nessuna riga letta').toBe(true);

    const trovati = sensibili.filter((nome) =>
      righe.some((riga) => new RegExp(`^\\s*${nome}:`).test(riga)),
    );
    expect(trovati, 'valori sensibili rimasti nel compose').toEqual([]);
  });

  /*
   * La password del database la legge Postgres da un file, ed è l’unico
   * modo che ha questa immagine di riceverla senza che stia scritta nel
   * compose. Il file lo genera ANGEL al primo avvio, nella stessa cartella
   * che Postgres monta in sola lettura.
   */
  it('Postgres prende la password dal file dei segreti', () => {
    expect(valore(compose, 'POSTGRES_PASSWORD_FILE')).toBe('/segreti/postgres_password');
    expect(compose).toContain('${APP_DATA_DIR}/data/segreti:/segreti:ro');
    expect(valore(compose, 'SEGRETI_DIR')).toBe('/segreti');
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

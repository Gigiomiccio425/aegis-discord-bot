# Backup, archivio e trasloco

## Backup, archivio e ruoli

Tre meccanismi distinti, che coprono cose diverse. Vale la pena tenerli separati in testa, perché
promettono cose diverse.

### 1. Struttura del server — `/backup`

Snapshot di ruoli (con permessi e posizione), canali (con gli overwrite), categorie, emoji,
sticker, impostazioni, regole AutoMod e ruoli di ogni membro. Automatico ogni notte, su richiesta,
e **d'emergenza** appena l'anti-nuke rileva qualcosa.

Il ripristino ricrea solo ciò che manca, confrontando per nome: dopo un nuke parziale, ripristinare
alla cieca farebbe più danni dell'attacco. Il pannello mostra l'anteprima prima di agire.

### 2. Ruoli dei membri — riassegnazione automatica

Due percorsi diversi:

- **Dopo un ripristino**: `/backup ripristina ruoli-membri:true` rimette ogni persona al proprio
  posto usando l'elenco salvato nello snapshot.
- **Al rientro di un singolo** (*ruoli appiccicosi*): chi esce e rientra ritrova i ruoli che aveva.
  Oltre alla comodità, chiude il trucco più banale della moderazione — uscire e rientrare per
  liberarsi di un silenziamento o di una quarantena.

In entrambi i casi i ruoli con permessi amministrativi **non** vengono mai riassegnati in
automatico, e nemmeno quelli più alti del ruolo del bot: restituire `ManageRoles` a chi rientra
sarebbe una scalata di privilegi gratuita.

### 3. Messaggi — `/archivio`

Qui va detto chiaramente: **Discord non consente di ripristinare i messaggi eliminati.** Non esiste
alcun endpoint per farlo e nessun bot può aggirarlo. Quello che ANGEL può fare — e fa — è tenere
una copia mentre i messaggi passano, e poi:

- `/archivio esporta` produce una **trascrizione HTML autonoma**: nessun CSS o immagine remota,
  leggibile fra dieci anni, con i messaggi eliminati evidenziati e gli allegati elencati con il loro
  hash. Scaricabile anche dal pannello, dove non scade con la retention del canale.
- `/archivio ricostruisci` **ripubblica** i messaggi archiviati in un canale, tramite webhook.
- `/archivio stato` mostra quanto è stato archiviato, canale per canale.

La ricostruzione è dichiarata come tale e non finge di essere l'originale: un avviso in testa al
canale, il suffisso `(archivio)` sul nome di ogni autore, la data originale nel testo, e gli
allegati non ripubblicati. Una ricostruzione indistinguibile da una cronologia autentica sarebbe uno
strumento per fabbricare prove, non per conservarle.

Quanto viene archiviato dipende da `logging.messageContent`: in modalità `HASHED` o
`METADATA_ONLY` la trascrizione conterrà i metadati ma non il testo. È un compromesso deliberato fra
capacità investigativa e privacy, e va scelto consapevolmente.

### 4. L'installazione intera — copia automatica

I tre meccanismi qui sopra proteggono il *server Discord*. Questo protegge **ANGEL**: se domani il
disco della VPS non si accende più, è l'unica cosa che riporta indietro anni di registro,
configurazione, provvedimenti e trascrizioni.

Ogni notte alle **4:15**, e subito dopo ogni aggiornamento di versione, il worker esporta tutto in
una cartella dentro `BACKUP_DIR` — che nel compose predefinito è `/DATA/angel-backup`, cioè una
cartella dell'host **fuori** dai volumi Docker. Non è un dettaglio: disinstallando l'app da ZimaOS i
volumi possono sparire, e una copia che sparisce insieme a ciò che protegge non protegge nulla.

```
/DATA/angel-backup/angel-2026-08-31T04-15-00/
  MANIFESTO.json     leggibile senza estrarre nulla: cosa c'è, quante righe, quale versione
  ISTRUZIONI.md      come rileggerla, per chi la ritrova fra un anno
  dati.tar.gz        tabelle/<tabella>.ndjson — una riga JSON per record
  archivio.tar.gz    allegati archiviati e trascrizioni dei ticket
```

Il formato è NDJSON e non un dump binario di Postgres: un dump si rilegge solo con la stessa
versione di Postgres, e fra due anni quella versione sarà un problema in più proprio nel momento
peggiore. Qui bastano `tar` e `grep`.

```bash
# Cosa c'è dentro, senza ripristinare nulla
tar tzf dati.tar.gz
tar xzf dati.tar.gz -O tabelle/auditEvent.ndjson | wc -l
```

Nel pannello, in **Backup**, la sezione «Copia completa dell'installazione» elenca le copie
presenti, ne crea una fuori orario e — la cosa che conta — **le scarica**. Una copia che vive solo
sul server di cui è la copia protegge da un volume cancellato per sbaglio e da nient'altro: non dal
disco che muore, non dalla macchina che non si accende più. La sezione è visibile solo a chi è in
`OWNER_IDS`, perché contiene i dati di *tutti* i server dove il bot è presente.

Variabili che la governano:

| Variabile | Predefinito | Cosa fa |
|---|---|---|
| `BACKUP_DIR` | `/backup` | Dove finiscono le copie. Deve stare su un volume diverso dall'applicazione |
| `BACKUP_KEEP` | `14` | Quante tenerne. Le più vecchie vengono rimosse |
| `BACKUP_INCLUDE_STORAGE` | `true` | Include allegati e trascrizioni |
| `BACKUP_STORAGE_MAX_MB` | `4096` | Oltre questa soglia l'archivio dei file viene **escluso**, non troncato, e il motivo finisce nel manifesto |

Se lo spazio libero in `BACKUP_DIR` scende sotto i 300 MB la copia non parte e lo dice: una copia
interrotta a metà per disco pieno lascia una cartella che *sembra* valida.

### 5. La copia leggera — su Discord

La copia automatica vive sulla macchina. Se muore la macchina, e la copia non l'avevi scaricata,
muore con lei. La copia leggera sta **su Discord**, che la macchina non la condivide.

Ogni notte, subito dopo la copia su disco, il bot pubblica in un canale un file con quello che
costa ore rifare a mano: la configurazione di ANGEL, i comandi personalizzati, le parole vietate,
i domini ammessi, chi è sorvegliato — e l'elenco di ruoli e canali. Non i messaggi, non il
registro, non gli allegati: per quelli c'è la copia completa. Questa è quella che sopravvive.

| | |
|---|---|
| **Si accende** | Dal pannello, *Generale* → «Copia leggera su Discord», scegliendo il canale. Parte spenta |
| **Il canale** | Uno che leggono solo gli amministratori: il file descrive come è fatto il server |
| **Subito** | Dal pannello, *Backup* → «Pubblica adesso», oppure `/copia-leggera adesso`. Se è spenta o manca il canale, te lo dice |
| **Rimetterla** | `/copia-leggera rimetti` dall'ultima pubblicata; con `messaggio:` da una precedente |

**Cosa rimette, e cosa no.** Rimette la configurazione, i comandi, le parole e gli elenchi. Ruoli e
canali cancellati **non** li ricrea: stanno nel file per riconoscerli e rifarli, e perché i loro
identificativi dicono cosa puntava a cosa. E accetta solo file pubblicati da ANGEL: rimettere una
configurazione è come cambiarla, e un file arrivato da qualcun altro potrebbe spegnere le difese.

Il file è Markdown, e si legge anche a occhio: in cima ci sono data, versione di ANGEL e formato,
poi un riassunto di cosa contiene. Se una notte il bot non è in ascolto quando il worker la
chiede, quella copia salta e nei log del worker c'è una riga che lo dice; la notte dopo si
riprova.

---
### Con il backup automatico

Se vuoi che una copia del database venga fatta **prima** di ogni aggiornamento — e conviene, perché
una migrazione non si annulla:

```bash
curl -O https://raw.githubusercontent.com/Gigiomiccio425/aegis-discord-bot/main/docker/aggiorna.sh
sudo sh aggiorna.sh docker-compose.yml 1.31.7
```

Lo script copia il database, imposta la versione indicata, scarica l'immagine e ricrea tutto. La
copia finisce in `/DATA/aegis-backup`, ne tiene le ultime dieci, e se il dump risulta vuoto si
ferma senza aggiornare.

Il database lo cerca fra i container che hanno nel nome sia `postgres` sia `angel` o `aegis`. Se ne
trova più d'uno — ANGEL e la copia d'emergenza accese insieme — si ferma e li elenca: indica quello
giusto con `PG_CONTAINER=nome`. Prima prendeva il primo della lista, che su una macchina con altre
app poteva essere il loro.

A mano, se preferisci:

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

---

### Backup del database

```bash
docker compose exec postgres pg_dump -U aegis aegis | gzip > aegis-$(date +%F).sql.gz
```

Vale la pena metterlo in cron: gli snapshot del server Discord vivono dentro Postgres, quindi
perdere il database significa perdere anche i backup della struttura del server.

---
## Traslocare su un'altra macchina

Due strade. Fanno la stessa cosa e si coprono a vicenda; la differenza è se hai accesso al
terminale della macchina vecchia.

### Strada A — `trasloco.sh` (consigliata quando hai SSH)

Un `pg_dump`, cioè una copia **esatta** del database con sequenze, indici e vincoli. È la strada
giusta per un trasloco, dove non serve leggibilità fra dieci anni ma fedeltà fra dieci minuti.

Sulla macchina vecchia:

```bash
sudo sh docker/trasloco.sh esporta /DATA/trasloco
```

Produce una cartella con il database, i file archiviati, l'ultima copia notturna come rete di
sicurezza, e `ambiente.txt` con i segreti — **compresa `ENCRYPTION_KEY`, senza la quale metà dei
dati resterebbe illeggibile.** Quel file ha i permessi `600` e va cancellato appena finito.

Copiala sulla macchina nuova:

```bash
scp -r utente@vecchia:/DATA/trasloco/angel-trasloco-* ./
```

Sulla macchina nuova: installa ANGEL con lo stesso compose, riportando i valori di `ambiente.txt` —
`ENCRYPTION_KEY` identica, `PUBLIC_URL` invece cambia — fallo partire **una volta** perché crei le
tabelle, poi:

```bash
sudo sh docker/trasloco.sh importa ./angel-trasloco-20260831-041500
```

Chiede conferma due volte, ferma il bot, sostituisce il database, rimette i file, riaccende.

**Quale database tocca.** Solo un container con nel nome sia `postgres` sia `angel` o `aegis`, e
solo se è uno. Se sono più d'uno si ferma e li elenca: scegli con `PG_CONTAINER=nome`, e per il
bot con `ANGEL_CONTAINER=nome`. Prima prendeva «il primo che contiene postgres», e su un Umbrel con
Immich o Nextcloud poteva essere il loro: `importa` ci avrebbe fatto `DROP SCHEMA`.

### Strada B — il kit di trasloco, dal pannello

Nel pannello, **Backup → Copia completa → «Prepara il trasloco»**. Produce una cartella
`trasloco-<data>` dentro `BACKUP_DIR` con dentro i dati **e** un `TRASLOCO.txt` che è il pezzo che
mancava: i dati da soli non fanno ripartire nulla, servono anche i valori — e quei valori stanno nel
compose della macchina che stai per spegnere.

`TRASLOCO.txt` contiene, in ordine:

1. **cosa c'è nella cartella**, con le impronte SHA-256 dei due archivi — un file arrivato troncato
   si estrae comunque per buona parte, e il ripristino sembra riuscito con qualche tabella in meno;
2. **cosa devi ritrovare dopo**: l'elenco dei server con id, nome e numero di membri, e le righe per
   tabella. È la lista di controllo — se il pannello nuovo mostra numeri diversi, il trasloco è
   andato a metà;
3. **i valori da riportare**, raggruppati per cosa succede se li sbagli: quelli che devono essere
   identici, quelli il cui errore si vede subito, quelli che cambiano con la macchina;
4. **il blocco YAML pronto da incollare** sotto `environment:`, `POSTGRES_PASSWORD` compresa —
   che è lo stesso valore dentro `DATABASE_URL`, scritto in due punti che devono coincidere;
5. **la procedura passo per passo**, 6. **le verifiche finali**, 7. **cosa fare se si ferma**.

Il file nasce con permessi `600` e **contiene i segreti in chiaro**: token del bot, chiave di
cifratura, password del database. È deliberato — un kit che elenca solo i nomi costringe ad andare a
cercare i valori, cioè esattamente il passaggio che fallisce quando la macchina vecchia non risponde
più. Se preferisci, il pannello offre anche **«Senza segreti»**: al posto dei valori restano le
impronte, che bastano a verificare di aver riportato quello giusto ma non a ricostruirlo.

Il kit non è programmato e non gira di notte: scrivere segreti su disco è una decisione, e le
decisioni si prendono una volta. Ne vengono tenuti gli ultimi due, e il pannello ha un pulsante
**Elimina** — usalo appena il trasloco è finito.

Poi:

1. Copia la cartella `trasloco-<data>` intera in `/DATA/angel-backup` sulla macchina nuova.
2. Installa ANGEL con i valori del punto 3, cambiando `PUBLIC_URL`, e fallo partire una volta.
3. Nel compose, nel blocco `environment:` di `angel`:

   ```yaml
   RESTORE_FROM: /backup/trasloco-2026-08-31T22-40-00
   ```

4. Riavvia l'app, poi togli quella riga ed elimina il kit.

Se non hai modo di copiare la cartella, ogni pezzo si scarica singolarmente dallo stesso elenco —
in quel caso rimettili in una cartella dal nome uguale, con i nomi originali (`dati.tar.gz`,
`archivio.tar.gz`, `MANIFESTO.json`), togliendo il prefisso che il browser aggiunge.

Il ripristino avviene **prima** che il bot si colleghi — un bot già connesso mentre il database gli
cambia sotto reagirebbe a eventi con metà dei dati vecchi e metà nuovi — e lascia un file
`RIPRISTINATO` dentro la cartella perché non si ripeta a ogni riavvio.

Passa da una variabile d'ambiente e non da `docker exec` perché su ZimaOS l'exec dentro i container
viene rifiutato con «permission denied»: un ripristino che si può fare solo con `exec`, su quella
macchina, non si può fare. Dove `exec` funziona c'è anche il comando diretto:

```bash
node apps/worker/dist/ripristina.js /backup/trasloco-2026-08-31T22-40-00
```

### Le tre cose che vanno storte

**La chiave di cifratura.** I token delle integrazioni sono cifrati nel database con
`ENCRYPTION_KEY`. Con una chiave diversa il ripristino riesce e sembra perfetto: tutte le righe
tornano, i conteggi combaciano, il pannello si apre. Poi Twitch e YouTube smettono di funzionare, e
niente collega la causa all'effetto. Per questo la copia porta con sé un'**impronta** della chiave
(SHA-256 troncato, non la chiave) e il ripristino si ferma se non combacia. Si forza con
`RESTORE_ACCEPT_KEY_MISMATCH=1`, sapendo che le integrazioni andranno riconfigurate a mano.

**Il database non vuoto.** Su un'installazione che contiene già qualcosa il ripristino si ferma,
per non mescolare due installazioni. Serve `RESTORE_OVERWRITE=1`, che **svuota le tabelle** prima
di riempirle.

**Due bot con lo stesso token.** Spegni ANGEL sulla macchina vecchia *prima* di accenderlo sulla
nuova. Due processi collegati allo stesso token si contendono il gateway: Discord ne fa cadere uno
di continuo, e ogni sanzione rischia di essere applicata due volte.

Da controllare a trasloco finito, in quest'ordine: il pannello mostra i server di prima; il registro
contiene eventi vecchi di giorni e non solo di adesso; un ticket chiuso tempo fa ha ancora la sua
trascrizione; le integrazioni funzionano. Poi aggiungi il nuovo `PUBLIC_URL` ai redirect OAuth2 nel
Developer Portal, altrimenti l'accesso al pannello fallisce con «stato non valido».


---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

# Il pannello di controllo

## Il pannello

Si apre da `PUBLIC_URL` dopo l'accesso con Discord. Le pagine stanno nella barra laterale divise in
quattro gruppi, per quello che servono a fare:

| Gruppo | Pagina | Cosa contiene |
|---|---|---|
| Panoramica | **Dashboard** | Minacce di oggi, grafico degli ingressi per ora, feed live via WebSocket, incidenti recenti con riabilitazione di massa, azioni rapide (lockdown, backup) |
| | **Registro eventi** | Ricerca e filtri su tutti gli eventi, paginazione a cursore, dettaglio JSON di ogni riga; ogni autore è un link alla sua scheda |
| Moderazione | **Provvedimenti** | Casi con filtro per stato, revoca, e **appelli in attesa** con accoglimento che revoca davvero la sanzione |
| | **Sicurezza** | Inventario webhook e bot con punteggio di rischio, account a rischio, codici invito dirottabili, gestione delle firme di minaccia |
| | **Archivio messaggi** | Quanto è archiviato per canale, download delle trascrizioni HTML |
| | **Ticket e trascrizioni** | Elenco dei ticket con chi li ha presi in carico, chi li ha chiusi e perché; trascrizione completa di ognuno, letta dal file salvato sul server o ricostruita dall'archivio |
| Comunità | **Annunci** | Dirette Twitch, video YouTube e feed RSS in un elenco solo: una riga per fonte, con canale, menzione, messaggio, prova d'invio e sospensione |
| | **Integrazioni** | Sondaggi con risultati in tempo reale, giveaway, menu dei ruoli |
| | **Comandi e personas** | Builder delle sequenze e gestione delle personas |
| Sistema | **Configurazione** | Tutti i moduli, divisi per quello che proteggono, con **storico delle modifiche con ripristino** e gestione delle proprie sessioni attive |
| | **Backup** | Elenco snapshot con anteprima del diff prima del ripristino, copia leggera su Discord |
| | **Strumenti** | Preparazione del server, rientro dal nodo di emergenza, messaggi a nome del bot, utenti sorvegliati, elenco dei comandi |
| | **Accessi al pannello** | Chi può entrare e con quale livello, con revoca che chiude anche le sessioni aperte |

La **scheda utente** — profilo, rischio, provvedimenti, tempo in vocale e cronologia completa — si
apre dal nome di chiunque compaia nel registro o nei provvedimenti.

In cima a ogni pagina c'è il percorso (server › gruppo › pagina), la ricerca e il tema. Sul telefono
la barra laterale diventa un menu che si apre dal pulsante in alto a sinistra.

I permessi del pannello sono **separati** da quelli Discord: `MANAGE_GUILD` è la condizione minima
per entrare, ma cosa si può fare dentro lo decide il ruolo assegnato (Owner / Admin / Mod / Viewer).
Amministrare un server non implica il diritto di scaricare l'archivio di tutte le conversazioni.

### Trovare un'impostazione

**Ctrl K** (⌘K sul Mac), oppure **/** fuori da un campo di testo, apre la ricerca da qualunque
pagina. Cerca fra le pagine, le sezioni della configurazione e ogni singola impostazione, con le
stesse parole che la pagina mostra: il nome, la spiegazione sotto il controllo, il gruppo in cui
sta. Accenti e maiuscole non contano.

Per le impostazioni il risultato mostra anche il valore attuale — *attivo*, *spento*, *30*,
*Mettere in quarantena* — così spesso la risposta è già lì. Scelta un'impostazione, la
configurazione si apre su quel modulo, nella scheda giusta, apre i gruppi chiusi che la
contengono, porta il campo al centro dello schermo e lo illumina per qualche secondo, con il cursore
già dentro.

Se nessuna voce contiene tutte le parole scritte, la ricerca mostra quelle che ne contengono almeno
metà e lo dice, invece di lasciare l'elenco vuoto.

L'indirizzo della configurazione porta la sezione e il campo (`?sezione=security.antiRaid&campo=…`):
si può incollare in chat per mandare un altro moderatore esattamente su quell'opzione.

### La configurazione

**La panoramica.** La configurazione si apre su una pagina sola che dice com'è messo il server:

- in cima lo stato della protezione — *attiva*, *spenta* o *in modalità prova* — con i due
  interruttori che valgono per tutti i moduli, e il passaggio alle impostazioni generali (staff,
  lingua, avvisi in chat, identità del bot);
- i **controlli di coerenza**, chiusi: dicono solo in quali moduli c'è qualcosa da sistemare, e un
  clic porta lì;
- i moduli divisi in sei categorie — *Protezione dagli attacchi*, *Controllo dei messaggi*,
  *Ingresso e membri*, *Registro eventi*, *Comunità*, *Notifiche esterne* — ognuno su una riga con
  cosa fa e il suo interruttore. Accendere o spegnere un modulo non richiede di aprirlo.

**La pagina di un modulo.** Si apre dalla sua riga. In cima c'è la strada per tornare alla
panoramica e gli altri moduli della stessa categoria, per passare dall'uno all'altro con un clic.
Poi cosa fa il modulo, l'interruttore che lo accende e, se c'è qualcosa che non va, il problema con
il pulsante **Sistema**, che porta dritto al campo da correggere.

Le opzioni sono divise in **schede**: *Principali* e una scheda per ogni gruppo grande — *Regole per
azione*, *Esenzioni*, *Gruppi di account simili*. I gruppi piccoli restano fra le principali, su una
riga sola: «Troppi messaggi — 6 in 5 secondi». Nelle schede:

- ogni opzione è una riga: nome e spiegazione a sinistra, interruttore o valore a destra;
- i campi a scelta fissa — il livello di risposta, cosa fare a chi supera una soglia — sono tendine
  con i nomi in italiano, non caselle dove indovinare la parola giusta;
- i gruppi annidati, come le singole regole dell'anti-nuke, sono chiusi e dicono già nel titolo se
  sono attivi.

Finché ci sono modifiche non salvate, in basso resta una barra con «Salva» e «Annulla modifiche»,
su ogni pagina, e chiudere la scheda del browser chiede conferma.

### Temi

Il pulsante con la tavolozza, in alto a destra, apre venti temi: dodici scuri e otto chiari, più
**Automatico**, che segue la modalità chiara o scura del sistema. Ognuno si vede in miniatura con i
suoi colori prima di sceglierlo.

Il tema è una preferenza di chi guarda, non del server: resta salvato in quel browser, e due
moderatori dello stesso server possono usarne due diversi. Tutti i temi passano un test di
contrasto (WCAG, 4.5:1 per il testo): un tema bello che si legge male non entra.

### Configurare senza incollare ID

Canali e ruoli si scelgono da una tendina, con il loro nome e la categoria che li contiene. Il
pannello non è connesso a Discord — una sola connessione al gateway è una scelta, non una mancanza —
quindi l'elenco lo scrive il bot in Redis e il pannello lo rilegge. Se non c'è ancora, i campi
tornano a chiedere l'ID a mano invece di bloccare il lavoro.

Non è solo comodità: un ID incollato male **non dà errore**, punta a un altro canale, e ce se ne
accorge il giorno in cui l'avviso non arriva dove doveva.

Gli elenchi di oggetti — streamer seguiti, canali YouTube, feed, scale d'azione — sono schede, una
per elemento, con «Aggiungi» che parte da uno scheletro già compilato con i valori predefiniti. Il
JSON resta disponibile richiuso, per copiare una configurazione da un server all'altro.

Dove si scrive un messaggio — l'annuncio di una diretta, la voce del bot — `#` e `@` aprono
l'elenco di canali e ruoli, come nel client di Discord: si sceglie il nome e viene inserito l'ID
nella forma che Discord si aspetta. Accanto, i segnaposto come `{titolo}` si inseriscono da un
elenco invece di andarli a cercare nella documentazione.

### Annunci

Le fonti stanno in una pagina sola invece che sparse in tre sezioni della configurazione: sono la
cosa che si tocca più spesso, e la sola che non riguarda la sicurezza — aggiungere uno streamer non
deve costringere a passare davanti alle impostazioni dell'anti-nuke.

Ogni voce ha il suo canale, il suo messaggio e il suo ruolo da menzionare, più:

- **Prova**, che pubblica il messaggio con valori d'esempio. È l'unico modo di sapere prima se il
  testo viene come si pensava, se il bot può scrivere in quel canale e se la menzione funziona;
  scoprirlo alla prima diretta vera significa scoprirlo davanti a tutti.
- **Sospendi**, che zittisce una voce senza cancellarla — per lo streamer fermo un mese o il feed
  troppo rumoroso in un certo periodo.
- Anteprima del messaggio con i segnaposto già sostituiti, mentre lo si scrive.

**Il ruolo «in diretta»** vuole due cose, non una: il ruolo *e* chi è quello streamer su Discord.
Twitch e Discord non hanno niente in comune — il bot sa che `twitch.tv/tizio` sta trasmettendo, non
chi sia quella persona nel server. Si cerca per nome fra chi il bot ha già visto, oppure si incolla
l'ID. Il ruolo arriva all'inizio della diretta e viene tolto alla fine; se il ruolo è impostato e la
persona no, il pannello lo dice invece di lasciare una funzione che non parte mai.


---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

# Il pannello di controllo

## Il pannello

Otto sezioni, raggiungibili da `PUBLIC_URL` dopo l'accesso con Discord:

| Sezione | Cosa contiene |
|---|---|
| **Dashboard** | Minacce bloccate, grafico degli ingressi per ora, feed live via WebSocket, incidenti recenti con riabilitazione di massa, azioni rapide (lockdown, backup) |
| **Registro eventi** | Ricerca e filtri su tutti gli eventi, paginazione a cursore, dettaglio JSON di ogni riga; ogni autore è un link alla sua scheda |
| **Scheda utente** | Profilo, rischio, provvedimenti, tempo in vocale e cronologia completa in una pagina, con il contenuto dei messaggi archiviati |
| **Provvedimenti** | Casi con filtro per stato, revoca, e **appelli in attesa** con accoglimento che revoca davvero la sanzione |
| **Sicurezza** | Inventario webhook e bot con punteggio di rischio, account a rischio, codici invito dirottabili, gestione delle firme di minaccia |
| **Backup** | Elenco snapshot con anteprima del diff prima del ripristino |
| **Archivio messaggi** | Quanto è archiviato per canale, download delle trascrizioni HTML |
| **Ticket e trascrizioni** | Elenco dei ticket con chi li ha presi in carico, chi li ha chiusi e perché; trascrizione completa di ognuno, letta dal file salvato sul server o ricostruita dall'archivio |
| **Annunci** | Dirette Twitch, video YouTube e feed RSS in un elenco solo: una riga per fonte, con canale, menzione, messaggio, prova d'invio e sospensione |
| **Integrazioni** | Sondaggi con risultati in tempo reale, giveaway, menu dei ruoli |
| **Comandi e personas** | Builder delle sequenze e gestione delle personas |
| **Configurazione** | Tutti i moduli, con editor generato dagli schemi condivisi, **storico delle modifiche con ripristino** e gestione delle proprie sessioni attive |
| **Accessi al pannello** | Chi può entrare e con quale livello, con revoca che chiude anche le sessioni aperte |

I permessi del pannello sono **separati** da quelli Discord: `MANAGE_GUILD` è la condizione minima
per entrare, ma cosa si può fare dentro lo decide il ruolo assegnato (Owner / Admin / Mod / Viewer).
Amministrare un server non implica il diritto di scaricare l'archivio di tutte le conversazioni.

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

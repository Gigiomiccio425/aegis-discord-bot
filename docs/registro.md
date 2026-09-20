# Il registro

## Il registro

**140 tipi di evento**, tutti effettivamente emessi — un test di build lo verifica scandendo il
codice sorgente, così un tipo dichiarato non può restare muto e trasformarsi in un filtro
perennemente vuoto nel pannello.

| Categoria | Cosa viene registrato |
|---|---|
| **Messaggi** | Invio, modifica (con prima/dopo), eliminazione singola e di massa, fissaggio e rimozione dai fissati, allegati con nome e dimensione, voti nei sondaggi nativi di Discord |
| **Reazioni** | Aggiunta, rimozione, azzeramento |
| **Membri** | Ingresso e uscita, ban e revoche, espulsioni (anche quelle fatte dall'interfaccia Discord), nickname, **username e nome visualizzato**, **avatar globale e avatar specifico del server**, ruoli assegnati e rimossi uno per uno, silenziamenti, inizio e fine dei boost |
| **Voce** | Entrata, uscita, spostamento, microfono e cuffie (distinguendo la scelta dell'utente dall'imposizione del server), condivisione schermo, webcam, e un **riepilogo di fine sessione** con la durata effettiva |
| **Canali e thread** | Creazione, eliminazione, modifiche, permessi; thread creati, rinominati, bloccati, archiviati e riaperti, con entrate e uscite dei partecipanti |
| **Ruoli** | Creazione, eliminazione, modifiche, ed evidenza separata quando vengono **aggiunti permessi pericolosi** |
| **Server** | Impostazioni, emoji e sticker (creazione, rinomina, rimozione), eventi programmati con iscrizioni e disiscrizioni, stage |
| **Inviti** | Creazione, eliminazione, **quale invito ha usato chi entra**, inviti pubblicati in chat, codici a rischio dirottamento |
| **Webhook** | Creazione, **rinomina o spostamento**, eliminazione, webhook non autorizzati |
| **Moderazione** | Ogni provvedimento con il suo caso, note, pulizie, appelli aperti e decisi |
| **Sicurezza** | Raid, nuke, lockdown, quarantene, account compromessi, ogni tipo di contenuto bloccato |
| **Bot e pannello** | Comandi usati, comandi personalizzati, messaggi delle personas (con l'autore umano reale), modifiche alla configurazione, **accessi al pannello con IP**, cancellazioni GDPR |

Cosa **non** viene registrato, per scelta: `typingStart` e `presenceUpdate`. Sono decine di eventi
al minuto per membro, riempirebbero il database senza rispondere a nessuna domanda che qualcuno si
ponga davvero.

### Tre destinazioni, non una

| Destinazione | A cosa serve |
|---|---|
| **Postgres** | Ricerca e filtri del pannello, statistiche, timeline utente. Ha bisogno degli indici, quindi conviene tenerlo leggero |
| **Canali Discord** | Sorveglianza quotidiana. Gli eventi ad alta frequenza vengono accorpati (fino a 10 per messaggio); quelli critici saltano la coda |
| **File su disco** | Archivio a lungo termine. Append-only, rotazione giornaliera, `grep`-abile |

Il sink su file risolve un problema che il database non risolve bene. Con i file si può tenere
Postgres a qualche mese di retention — query veloci, backup piccoli — e conservare comunque **tutto
per anni** su disco, dove costa solo spazio. Un `grep` trova una riga di due anni fa senza che il
database si porti dietro quelle righe a ogni query.

```
storage/logs/<idServer>/2026-08-10/SECURITY.txt
storage/logs/<idServer>/2026-08-10/SECURITY.jsonl
```

TXT è leggibile a occhio e con `grep`; JSONL è analizzabile con `jq` o reimportabile. Con spazio
abbondante si tengono entrambi: sono la stessa informazione in due forme, e la scelta sbagliata si
paga anni dopo. La retention dei file è **separata** da quella del database, e `0` significa «per
sempre» — che è il valore sensato quando lo spazio non è il vincolo.

```bash
# Tutti gli eventi di sicurezza di agosto
grep -h "SECURITY_" storage/logs/*/2026-08-*/*.txt

# Cosa ha fatto un utente, in ordine
grep -rh "autore=.*(123456789012345678)" storage/logs/<idServer>/ | sort

# Con jq: i dieci eventi più gravi della settimana
cat storage/logs/<idServer>/2026-08-*/*.jsonl | jq -s 'sort_by(-.severity) | .[:10]'
```

Le scritture sono bufferizzate e svuotate a intervalli: una syscall per evento, su un server
attivo, sarebbe spreco puro. In caso di arresto improvviso si perdono al massimo gli ultimi
secondi, che sono comunque nel database.

Due note sul funzionamento:

- Alcune azioni **esistono solo nel registro di controllo** di Discord — fissare un messaggio,
  espellere qualcuno dall'interfaccia, eliminare un webhook. Il gateway non le riporta affatto, o le
  riporta senza dire chi le ha fatte. Senza il permesso `ViewAuditLog` quelle righe non compaiono.
- Gli eventi ad alta frequenza vengono accorpati prima di finire nel canale Discord (fino a 10 per
  messaggio), mentre nel database restano riga per riga. Gli eventi critici saltano la coda: durante
  un nuke i secondi contano.


---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

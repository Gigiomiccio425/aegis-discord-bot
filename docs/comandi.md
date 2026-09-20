# Comandi

## Comandi

**I comandi hanno anche il nome inglese.** `/ban`, `/kick`, `/mute`, `/warn`, `/purge`, `/whois`,
`/report`, `/setup`, `/words`, `/status`, `/say` fanno esattamente quello che fanno `/bandisci`,
`/espelli`, `/silenzia`, `/avverti`, `/pulisci`, `/utente`, `/segnala`, `/prepara-server`, `/ripara-ruoli`,
`/parole`, `/stato`, `/dì`. Non è una copia del comando: è lo stesso, registrato con due nomi, così
il giorno in cui uno cambia comportamento cambiano entrambi.

| Comando | Chi può usarlo | Cosa fa |
|---|---|---|
| `/ping` | tutti | Latenza e versioni |
| `/salute` · `/health` | tutti | Dice quale pezzo non funziona: database, Redis, disco, versione |
| `/segnala` · `/report` | tutti | Segnala una persona allo staff: arriva nel canale riservato con i pulsanti per intervenire |
| `/azioni` · `/actions` | Modera membri | Pulsanti rapidi su una persona: silenzia, quarantena, espelli, bandisci |
| `/stato` | Gestisci server | Stato dei moduli e problemi da sistemare |
| `/pannello` | Gestisci server | Link al pannello |
| `/verifica-staff parola:` | tutti | Verifica se chi ti ha contattato è davvero dello staff |
| `/privacy` | tutti | Cosa registra il bot e per quanto |
| `/cancella-i-miei-dati` | tutti | Cancellazione dei propri dati (GDPR art. 17) |
| `/nota` | Modera membri | Annota un membro senza sanzionarlo, resta nella sua scheda |
| `/avverti` `/silenzia` `/rimuovi-silenzio` | Modera membri | Provvedimenti con apertura del caso |
| `/espelli` | Espelli membri | Espulsione con avviso in privato prima dell'esecuzione |
| `/bandisci` | Bandisci membri | Ban anche per ID di chi ha già lasciato · supporta ban **temporanei** (`durata: 7d`) |
| `/revoca-ban` | Bandisci membri | Revoca e chiude il caso corrispondente |
| `/pulisci` | Gestisci messaggi | Elimina messaggi recenti, con o senza filtro per utente |
| `/quarantena applica\|revoca` | Modera membri | Isola conservando i ruoli, oppure li restituisce |
| `/utente` | Modera membri | Scheda completa: rischio, storico, provvedimenti |
| `/appello invia\|miei` | tutti | Contesta un provvedimento che ti riguarda |
| `/appello elenca\|risolvi\|registra` | Modera membri | Gestione degli appelli ricevuti |
| `/scansiona contenuto:` | tutti | Analizza un link o un testo senza aprirlo |
| `/verifica pubblica\|stato` | Gestisci server | Pubblica il messaggio col pulsante di verifica |
| `/lockdown attiva\|revoca\|stato` | Gestisci server | Canali in sola lettura e inviti in pausa |
| `/panico motivo:` | Gestisci server | Blocca, salva un backup e avvisa lo staff |
| `/backup crea\|lista\|ripristina` | Amministratore | Backup della struttura del server |
| `/archivio esporta\|stato\|ricostruisci` | Gestisci messaggi | Trascrizioni HTML e ricostruzione dei messaggi |
| `/audit` | Gestisci server | Revisione di webhook, bot e inviti sorvegliati |
| `/evento crea\|lista\|annulla` | configurabile | Eventi programmati con promemoria e ruolo RSVP |
| `/sondaggio crea\|chiudi\|lista` | configurabile | Sondaggi persistenti, anche anonimi |
| `/giveaway crea\|estrai\|riestrai` | Gestisci messaggi | Giveaway con requisiti d'ingresso |
| `/ruoli-menu` | Gestisci ruoli | Menu di auto-assegnazione dei ruoli |
| `/ticket pannello\|chiudi\|aggiungi\|lista` | configurabile | Assistenza privata in canali dedicati |
| `/diagnostica` | proprietari del bot | Stato tecnico |

I ban temporanei vengono revocati davvero: un lavoro periodico controlla le scadenze ogni notte e
toglie il ban. Sondaggi, giveaway e promemoria degli eventi hanno invece un controllo al minuto —
un giveaway che dichiara «termina fra 24 ore» e si chiude con mezz'ora di ritardo è una promessa
non mantenuta.

Accogliere un appello **revoca davvero** il provvedimento (ban rimosso, silenziamento tolto,
quarantena revocata con ripristino dei ruoli), sia dal comando sia dal pannello. Un appello che
cambia solo lo stato nel registro sarebbe una formalità.

Limite dichiarato sugli appelli: chi è **bandito** non è più nel server e non può usare un comando
slash. Il suo appello deve arrivare per altra via e viene registrato dallo staff con
`/appello registra`.

---

## Comandi personalizzati e personas

Dal pannello si compongono sequenze del tipo: *questa persona dice questo, tre secondi dopo
quest'altra risponde, poi al destinatario viene assegnato un ruolo*. La sequenza diventa un comando
slash vero, utilizzabile solo da chi ha i ruoli indicati.

Il «finto utente» con nome e immagine propri è un **webhook** — è l'unico modo che Discord offre.
ANGEL crea e riusa un webhook per canale, e lo registra automaticamente nella allowlist del modulo
di protezione webhook, così non viene eliminato da sé stesso.

Variabili disponibili nei testi: `{user}`, `{user.name}`, `{arg:nome}`, `{guild}`, `{channel}`,
`{count}`, `{random:a|b|c}`.

Tre vincoli, non aggirabili dal pannello:

- Una persona **non può** chiamarsi come Discord, lo staff, il supporto o un moderatore, né avere un
  nome troppo simile ai nickname reali dello staff. Sarebbe uno strumento di truffa confezionato.
- Ogni messaggio inviato da una persona resta registrato con l'ID dell'utente umano che ha lanciato
  il comando. Una persona non è mai anonimato.
- I ruoli con permessi amministrativi non sono assegnabili da un comando personalizzato: sarebbe una
  scalata di privilegi a disposizione di chiunque possa lanciarlo.


---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

# Diario delle versioni

Le date sono quelle di pubblicazione dell'immagine. Solo le versioni che cambiano qualcosa per chi
lo usa: le correzioni interne stanno nella cronologia git.

## 1.32.0 — 23 settembre 2026

- **Il pannello è riorganizzato.** Le pagine stanno in quattro gruppi — Panoramica, Moderazione,
  Comunità, Sistema — con un'icona ciascuna. In cima a ogni pagina c'è dove ci si trova, la
  ricerca e il tema; sul telefono il menu si apre dal pulsante in alto.
- **La configurazione si apre su una panoramica**: lo stato della protezione in cima, i moduli da
  sistemare, e tutti i moduli in sei categorie, ognuno con il suo interruttore. Il menù di
  ventisette voci da scorrere non c'è più.
- **Ogni modulo ha la sua pagina, divisa in schede**, con gli altri moduli della stessa categoria a
  un clic e un pulsante «Sistema» accanto a ogni problema. Le soglie stanno su una riga sola, i
  campi a scelta fissa sono tendine con i nomi in italiano, e una barra in basso ricorda le
  modifiche non salvate.
- **Ricerca in tutto il pannello**, con Ctrl K (⌘K sul Mac) o «/»: pagine, moduli e ogni singola
  impostazione, con il valore attuale. Scelta un'impostazione, il pannello porta dritto al campo.
- **Venti temi**, dodici scuri e otto chiari, più «Automatico» che segue il sistema. Il tema vale
  per il browser di chi guarda: ogni moderatore tiene il suo.
- I gruppi di opzioni che comparivano con il nome tecnico — «Join burst», «Exemptions» — hanno un
  nome italiano.

## 1.31.8 — 23 settembre 2026

- **La copia leggera si pubblica dal pannello**, in Backup → «Pubblica adesso». Se è spenta o
  manca il canale, lo dice.
- **Il primo avvio dopo un aggiornamento non salta più la copia.** ANGEL arrivava alla cartella
  dei backup prima che il container dei permessi la sistemasse; ora aspetta qualche secondo.
- **Il consiglio in caso di cartella non scrivibile non ferma più Postgres**: indica solo la
  cartella dei backup, non tutta quella dei dati.

## 1.31.7 — 22 settembre 2026

- **I backup notturni tornano a essere scritti.** La cartella dei backup la creava Docker con
  proprietario root, e ANGEL non ci poteva scrivere: «cartella di backup non disponibile
  (EACCES)» all'avvio, e ogni notte nessun backup su disco. Ora il container che sistema i
  permessi se ne occupa da solo, per i backup e per gli allegati.

## 1.31.6 — 22 settembre 2026

- **Il backup notturno si dichiara notturno.** Veniva registrato come «creato dal pannello», e il
  controllo che evita due backup a poche ore di distanza non funzionava. Era così dalla 1.27.
- **`trasloco.sh` e `aggiorna.sh` non scelgono più il database di un'altra app.** Prendevano «il
  primo container che contiene postgres»: su un Umbrel con altre app poteva essere il loro, e
  `trasloco.sh importa` ci avrebbe cancellato lo schema. Ora il nome deve essere di ANGEL, e con
  più candidati si fermano e chiedono.
- Documentazione rimessa e aggiornata: README, `docs/`, questo diario.

## 1.31.5 — 22 settembre 2026

- **Il pannello non dice più «fatto» a vuoto.** Se il bot non riceve un comando — lockdown,
  backup, quarantena — il pannello lo dice, invece di rispondere che è andato a buon fine.
- **La copia leggera su Discord.** Ogni notte il bot pubblica in un canale un file con quello che
  costa ore rifare a mano; `/copia-leggera rimetti` lo rimette. Parte spenta.

## 1.31.4 — 22 settembre 2026

- **Il lockdown chiude anche le chat delle vocali**, dei palchi e dei canali media. Parlare e
  collegarsi restano.
- **Un ruolo con «Invia messaggi» non scavalca più il blocco.** Il permesso si sospende e alla
  revoca torna — e l'elenco di cosa rimettere sta anche nel database, così uno spegnimento brusco
  durante un blocco non lo porta via.
- **La modalità prova vale anche per l'anti-raid.** Prima un raid rilevato in prova faceva partire
  un lockdown vero.

## 1.31.3 — 22 settembre 2026

- **Chi perde «Gestisci server» perde anche il pannello.** Gli accessi dati a mano restano.
- **Il pannello degli streamer non può scrivere su quello Discord** con i cookie di chi lo usa.
- **Il modello di server «yuyu»**, costruito sul profilo di [yayadoppia](https://www.twitch.tv/yayadoppia).

## 1.31.2 — 22 settembre 2026

- **«512 minacce oggi» non c'è più**: snapshot e lockdown fatti da ANGEL non sono minacce.
- **Il worker non risulta più «fermo» mentre lavora.**
- **Quando un processo risulta fermo, i log dicono perché.**

## 1.31.1 — 21 settembre 2026

- **I comandi del pannello tornano ad arrivare al bot.** ANGEL cercava Redis col nome corto
  `redis`; su umbrelOS, se un'altra app ha un servizio con quel nome, il nome risponde con due
  indirizzi e ogni connessione ne prende uno a caso. Pannello e bot finivano su due Redis diversi:
  «bot: fermo» di un bot collegato, e lockdown che rispondevano «fatto» senza fare niente. Ora si
  usa il nome completo del container. Lo stesso per Postgres.
- **Un link scritto in chat non può far contattare al bot la rete di casa.**
- **Redis lento all'avvio non tiene fermo il bot.**

## 1.31.0 — 21 settembre 2026

Ripartenza dalla 1.27.2.

- **Nel compose non c'è più nessun dato sensibile.** Token, chiavi e password vivono in
  `data/segreti/`, una cartella che gli aggiornamenti non toccano. Il file nasce già scritto, con
  i campi da riempire; uno già compilato non viene toccato.
- Segreto di sessione, chiave di cifratura e password del database se li genera ANGEL.
- **Se manca qualcosa, il bot aspetta** invece di riavviarsi in ciclo.

---

## Le versioni dalla 1.28 alla 1.30

Pubblicate il 20 e 21 settembre 2026, e ritirate. In quei giorni i comandi del pannello avevano
smesso di arrivare al bot, e la causa sembrava stare in quelle versioni: si è ripartiti dalla
1.27.2, l'ultima che aveva funzionato, rimettendo un pezzo alla volta.

La causa vera era un'altra — il nome di Redis, corretto nella 1.31.1 — ed era lì dal primo giorno
dello store. Quasi tutto quello che le 1.28–1.30 contenevano è tornato nelle 1.31.x. Non è tornato,
per scelta, il passaggio dei comandi a uno stream Redis: al suo posto il pannello dice quando un
comando non arriva a nessuno.

Le versioni precedenti alla 1.28 non hanno un diario: la cronologia sta in
[git log](https://github.com/Gigiomiccio425/aegis-discord-bot/commits/main).

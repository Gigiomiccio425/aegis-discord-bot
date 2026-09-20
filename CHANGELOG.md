# Diario delle versioni

Le date sono quelle di pubblicazione dell'immagine. Solo le versioni che cambiano qualcosa per chi
lo usa: le correzioni interne stanno nella cronologia git.

## 1.29.2 — 20 settembre 2026

- **Correzione della 1.29.1.** Su un'installazione nuova Postgres non partiva, dicendo
  `/segreti/postgres_password: No such file or directory`. Le cartelle di bind-mount le crea
  Docker di root, e ANGEL gira con uid 1000: non poteva scrivere la password. Ora un container
  sistema il proprietario al primo avvio, e non c'è nessun comando da dare a mano.

## 1.29.0 — 20 settembre 2026

- **Nel compose non c'è più nessun dato sensibile.** Token, chiavi e password vivono in
  `data/segreti/`, una cartella con i permessi stretti che gli aggiornamenti non toccano. Il
  compose di un'app umbrelOS viene riscritto dal repository a ogni aggiornamento: quello che ci si
  scriveva spariva, e nel frattempo stava in chiaro.
- **Da scrivere a mano restano cinque righe.** Segreto di sessione, chiave di cifratura e password
  del database se li genera ANGEL al primo avvio.
- **Se manca qualcosa, il bot aspetta invece di riavviarsi in ciclo.** Parte solo il pannello, e
  ogni quindici secondi ricontrolla. Appena i valori ci sono parte da solo, senza riavviare
  l'app.

## 1.28.0 — 20 settembre 2026

- **Lockdown corretto.** Non chiudeva le chat testuali dei canali vocali, e un permesso concesso a
  un ruolo batteva il divieto su `@everyone`: il canale restava aperto e il pannello diceva di
  averlo chiuso.
- **I comandi dal pannello non si perdono più.** La consegna passava da un canale senza memoria:
  se il bot non era in ascolto in quell'istante, il comando spariva senza che nessuno se ne
  accorgesse. Ora c'è una coda durevole, con l'esito di ogni comando.
- **Un secondo modello di server**, costruito sul profilo di [yayadoppia](https://www.twitch.tv/yayadoppia).
- Varie correzioni di sicurezza: SSRF nell'espansione dei link accorciati, un permesso del
  pannello che sopravviveva alla retrocessione su Discord, e un comando che poteva scrivere in un
  canale di un altro server.

---

Le versioni precedenti alla 1.28 non hanno un diario: la cronologia sta in
[git log](https://github.com/Gigiomiccio425/aegis-discord-bot/commits/main).

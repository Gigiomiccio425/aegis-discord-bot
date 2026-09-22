# Privacy, GDPR e limiti dichiarati

## Privacy e GDPR

Il bot tratta dati personali: gli ID Discord sono identificatori univoci, il contenuto dei messaggi
lo è a maggior ragione. La Developer Policy di Discord richiede una privacy policy a prescindere.

Cosa offre ANGEL:

- **Modalità di registrazione del contenuto** configurabile: `FULL`, `HASHED` (solo impronta, che
  riconosce i duplicati senza conservare il testo), `METADATA_ONLY`, o nessuna registrazione.
- **Retention per categoria**, applicata davvero da un lavoro notturno. Una retention dichiarata e
  non applicata è peggio di nessuna retention.
- **`/privacy`** mostra agli utenti esattamente cosa viene registrato e per quanto.
- **`/cancella-i-miei-dati`** cancella messaggi archiviati, eventi e profilo. I provvedimenti di
  moderazione restano, ma pseudonimizzati: cancellarli permetterebbe di azzerare la propria fedina
  uscendo e rientrando nel server.
- I token OAuth degli utenti del pannello sono cifrati a riposo con AES-256-GCM.

---

## Limiti dichiarati

Meglio saperli prima:

- **La cronologia dei messaggi non è ripristinabile come originale.** Discord non lo consente. Un
  backup ricostruisce ruoli, canali, permessi e impostazioni; i messaggi si possono esportare come
  trascrizione o ripubblicare come ricostruzione dichiarata (`/archivio`), ma non tornano a essere i
  messaggi originali — e l'archivio contiene solo ciò che il bot ha visto passare dopo la sua
  installazione.
- **Il bot non può leggere i messaggi privati fra utenti.** Phishing e adescamento si consumano
  soprattutto lì. Ciò che resta è intercettare il primo passo pubblico e riconoscere gli account già
  compromessi dal loro comportamento.
- **Il bot non può ottenere indirizzi IP.** L'API Discord non li espone ad alcun bot. Contro gli IP
  grabber si può solo bloccare il link postato.
- **Contro i deepfake vocali non esiste rilevamento affidabile.** Bastano tre secondi di audio per
  clonare una voce con precisione superiore al 95%. L'unica difesa pratica è la parola d'ordine.
- **L'OCR aggiunge latenza** (0,5-2s per immagine): gira nel worker, in asincrono. Un'immagine
  malevola può restare visibile qualche secondo prima di essere rimossa.
- **Google Safe Browsing ha un limite di quota** sul piano gratuito: mitigato con cache Redis e
  blocklist locali, ma su un server molto attivo può esaurirsi.
- **L'attribuzione degli inviti può sbagliare** se due persone entrano nello stesso istante: si
  basa sul confronto dei contatori, che è l'unico metodo disponibile.


---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

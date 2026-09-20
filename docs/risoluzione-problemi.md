# Risoluzione dei problemi

## Risoluzione dei problemi

**Il bot è online ma non registra nulla**
Manca un canale di log. Configuralo dal pannello, sezione *Registro eventi*, oppure verifica con
`/stato` che non compaia l'avviso corrispondente.

**«Impossibile rimuovere i ruoli: il bersaglio ha una posizione superiore al bot»**
Sposta il ruolo del bot più in alto nell'elenco dei ruoli del server. È il problema numero uno.

**L'anti-nuke non scatta**
Serve il permesso *Visualizza registro di controllo*: senza, non c'è modo di sapere chi ha
cancellato cosa. Verifica con `/stato`.

**I comandi slash non compaiono**
Con `DEV_GUILD_ID` impostato sono registrati solo su quella guild. Senza, la propagazione globale
richiede fino a un'ora. Forza con `npm run commands:deploy`.

**L'accesso al pannello fallisce con «stato non valido»**
Il redirect OAuth non corrisponde. Deve essere esattamente `PUBLIC_URL` + `/api/auth/callback`,
anche per quanto riguarda `http`/`https` e la porta.

**Le notifiche Twitch non arrivano**
EventSub richiede un callback pubblico in **HTTPS**: con un `PUBLIC_URL` in http o su localhost la
sottoscrizione non viene creata e resta attivo solo il controllo periodico, più lento. Verifica
anche che `TWITCH_EVENTSUB_SECRET` sia impostato.

**Il worker consuma molta memoria**
È l'OCR: tesseract carica i modelli linguistici in memoria. Riduci le lingue in
`scanner.image.ocrLanguages` o disattiva `asyncDeepScan` se il server è piccolo.

---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

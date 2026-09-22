# Risoluzione dei problemi

## Risoluzione dei problemi

**Il pannello dice «bot: fermo», ma il bot è su Discord e modera**
Pannello e bot stanno parlando con due Redis diversi. Su umbrelOS tutte le app stanno sulla stessa
rete, e fino alla 1.31.0 ANGEL cercava Redis col nome corto `redis`: se un'altra app installata ha
un servizio con quel nome — Immich, Nextcloud, molte altre — il nome risponde con due indirizzi, e
ogni connessione ne prende uno a caso. Si vede anche dai comandi: il pannello dice «fatto» e non
succede niente. Dalla 1.31.1 ANGEL usa il nome completo del container. Per capire se è quello:

```bash
sudo docker ps --format '{{.Names}}' | grep -i redis
```

Più di un nome, e sei su una versione precedente: aggiorna.

**Il pannello risponde «il bot non ha ricevuto il comando»**
Il comando è partito, ma nessuno lo stava ascoltando. Nei log del container cerca
`in ascolto dei comandi dal pannello`: se manca, il bot non si è ancora messo in ascolto — di
solito sta ripartendo, o Redis non risponde, e allora c'è `non riesco ad ascoltare i comandi dal
pannello`. Se il bot risulta anche «fermo» nel pannello, vedi la voce qui sopra.

**Il lockdown dice di aver chiuso i canali, ma qualcuno scrive ancora**
La risposta del lockdown elenca i canali che non ha chiuso, con il motivo. Il più comune: il bot
non ha «Gestisci ruoli», oppure il suo ruolo sta sotto quello che dovrebbe limitare. Lo staff
scrive comunque, per scelta; e chi ha una concessione personale sul canale — i ticket — anche.

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

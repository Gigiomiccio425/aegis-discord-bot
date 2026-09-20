# Configurazione

## Configurazione dell'applicazione Discord

1. Vai su <https://discord.com/developers/applications> e crea una nuova applicazione.
2. Sezione **Bot**: crea il bot, copia il token in `DISCORD_TOKEN`.
3. Sempre nella sezione **Bot**, attiva **tutti e tre** i *Privileged Gateway Intents*:
   - **Server Members Intent** — join, ruoli, profili
   - **Message Content Intent** — scanner dei contenuti
   - **Presence Intent** — rilevamento account compromessi

   > Devono essere accesi tutti e tre: il client li richiede in blocco e Discord, se anche uno
   > solo manca, non degrada ma chiude la connessione con `Used disallowed intents` (close code
   > 4014). Nei log compare come un riavvio in ciclo del servizio `bot`.
   >
   > Dal 10 giugno 2026 la soglia per l'approvazione non è più «100 server» ma **10.000 utenti
   > unici** raggiunti dall'app. Sotto quella soglia gli intent si attivano direttamente dal
   > Developer Portal. La verifica del bot a 100 server resta un procedimento separato, e
   > l'approvazione degli intent va rinnovata ogni anno.

4. Sezione **OAuth2**: copia *Client ID* e *Client Secret*. Aggiungi come redirect
   `https://tuodominio.it/api/auth/callback` (in locale: `http://localhost:8080/api/auth/callback`).
5. Invita il bot con questi permessi:

   ```
   https://discord.com/oauth2/authorize?client_id=IL_TUO_CLIENT_ID&scope=bot+applications.commands&permissions=1101390802102
   ```

   Corrispondono a: gestione ruoli, canali, webhook, server ed espressioni; ban, kick e timeout;
   gestione messaggi; lettura del registro di controllo; invio di messaggi, embed e allegati.
   Non è richiesto `Administrator`, e non va concesso: un bot con Administrator rende il server
   compromettibile attraverso la catena di fornitura del bot stesso.

6. **Posizione del ruolo**: sposta il ruolo del bot *sopra* tutti i ruoli su cui deve poter agire.
   Discord non consente di toccare chi ha un ruolo più alto — è il motivo più frequente per cui una
   difesa configurata correttamente non riesce ad applicare la sanzione.

---
## Primo avvio: cosa configurare

Il bot parte con tutti i moduli **spenti**: nessuna sanzione viene applicata finché non si decide
cosa attivare. L'ordine consigliato:

1. **Registro eventi** — imposta un canale di log. Serve a vedere cosa succede prima di decidere
   cosa bloccare.
2. **Ruolo di quarantena** — crea un ruolo senza permessi, con l'accesso negato a tutti i canali,
   e indicalo nella configurazione generale. Senza, le difese non hanno dove isolare nessuno.
3. **Canale di allarme e ruolo da menzionare** — per gli eventi critici.
4. **Modalità prova** (`dryRun`) — attivala per qualche giorno: i moduli valutano e registrano tutto
   ma non sanzionano. È il modo per tarare le soglie guardando cosa *avrebbero* fatto.
5. Attiva i moduli, partendo da anti-nuke e scanner dei contenuti, che hanno pochissimi falsi
   positivi. Anti-spam e controllo account vogliono più taratura.
6. **Parola d'ordine dello staff** — impostala. Contro una voce clonata da tre secondi di audio non
   esiste rilevamento affidabile; una parola concordata in anticipo sì.
7. **Whitelist anti-nuke** — aggiungi i bot legittimi che riorganizzano canali o ruoli, altrimenti
   verranno disarmati al primo lavoro di manutenzione.

### Costruire il server da zero

`/crea-server` (anche `/build-server`) porta un server vuoto a essere una community pronta:
ruoli, categorie, canali, modalità community, verifica e ticket, con la configurazione già
compilata per ogni funzione del bot — comprese quelle spente, perché un canale che esiste si
accende con una spunta mentre un canale che manca richiede di ricordarsi che serviva.

La struttura segue il percorso di chi arriva, che è la ragione per cui funziona: prima si capisce
dove si è (regolamento, verifica, annunci, ruoli), poi si parla (pochi canali generali e pieni),
poi le cose specifiche (dirette, clip, eventi), e in fondo staff e assistenza. Un server nuovo con
venti canali tematici è venti canali vuoti, e il vuoto scoraggia più di una chat affollata.

**La modalità community si accende da sola.** Discord la concede a un bot con Amministratore, ma
pretende nella stessa richiesta il canale del regolamento, quello degli aggiornamenti per lo staff
e le due impostazioni minime di sicurezza — mandandone una in meno risponde con un errore che
parla d'altro. Da lì arrivano i canali annuncio, i forum e le funzioni riservate alle community.

Si può rieseguire quando si vuole: ogni cosa viene cercata per nome prima di essere creata, e i
campi già compilati non vengono toccati.

**Il bot non può creare il server.** L'API lo consentirebbe a un bot presente in meno di dieci
server, ma il proprietario risulterebbe il bot e la proprietà non è trasferibile a una persona: un
server di cui non sei padrone non è tuo. Il server si crea a mano in dieci secondi, e da lì in poi
fa tutto il comando.

### I ruoli

C'è **un ruolo per concetto**, e cambia vestito invece di essere affiancato da un secondo. Nasce con
il nome tecnico — `ANGEL · Staff` — e quando scegli uno stile con `/crea-server` diventa
`☾ Ali Guardiane` **restando lo stesso ruolo**: stesso identificativo, stesse persone dentro,
stessi permessi sui canali. La configurazione non va riscritta e niente si rompe.

Fino alla 1.26 erano due elenchi che non si conoscevano, e il risultato era che un moderatore doveva
avere `ANGEL · Staff` *e* `☾ Ali Guardiane`: uno perché il bot lo esentasse, l'altro perché si
vedesse nella lista membri.

| Ruolo | Stile *nuvole* | Stile *yuyu* | A chi va |
|---|---|---|---|
| `ANGEL · Non verificato` | `☁︎ In attesa` | `⊹ senza ali` | a chiunque entri — lo mette il bot |
| `ANGEL · Verificato` | `˚ʚ♡ɞ˚ Piumette` | `⋆｡˚ yuyu ˚｡⋆` | a chi supera la verifica — lo mette il bot |
| `ANGEL · Quarantena` | `⛆ Nube grigia` | `༄ piuma spezzata` | provvedimento: legge ovunque, non scrive |
| `ANGEL · Staff` | `☾ Ali Guardiane` | `✦ custodi` | **ai moderatori veri.** Sei campi puntano qui |
| `ANGEL · Guida` | `⋆｡°✩ Angelo Maggiore` | `⟡ custode del cielo` | a te, e a chi divide la responsabilità del server |
| `ANGEL · Aiutanti` | `✿ Piume` | `˖ ࣪ piccole ali` | a chi dà una mano e non deve poter bandire nessuno |
| `ANGEL · Sostenitori` | `♡ Nuvola d'oro` | `ೀ yuyu d'oro` | a chi ha potenziato il server |
| `ANGEL · Allerta` | `⚡ Sveglia le ali` | `⚡ sveglia le nuvole` | a chi vuoi svegliare di notte per un raid |
| `ANGEL · In diretta` | `✧ Luci accese` | `⭑ ora in volo` | allo streamer mentre trasmette — lo mette il bot |
| `ANGEL · Partecipa` | `✿ Ci sarò` | `⊹ presente` | a chi conferma un evento — lo mette il bot |
| `ANGEL · Avviso diretta/video/eventi` | `⋆ ✦ ✧ Avviso …` | `☾ ✦ ⟡ …` | se li prendono da soli da «prendi-i-ruoli» |

**Due modelli, due tavolozze.** `/crea-server modello:` sceglie fra *nuvole* — separatori grandi,
maiuscole, l'angioletto bianco — e *yuyu*, tutto minuscolo con simboli minuti, dove i verificati si
chiamano come la community di yayadoppia. Struttura e percorsi di configurazione sono identici:
cambia solo la voce. Senza indicare niente si tiene quello già in uso, perché i canali si ritrovano
per nome e passare da un modello all'altro non rinomina quelli che esistono — li affiancherebbe.

I primi quattro della predisposizione (`Non verificato`, `Verificato`, `Quarantena`, `Staff`,
più `Allerta`, `In diretta` e `Partecipa`) nascono con `/prepara-server`. Gli altri arrivano con
`/crea-server`: su un'installazione che vuole solo la parte di sicurezza sarebbero ruoli decorativi
mai chiesti.

**I permessi arrivano con lo stile, non alla creazione.** Un ruolo appena nato non ha ancora nessuno
dentro, e darglieli lì significa crearlo già pericoloso. Quando si sceglie uno stile, `Staff` riceve
espelli/bandisci/silenzia/gestisci messaggi/registro/soprannomi, e `Guida` quelli più tutto il resto
che serve a tenere in ordine il server.

Tre permessi il bot non li dà **mai**, a nessun ruolo e in nessuno stile: **Amministratore**,
**Gestire i ruoli** e **Gestire i canali**. Sono le tre chiavi con cui si prende il controllo di un
server — chi può assegnare ruoli può assegnarsi qualunque cosa — e restano una decisione di una
persona. C'è un test che verifica che non compaiano.

E i permessi **si aggiungono, non si sostituiscono**: se ne hai tolti a mano, restano tolti. Una
riesecuzione non riporta indietro un ruolo che avevi ridotto di proposito.

### Ruoli doppi: `/ripara-ruoli`

Per i server costruiti prima dell'unificazione, che hanno entrambi gli insiemi.

```
/ripara-ruoli                    guarda e racconta cosa farebbe
/ripara-ruoli applica:true       lo fa
/ripara-ruoli applica:true stile:Angelico
```

Per ogni concetto trova tutti i ruoli che gli corrispondono, ne sceglie uno — quello già scritto in
configurazione, altrimenti quello con più persone, altrimenti il più alto — sposta le persone dagli
altri, cancella i vuoti e corregge i campi.

Non fa niente finché non glielo si chiede: cancellare un ruolo porta via ogni permesso che qualcuno
gli aveva dato sui canali, uno per uno, senza avviso, e quell'anteprima è l'unica occasione di
accorgersi che uno dei doppioni non era un doppione. Chi si sposta riceve **prima** il ruolo che
resta e solo dopo perde il vecchio: al contrario, un errore fra le due chiamate lascerebbe qualcuno
senza nessuno dei due.

Un ruolo con più di 500 persone, o più alto del bot, o creato da un'integrazione, viene lasciato
dov'è e segnalato.

### Cosa fa la predisposizione ai permessi

Con la verifica attiva, «Prepara il server» chiude il server a `@everyone`: i canali diventano
visibili solo a chi ha il ruolo **ANGEL · Verificato**, e chi arriva vede il solo canale `#verifica`
finché non preme il pulsante. Da lì lo staff affina come crede — questa è la base, non la parola
finale.

Due cose che vale la pena sapere prima di premere:

- **I membri già presenti diventano verificati.** Senza, chiudere i canali a `@everyone`
  cancellerebbe il server sotto gli occhi di tutti nello stesso istante: la verifica riguarda chi
  arriva, non chi c'è da mesi. Sono compresi i bot, che senza il ruolo perderebbero la vista dei
  canali e smetterebbero di funzionare senza un errore che lo spieghi.
- **I canali già riservati non vengono toccati.** La regola è una sola: si interviene solo dove
  `@everyone` vede già. Dove è già escluso non viene scritto nulla — né la negazione, superflua, né
  il permesso ai verificati, che è precisamente ciò che aprirebbe allo staff allargato un canale
  riservato agli amministratori.

Vale anche per i canali creati dopo: nascono chiusi come gli altri, altrimenti basterebbe un canale
aggiunto in fretta per aprire una finestra sul server.


---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

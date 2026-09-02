# ANGEL per Twitch

Un secondo bot dentro lo stesso programma: modera la chat Twitch e fa quello che fa un bot di
chat — messaggi a tempo, comandi, saluti. Stesso container, stesso database, stessa lista di
parole vietate del bot Discord. Pannello separato, su una porta separata, pensato per essere dato
agli streamer.

---

## Indice

- [Perché è fatto così](#perché-è-fatto-così)
- [Le minacce, e cosa fa il bot](#le-minacce-e-cosa-fa-il-bot)
- [I livelli di sicurezza](#i-livelli-di-sicurezza)
- [Cosa condivide con il bot Discord](#cosa-condivide-con-il-bot-discord)
- [Funzionare senza pannello](#funzionare-senza-pannello)
- [I termini di servizio di Twitch](#i-termini-di-servizio-di-twitch)
- [Architettura](#architettura)
- [Installazione](#installazione)
- [Cosa gira da solo](#cosa-gira-da-solo)
- [Comandi in chat](#comandi-in-chat)
- [Limiti dichiarati](#limiti-dichiarati)

---

## Perché è fatto così

Tre decisioni spiegano tutto il resto.

**EventSub su WebSocket, non IRC.** IRC è più semplice — ci si collega, si fa JOIN e arrivano i
messaggi — ma una connessione entra in cento canali al massimo, ogni ingresso conta su un limite di
venti ogni dieci secondi, e le funzioni nuove di Twitch su IRC non arrivano affatto. EventSub regge
trecento sottoscrizioni per connessione senza limiti d'ingresso e porta gli eventi che IRC non ha:
moderazione, utenti sospetti, modalità scudo. Il prezzo è tenere viva la sessione a mano, e sta
tutto in [`eventsub.ts`](../packages/twitch/src/eventsub.ts).

**Un account bot, non l'account dello streamer.** Il bot parla da un account Twitch suo, che
autorizza l'applicazione una volta sola. Lo streamer autorizza separatamente, e quel secondo
consenso dà i permessi di moderazione sul suo canale. Farlo parlare come lo streamer sarebbe stato
più semplice da configurare e profondamente sbagliato: i messaggi del bot sembrerebbero suoi.

**Una porta separata.** Il pannello Discord contiene i dati di ogni server dove il bot è presente e
resta dov'è, dietro Tailscale. Questo è fatto per stare su Internet, perché sono gli streamer a
doverlo raggiungere. Due porte, due superfici, due platee: aprire la seconda non apre la prima.

---

## Le minacce, e cosa fa il bot

La ricerca è di settembre 2026. Su Twitch il vettore è quasi sempre **il testo**: non si possono
caricare file, non ci sono allegati, e ogni truffa passa da una frase o da un dominio.

| Minaccia | Come si presenta | Difesa |
|---|---|---|
| **Venditori di visualizzatori** | «cheap viewers», «buy followers», «upgrade your stream». Scritti in Unicode strano — `Ch̍eap Vi̇ewers`, `Viewe𝗿𝘀` — apposta per passare i termini bloccati di Twitch, che confrontano il testo letterale | Confronto sul testo **normalizzato**: omoglifi, matematici e diacritici combinanti ridotti alla forma base prima del confronto |
| **Finte carte regalo Steam** | Venti e più siti di phishing che promettono buoni da 5 a 50 dollari e skin gratis. Il link sta in chat o nella descrizione del profilo | Rilevamento frasi + confronto dei domini con i marchi imitati (typosquatting, punycode, omoglifi) |
| **Wallet drainer** | La pagina chiede di «collegare il portafoglio per verificare» | Frasi cripto + riconoscimento degli indirizzi di portafoglio nel testo |
| **Hate raid** | Decine o centinaia di account creati apposta che arrivano insieme. Colpisce in modo sproporzionato streamer neri, donne e persone queer. **I primi trenta secondi decidono** | Due segnali indipendenti — quanti sconosciuti scrivono per la prima volta *e* quanti messaggi si somigliano — poi modalità scudo, solo-seguaci, rallentamento, con scadenza automatica |
| **Impersonazione dello streamer** | Nome quasi identico, spesso con lettere cirilliche, e un «hai vinto, scrivimi in privato» | Confronto per somiglianza (Jaro-Winkler) sui nomi normalizzati, contro streamer e moderatori |
| **Finti grafici** | «see my work?», «logos banners overlays». Chiedono un anticipo e spariscono | Peso medio: esistono grafici veri. Serve un secondo segnale perché scatti |
| **Adescamento fuori piattaforma** | «add me on discord», «my username is». È il passo che precede ogni truffa più seria | Peso basso: in chat ci si scambia i contatti in buona fede tutto il giorno |
| **Spam classico** | Ripetizione, velocità, maiuscole, muri di emote, ASCII art | Soglie per canale, con esenzione automatica di moderatori e bot legittimi |

Un dettaglio che vale la pena dire: **i bot legittimi non si toccano mai.** Nightbot,
StreamElements, Fossabot e gli altri sono esenti a ogni livello, blindato compreso. Silenziare
Nightbot rompe il canale di qualcun altro, e il primo sospettato sarebbe il nostro bot.

---

## I livelli di sicurezza

Chi apre il pannello per la prima volta non vuole decidere trenta soglie: vuole dire «tieni pulito»
e andare a trasmettere.

| Livello | Cosa fa |
|---|---|
| **Osserva** | Valuta tutto e scrive cosa avrebbe fatto, senza sanzionare nessuno. Il modo di capire come si comporterebbe prima di lasciarglielo fare |
| **Leggero** | Solo link malevoli e bot commerciali. Nessun filtro sul linguaggio, nessun anti-spam |
| **Normale** | L'equilibrio consigliato: linguaggio, link, spam e ondate con soglie larghe |
| **Alto** | Soglie strette, primo messaggio limitato, ondate trattate prima. Qualche falso positivo in più è il prezzo |
| **Blindato** | Link riservati ad abbonati e VIP, chat rallentata e riservata a chi segue da un giorno, ondate al primo segnale. Scomodo di proposito: serve a far passare la nottata |
| **Personalizzato** | Ci si arriva da soli toccando qualunque campo |

Cambiare livello **non cancella** timer, comandi, domini ammessi e canali di registro: sono il
lavoro dello streamer, e un preset che li spazzasse via renderebbe quel menu qualcosa che nessuno
osa più toccare. C'è un test che lo verifica.

---

## Cosa condivide con il bot Discord

Non è «integrato» nel senso di due programmi che si parlano: è **lo stesso programma**.

- **La lista delle parole vietate.** Vive in [`wordlist.ts`](../packages/shared/src/config/wordlist.ts)
  e la leggono tutti e due. Una parola aggiunta dal pannello Discord è bloccata anche in chat
  Twitch, senza sincronizzazioni da ricordare e senza due liste che divergono.
- **Le blocklist dei domini.** URLhaus, Phishing.Database e le firme dello scanner sono già
  scaricate e aggiornate ogni sei ore per Discord. Il bot Twitch le legge dallo stesso database e
  le tiene in memoria come `Set`: la valutazione di un messaggio non può permettersi una query.
- **La normalizzazione del testo e il motore del linguaggio**, da `@angel/shared` e
  `@angel/scanner`.
- **I modelli con i segnaposto**: `{utente}`, `{canale}`, `{uptime}` funzionano allo stesso modo
  nei comandi Twitch, nei comandi Discord e negli annunci.
- **La copia di sicurezza notturna**: le tabelle Twitch sono nell'esportazione, e i file NDJSON del
  registro stanno sotto `STORAGE_DIR`, quindi finiscono già in `archivio.tar.gz`.

E in direzione opposta: **il registro va su Discord**. Ogni azione sopra la soglia scelta diventa un
embed in un canale del server collegato — colorato per gravità, così in un canale che scorre si
riconosce un bando da un messaggio cancellato senza leggere una riga.

---

## Funzionare senza pannello

Il requisito era che il bot resti utile «in qualsiasi situazione». Tre meccanismi:

**1. `!angel` in chat.** Livello di sicurezza, scudo, modalità prova, domini ammessi, timer,
sanzioni: tutto si comanda da una riga di chat. Se il pannello è irraggiungibile, se lo streamer è
al telefono e ha solo l'app di Twitch, `!angel scudo on` funziona comunque.

**2. La copia su disco dei canali.** Ogni volta che la configurazione si carica dal database, si
scrive anche in `STORAGE_DIR/twitch/canali.json`. All'avvio, se il database non risponde, si legge
quel file e si parte lo stesso — moderazione, comandi e messaggi a tempo compresi, perché i moduli
sono funzioni pure che non hanno mai avuto bisogno del database.

La copia **non contiene i token**, ed è una scelta: un file in chiaro con dentro le credenziali di
moderazione di tutti i canali serviti è un bersaglio che vale più di una serata di moderazione. In
pratica il caso comune funziona lo stesso — il database cade mentre il processo è già acceso, e i
token sono in memoria; è solo un riavvio *durante* il guasto a lasciarlo senza, e in quel caso lo
dice in chat con `!angel stato`.

**3. Il registro su file, sempre.** Un NDJSON al giorno per canale, scritto **prima** del database.
Durante un guasto gli eventi continuano a essere registrati e si riversano dentro quando torna.

E il pannello parte **dopo** il motore, in un `catch` che non propaga: porta occupata, build
mancante, Redis assente — il bot resta in chat.

---

## I termini di servizio di Twitch

Il Developer Services Agreement pone limiti veri. Non sono buone intenzioni: sono la differenza fra
un'applicazione che resta viva e una a cui revocano le chiavi.

| Obbligo | Come è rispettato |
|---|---|
| I log di chat si conservano solo per il tempo necessario al servizio | Il testo dei messaggi sanzionati ha una scadenza **calcolata alla scrittura**, predefinita 30 giorni, massimo 90. Gli eventi senza testo, 180 giorni. Uno spettatore mai più visto viene dimenticato dopo un anno |
| Non si costruiscono archivi pubblici né si profilano gli spettatori | La chiave di `TwitchViewer` è **(canale, utente)**, non l'utente: la stessa persona in due canali sono due righe che non si parlano. Non esiste un indice che inviti ad attraversare i canali, e nessuna rotta restituisce i canali altrui |
| Va data la possibilità di opporsi | `!angel dimenticami` cancella tutto quello che il bot sa di chi lo scrive, su quel canale. **Non ha un interruttore**: un modo per disattivarlo sarebbe un modo per non darla |
| Vietati i bot che generano odio, spam o falsi follow | Il bot non manda mai messaggi non richiesti, non segue nessuno, non gonfia nessun numero |
| Rispetto dei limiti di frequenza | Secchielli a gettoni con ricarica continua: 20 (o 100 da moderatore) messaggi ogni 30 s per canale, 800 punti al minuto per l'API. Vedi [`bucket.ts`](../packages/twitch/src/bucket.ts) |
| Solo i dati che servono | Non si conserva la chat: si conservano i messaggi **rimossi**, e solo se il canale lo lascia acceso. Un messaggio normale non lascia traccia |

Il testo dei messaggi sanzionati si conserva per una ragione che vale la pena dire: senza, resta
l'azione e il motivo ma non cosa è stato scritto, e non si può più verificare se la decisione era
giusta. È anche il motivo per cui quella conservazione ha una scadenza corta e obbligatoria.

---

## Architettura

```
packages/twitch/            libreria pura — nessuna rete nei test, nessun database
  bucket.ts                 secchielli a gettoni per i limiti di Twitch
  helix.ts                  client REST, con rinnovo dei token dentro la richiesta
  eventsub.ts               WebSocket, keepalive, trasloco, riconnessione
  moderazione/segnali.ts    frasi e domini delle campagne note
  moderazione/motore.ts     i moduli e il verdetto — funzioni pure

apps/twitch/                il processo
  motore.ts                 chat → valutazione → azione → registro
  azioni.ts                 esecuzione su Twitch, scudo, termini bloccati
  comandi.ts                comandi integrati, personalizzati, !angel
  stato.ts                  registro dei canali + copia su disco (modalità autonoma)
  archivio.ts               file NDJSON, scritture in blocco, inoltro a Discord
  pannello/server.ts        Fastify sulla porta 781, accesso con Twitch

apps/web-twitch/            il pannello degli streamer (React)
```

**Come decide il motore.** Ogni modulo attivo guarda il messaggio e restituisce dei punti con il
motivo; ogni modulo ha la propria scala che traduce i punti in un'azione; vince l'azione più severa
fra quelle uscite. La somma **non attraversa i moduli**: sommando tutto, un messaggio maiuscolo con
un link e una parolaccia arriverebbe a punteggio da bando pur essendo tre inezie.

**Ottimizzazione.** Il collo di bottiglia non è la valutazione — sono funzioni pure che girano in
microsecondi — ma quello che le sta attorno:

- niente database sul percorso del messaggio: gli spettatori vivono in memoria, il registro parte in
  blocchi ogni due secondi;
- si esce presto — canale spento, messaggio del bot, streamer — prima di normalizzare qualunque cosa;
- i moduli certi (bot commerciali, link) vengono valutati per primi, così un messaggio già
  condannato non paga l'analisi del linguaggio;
- una connessione EventSub regge ~70 canali; oltre, il pool ne apre un'altra da solo;
- gli spettatori in memoria si sfoltiscono a metà oltre le ventimila voci, non uno alla volta.

---

## Installazione

**1. L'applicazione Twitch** — <https://dev.twitch.tv/console/apps>. Come *OAuth Redirect URL* metti
`TWITCH_PUBLIC_URL` + `/api/auth/callback`. Copia client ID e secret nel compose.

**2. L'account del bot.** Crea un account Twitch normale con il nome che vuoi dare al bot. Poi metti
una parola qualsiasi in `TWITCH_SETUP_KEY`, riavvia, e **dal browser in cui hai fatto l'accesso con
quell'account** apri:

```
TWITCH_PUBLIC_URL/api/auth/bot?chiave=LA_PAROLA
```

Twitch chiede la conferma, e la pagina che torna mostra le quattro righe `TWITCH_BOT_*` già pronte
da incollare nel compose. **Poi svuota `TWITCH_SETUP_KEY`**: finché c'è, chi la indovina può rifare
lo stesso giro. Senza quella variabile la rotta risponde 404 — non 403, perché chi non deve saperlo
non deve nemmeno sapere che c'è qualcosa da indovinare.

I token non vengono salvati da nessuna parte: si vedono una volta, e se chiudi la pagina senza
copiarli rifai il giro. Stanno nel compose e non nel database di proposito, così un trasloco se li
porta dietro insieme a tutte le altre credenziali.

**3. La porta.** Il pannello risponde su `781`. Perché gli streamer possano raggiungerlo va esposto
— un tunnel Cloudflare su un sottodominio è la via più pulita, e dà HTTPS senza aprire porte sul
router. `TWITCH_PUBLIC_URL` deve combaciare **esattamente** con l'indirizzo che si digita nel
browser, altrimenti l'accesso fallisce con «stato non valido».

**4. Lo streamer.** Apre il pannello, preme *Entra con Twitch*, autorizza. Il canale è collegato e
il bot entra in chat senza riavviare niente.

**5. Nomina il bot moderatore del canale** (`/mod nomedelbot` in chat). Non è obbligatorio, ma
cambia il limite dei messaggi da 20 a 100 ogni trenta secondi — e durante un'ondata è la differenza
fra rispondere e non rispondere. Il bot se ne accorge da solo entro cinque minuti e alza il proprio
secchiello.

**6. Per gli avvisi su Discord**: nel pannello, scheda *Collegamenti*, incolla l'identificativo del
server Discord — su Discord lo dà `/twitch bot collega`. Poi, sempre su Discord, `/twitch bot registro`
sceglie in quale canale far arrivare tutto.

Il collegamento parte dal pannello Twitch e non da Discord perché lì chi lo fa ha dimostrato di
possedere il canale entrando con Twitch. Dall'altra parte l'unica prova sarebbe «amministro un
server», che non dice niente su chi possiede il canale — e permetterebbe di dirottare altrove gli
avvisi di moderazione di qualcun altro.

Senza le variabili di Twitch il processo si spegne da solo e non disturba: chi usa ANGEL solo per
Discord non se ne accorge.

---

## Cosa gira da solo

| Ogni | Cosa |
|---|---|
| **10 s** | messaggi a tempo, scadenza delle restrizioni anti-raid |
| **2 s** | scrittura del registro in blocco (o prima, a cento eventi) |
| **5 min** | salvataggio degli spettatori, elenco dei moderatori, sincronizzazione dei termini bloccati |
| **1 h** | conservazione: testo scaduto azzerato, eventi e spettatori vecchi rimossi, sessioni scadute |

Il giro da cinque minuti è separato da quello da dieci secondi perché ha un costo di due ordini di
grandezza diverso: il primo guarda dei numeri in memoria, il secondo fa una chiamata a Twitch e una
scrittura per canale. Farlo ogni dieci secondi vorrebbe dire consumare il limite di frequenza per
sapere una cosa che cambia una volta al mese.

La sincronizzazione dei termini bloccati si rifà **solo quando l'elenco cambia davvero**: c'è
un'impronta delle parole, e senza si spenderebbero cento chiamate ogni cinque minuti per riscrivere
le stesse novanta.

---

## Comandi in chat

Chi può usarli lo decide `chat.livelloComandiBot`, predefinito i moderatori.

```
!angel stato                    livello, moduli accesi, timer, se c'è da riautorizzare
!angel livello alto             osserva | leggero | normale | alto | blindato
!angel prova on|off             valuta senza sanzionare
!angel scudo on|off             chiude la chat adesso
!angel permetti discord.gg      aggiunge o toglie dai domini ammessi
!angel vieta sitobrutto.com     aggiunge o toglie dai domini bloccati
!angel silenzia @tizio 600      timeout
!angel bandisci @tizio
!angel perdona @tizio
!angel timer on|off|<nome>
!angel dimenticami              per chiunque: cancella i propri dati su questo canale
```

Di serie ci sono anche `!uptime`, `!comandi`, `!dado`, `!seguito`. Quelli personalizzati si
scrivono dal pannello e accettano `{utente}`, `{canale}`, `{argomento}`, `{uptime}`.

Se il database è caduto, i comandi funzionano lo stesso e il bot lo dice: «attivo adesso, ma non ho
potuto salvarlo».

---

## Limiti dichiarati

- **Il bot non vede le whisper.** Le truffe che si spostano in privato si contrastano solo
  riconoscendo l'invito a spostarsi, che è quello che fa il modulo dell'adescamento.
- **AutoMod di Twitch blocca prima, il bot cancella dopo.** In una chat veloce quella differenza
  sono decine di persone che hanno già letto. Per questo esiste la sincronizzazione dei termini
  bloccati: ci vanno le parole più gravi, che Twitch ferma prima che compaiano. Twitch ne accetta
  cento per canale, e il bot tocca solo quelli che ha messo lui.
- **La verifica dei bot di Twitch è sospesa.** Il limite dei messaggi resta quello basso finché lo
  streamer non nomina il bot moderatore del proprio canale. Il bot se ne accorge da solo entro
  cinque minuti e passa da 20 a 100 messaggi ogni trenta secondi.
- **La reputazione degli spettatori si precarica fino a cinquemila per canale**, i più recenti. Chi
  resta fuori non è scoperto — Twitch dichiara lui stesso `is_first_message` — ma la fiducia
  accumulata riparte da zero.
- **Le impronte dei nomi non riconoscono l'italiano storpiato.** Il confronto per somiglianza vede
  `yayad0ppia` e `уауadoppia`; non vede un nome del tutto diverso che finge di essere lo staff nel
  testo del messaggio.
- **Senza database e dopo un riavvio, il bot non può sanzionare.** Legge, risponde, registra su
  file, e lo dice.

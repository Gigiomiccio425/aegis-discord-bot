# Sicurezza: cosa ferma ANGEL

## Cosa protegge

| Minaccia | Come funziona nella realtà | Difesa |
|---|---|---|
| **QR di login Discord** | Un QR che punta a `discord.com/ra/…` è il flusso Remote Auth: chi lo inquadra consegna il token del proprio account. Non serve la password, non compare alcun avviso — è Discord stessa a trasmetterlo | Ogni immagine viene decodificata; un QR di questo tipo fa scattare l'azione massima e un avviso pubblico |
| **ClickFix / finta CAPTCHA** | «Premi Win+R, Ctrl+V, Invio»: negli appunti c'è già PowerShell offuscato. +517% nel primo semestre 2025, allerta FTC di giugno 2026 | Rilevatore dedicato, attivo sia sul testo sia sull'OCR degli screenshot |
| **Ondata MrBeast / giveaway falsi** | Account veri, compromessi da infostealer, che pubblicano in massa immagini con link | Rilevamento del *cambio di comportamento* + hash percettivo delle immagini + OCR |
| **Invite hijacking** | Discord permette di rivendicare come vanity i codici invito scaduti o liberati: i link pubblicati mesi prima portano altrove | Ogni invito pubblicato viene risolto; i propri codici sono sorvegliati con allarme se si liberano |
| **Raid** | Reti di self-bot generano migliaia di account in pochi minuti; i primi 30 secondi decidono l'esito | Finestra scorrevole sui join + rilevamento di cluster simili + risposta graduata fino al lockdown |
| **Nuke** | Un amministratore compromesso o un insider cancella canali e ruoli in venti secondi | Soglie per singolo attore sul registro di controllo, rimozione immediata dei ruoli, snapshot d'emergenza |
| **Webhook ostili** | Consentono messaggi dall'aspetto ufficiale senza essere membri; usati come canale di esfiltrazione da pacchetti npm/PyPI compromessi | Inventario, allowlist, eliminazione automatica degli sconosciuti |
| **Bot di terze parti** | Un bot con Administrator equivale al server compromesso se la sua catena di fornitura viene colpita | Punteggio di rischio dei permessi, rimozione di Administrator, allarme sugli aumenti di permessi |
| **Impersonificazione dello staff** | Nickname e avatar copiati, spesso con omoglifi (`Мoderatore` con la M cirillica) | Confronto per similarità su nomi normalizzati contro lo staff reale |
| **File mascherati** | `foto.png.exe`, eseguibili rinominati, polyglot | Verifica dei magic bytes, estensione doppia, firme dentro le immagini |
| **Link raccolta IP** | Il bot non può ottenere IP, ma i link grabber postati in chat funzionano | Blocklist dei servizi noti |
| **Adescamento di minori** | Il primo passo è quasi sempre pubblico: richiesta di età, invito a spostarsi in privato, richiesta di segretezza | Rilevamento di schemi combinati, segnalazione allo staff con prove congelate, **nessuna sanzione automatica** |

Il resto — anti-spam, controllo account, verifica d'ingresso, ruoli appiccicosi — è configurabile
modulo per modulo dal pannello.

### Rapporto giornaliero in privato

A mezzanotte, a chi possiede il bot (`OWNER_IDS`), un messaggio privato con **una scheda per
server**: ingressi e uscite, messaggi archiviati ed eliminati, provvedimenti divisi per tipo, eventi
per categoria, cosa è successo di più, ticket, persone in quarantena e attenzionate, incidenti — e
in fondo la diagnosi della configurazione, cioè cosa non funzionerebbe se servisse.

La ragione è che il pannello lo si apre quando si sospetta un problema, quindi non lo si apre mai
finché il problema non è già successo. Un rapporto che arriva da solo racconta anche i giorni in cui
non è successo niente, ed è confrontando quei giorni che ci si accorge di quello diverso.

Il colore della scheda dice in un colpo d'occhio se c'è da fare qualcosa: rosso configurazione rotta,
giallo incidenti, grigio normalità. I limiti di Discord — 4096 caratteri per descrizione, 1024 per
campo, 25 campi, 10 embed — sono rispettati alla fonte: ogni pezzo viene troncato e il rapporto si
divide in più messaggi invece di non partire affatto.

L'ora è quella del container: `TZ` nel compose la sposta senza toccare il codice.

### Segnalazioni con azioni rapide

`/segnala` manda una segnalazione nel canale riservato (`angel-segnalazioni`, creato dalla
predisposizione) con le prove congelate: se chi ha scritto il messaggio lo cancella subito dopo, la
copia resta. Il nome di chi segnala lo vede solo lo staff.

Accanto alla segnalazione ci sono i pulsanti — **silenzia 10 min**, **silenzia 1 ora**,
**quarantena**, **espelli**, **bandisci**, **archivia** — perché il tempo fra «ho letto la
segnalazione» e «ho agito» è quello in cui il danno continua.

I pulsanti non scavalcano niente: controllano il permesso di chi preme, la gerarchia dei ruoli, e
registrano il provvedimento nella scheda della persona esattamente come farebbe il comando. Quando
uno viene premuto, il messaggio mostra chi ha deciso cosa — una segnalazione senza esito visibile
viene riaperta da un altro moderatore due ore dopo.

`/azioni` apre lo stesso pannello su una persona qualsiasi, per il moderatore che ha visto la cosa
con i propri occhi e non vuole ricordarsi cinque comandi con i loro argomenti.

### Controlli di coerenza

I guasti peggiori non stanno dentro un modulo: stanno **fra** i moduli, e per questo non si vedono
guardando la sezione di quello che sembra rotto. Sono sempre di tre tipi.

| | Esempio reale |
|---|---|
| **Dipendenza spenta** | Il rilevatore di account compromessi prende due dei suoi segnali dallo scanner: con lo scanner spento restano a zero per sempre |
| **Campo necessario vuoto** | Una soglia dice «quarantena» e il ruolo di quarantena non è impostato: l'azione non isola nessuno |
| **Contrasto** | Lo stesso ruolo usato come «non ha ancora verificato» e come «è stato sanzionato»: chi entra risulta punito senza aver fatto nulla |

Le dipendenze sono **dichiarate** in [`coerenza.ts`](../packages/shared/src/config/coerenza.ts), non
dedotte dal codice: dedurle avrebbe scoperto esattamente ciò che il codice fa, cioè anche i difetti,
spacciandoli per regole. Sono i test a tenere la dichiarazione onesta — ogni modulo del pannello
deve comparire, e ogni campo citato deve esistere davvero nella configurazione.

Il risultato si legge in due posti, dalla stessa funzione: un riquadro in cima alla
**Configurazione**, che si aggiorna mentre modifichi invece di aspettare il salvataggio, e il
comando **`/diagnosi`** su Discord.

Nessun controllo impedisce di salvare. Una configurazione incoerente è spesso un passaggio
intermedio verso quella giusta, e un pannello che blocca a metà strada costringe a fare tutto in un
colpo solo o a rinunciare.

### Il filtro sul linguaggio

Arriva con **718 espressioni** divise in sette categorie — volgarità, insulti, discriminazione,
minacce, istigazione all'autolesionismo, bestemmie, contenuto sessuale — ognuna con la sua gravità e
il suo interruttore. Il contenuto sessuale parte spento: su un server di adulti la conversazione può
essere legittima.

Il confronto è per parola intera e passa da una normalizzazione: `c a z z o`, `c-a-z-z-o` e
`di0p0rc0` vengono riconosciuti senza doverli elencare. Le **eccezioni** vincono sempre, ed è metà
del lavoro: un filtro che blocca chi parla di edilizia (`cazzuola`) o nomina una città (`Cagliari`)
insegna in un pomeriggio che il bot va ignorato.

Restano fuori di proposito parole che senza contesto non si possono giudicare: `muori` (muori dal
ridere), `crepa` (una crepa nel muro), `sega` (l'attrezzo), `figa` (in mezza Italia significa
«bello»). Ogni falso positivo costa più di ciò che il blocco guadagna.

**Aggiungerne è la cosa che si fa più spesso**, quindi si fa in due modi:

- da Discord, nel momento in cui la parola compare: `/parole aggiungi parola:tizio, caio
  categoria:Insulto gravita:media`, e poi `/parole togli`, `/parole consenti` per le eccezioni,
  `/parole cerca`, `/parole elenco` per il conto per categoria;
- dal pannello, in *Sicurezza → Linguaggio*: ricerca, filtro per categoria, aggiunta in cima e un
  campo per incollare venti parole in una volta.

`/prova-filtro` mostra cosa verrebbe riconosciuto in un testo senza sanzionare nessuno — utile
perché in chat amministratori e proprietari del bot sono esenti, cioè proprio chi vorrebbe provarlo.

#### Se il bot è installato da tempo, le parole nuove non ti arrivano

I valori predefiniti valgono **solo per le configurazioni nuove**. Su un server configurato mesi fa
l'elenco salvato resta quello di allora: le voci aggiunte al bot nel frattempo non compaiono, e non
c'è modo di accorgersene se non notando che una parola non viene riconosciuta.

Si rimedia con **`/parole aggiorna`**, o con il pulsante nel pannello che dice quante ne mancano. Le
tue restano come le hai messe: nessuna gravità e nessuna categoria vengono cambiate.

#### Elenchi come file

Il formato è in [`elenchi/`](../elenchi/), con il file `italiano-base.elenco` che contiene tutte le
voci predefinite. Si legge a occhio, si commenta, si tiene sotto controllo di versione:

```
@categoria MINACCIA
@gravita GRAVE
ti ammazzo
ti trovo

porco dio | BESTEMMIA | GRAVE
```

Si importa con `/parole importa` allegando il file, o dal pannello; si esporta con
`/parole esporta`. Una riga sbagliata viene saltata e riportata con il suo numero invece di far
fallire tutto: un file di trecento parole che non si importa per un refuso alla riga 118 è un file
che si smette di usare.

### Anti-flame

Il filtro delle parole guarda un messaggio alla volta; il flame non è un messaggio, è uno scambio. La
prima risposta non è una sanzione ma un **rallentamento del canale**: silenziare i due che litigano
punisce chi ha risposto quanto chi ha cominciato, mentre rallentare toglie alla spirale proprio ciò
di cui si nutre, la rapidità.

Il riconoscimento non passa dalle parolacce ma dal **modo** — la differenza fra «che schifo di
partita» e «fai schifo». Il vocabolario stava scritto nel codice; ora è configurabile, ed è giusto
che lo sia: un modulo che decide di rallentare un canale in base a un elenco che nessuno può vedere
è un modulo di cui non ci si fida.

Si regolano le espressioni riconosciute, quanto pesa ciascun segnale (frase rivolta a una persona,
messaggio urlato, menzione del destinatario, punteggiatura concitata) e — cosa che prima non
esisteva — le **frasi di tregua**: «scusa», «hai ragione», «lasciamo perdere» abbassano il
punteggio. Senza, il messaggio con cui qualcuno prova a rimediare contava come un colpo in più, e
l'intervento arrivava proprio mentre la discussione stava rientrando da sola.

### Link e GIF: dove sì e dove no

Va detto perché genera confusione: **i link non sono vietati.** Vengono tolti solo quando sono
pericolosi — dominio in blocklist, phishing riconosciuto, invito verso un server sconosciuto,
link a un eseguibile sulla CDN di Discord — e quel controllo vale in ogni canale, ticket compresi.

Chi invece vuole decidere *dove* si possono mettere link e GIF ha un modulo apposta,
**Sicurezza → Link e GIF**, spento di partenza. Serve per il canale annunci che non deve riempirsi
di link e per la chat che non deve diventare un muro di GIF: si indicano i canali dove sono
ammessi, e altrove il messaggio viene tolto con una spiegazione che sparisce da sola.

Non è una difesa e non si comporta come tale: nessun punteggio di rischio, nessuna sanzione che si
accumula. Chi incolla un link nel canale sbagliato non è un aggressore.

Tre cose da sapere:

- **Nei ticket si può sempre**, salvo spegnere l'opzione. Chi apre un ticket sta descrivendo un
  problema, e la prova è quasi sempre uno screenshot o un link: vietarli lì impedisce di spiegarsi
  nel posto nato apposta.
- I link a **Tenor e Giphy** valgono come GIF, non come link — altrimenti finirebbero tolti proprio
  dal canale delle GIF.
- I **domini di casa** (il proprio sito, la wiki del server) si mettono fra quelli ammessi ovunque.

Lasciando vuoti entrambi gli elenchi di canali non succede nulla: è il modo di tenere il modulo
acceso senza vietare niente.

### AutoMod nativo: l'unica difesa che arriva prima del messaggio

Un bot vede un messaggio solo **dopo** che esiste; l'AutoMod di Discord lo intercetta durante
l'invio. Per il contenuto noto in anticipo — domini di phishing, termini vietati — quella manciata
di millisecondi è la differenza fra «nessuno l'ha visto» e «l'hanno letto in trenta».

ANGEL tiene sincronizzate le regole native a partire dalle proprie blocklist (`/audit`, oppure dal
pannello). Gestisce solo le regole che ha creato lui, riconoscibili dal prefisso `[ANGEL]`: quelle
scritte a mano dallo staff non vengono mai toccate.

Il caso più interessante è la regola sul **profilo utente** con azione `BlockMemberInteraction`:
Discord mette in quarantena chi ha un nickname vietato — «Discord Staff», «Moderatore ufficiale» —
prima ancora che possa scrivere o entrare in vocale. Nessun bot può arrivare così presto.

### Nota tecnica onesta sulle immagini

Un PNG o un JPG su Discord **non esegue codice**. Le immagini delle campagne scam sono contenitori
di *link*: testo sovrimpresso, QR, o il messaggio che le accompagna. Perciò lo scanner non cerca un
virus nei pixel — estrae ogni URL visibile o codificato, ne verifica la reputazione, e riconosce la
campagna con l'hash percettivo. Per gli **allegati non-immagine** il controllo è invece
sostanziale: magic bytes, estensione doppia, polyglot, eseguibili dentro gli archivi.


---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

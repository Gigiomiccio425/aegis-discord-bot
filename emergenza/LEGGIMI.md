# Nodo di emergenza

Copia locale di ANGEL che gira sul tuo PC Windows e prende il posto del server
solo quando la VPS non risponde. Si spegne appena il server torna.

---

## La regola che governa tutto

**Il server principale ha sempre la priorità.**

Non è una preferenza: è un vincolo tecnico. Due bot collegati a Discord con lo
stesso token ricevono entrambi gli stessi eventi e agiscono entrambi — ogni
sanzione applicata due volte, ogni messaggio del bot pubblicato due volte, ogni
riga di registro doppia.

Per questo il nodo locale:

- **non si accende** finché il principale risponde;
- **si spegne da solo** appena torna, senza chiedere conferma — nel tempo che
  ci vorrebbe a rispondere, il danno sarebbe già fatto;
- lasciato in esecuzione in background non fa nulla se non un controllo ogni
  mezz'ora.

---

## Se il bot è tuo e vuoi la cartella già pronta

Questa è la versione generica, con i segnaposto: serve a chiunque prenda il
progetto per il proprio bot.

Chi mantiene il progetto tiene accanto una copia già compilata — la cartella
`emergenza-mia/`, esclusa da git — generata da questa sostituendo i segnaposto.
È una copia derivata di proposito: due cartelle mantenute in parallelo
divergono sempre, e ci si accorge della differenza nel momento peggiore, cioè
con il server giù.

---

## Preparazione, una volta sola

**1.** Installa [Docker Desktop](https://www.docker.com/products/docker-desktop/)
e avvialo. Deve essere in esecuzione perché il nodo possa partire.

**2.** Apri `impostazioni.txt` e metti l'indirizzo del tuo server al posto del
segnaposto. Deve essere raggiungibile da questo PC: se passa da Tailscale o da
una VPN, assicurati che siano connessi — altrimenti il sorvegliante
concluderebbe che il server è giù ogni volta che il tunnel non è attivo.

**3.** **Copia** `docker-compose.emergenza.yml` in
`docker-compose.emergenza.local.yml`, e compila i valori in cima **nella
copia**.

Il file con `.local` è escluso da git e ha la precedenza; l'originale resta il
modello con i segnaposto. Compilare direttamente il modello significherebbe
ritrovarsi il token del bot in un commit.

Il **token**, il **client id** e il **client secret** sono gli stessi del
server. Anche `SESSION_SECRET` ed `ENCRYPTION_KEY` devono essere identici:
la seconda cifra i dati salvati nel database, e con una chiave diversa
l'esportazione non sarebbe rileggibile al rientro.

La password del database locale invece è una qualunque: quel database vive e
muore su questo PC.

**4.** Doppio clic su `angel-emergenza.bat` e scegli **1** per un primo
controllo. Se il server è su, deve dire che il nodo resta fermo.

---

## Uso quotidiano

| Come | Cosa fa |
|---|---|
| Doppio clic sul `.bat` | Apre il menu |
| `angel-emergenza.bat /auto` | Sorveglianza continua, nessuna domanda |
| `angel-emergenza.bat /stato` | Un controllo solo, poi chiude |

Per lasciarlo attivo sempre, metti un collegamento a
`angel-emergenza.bat /auto` nella cartella Esecuzione automatica: premi
`Win+R`, scrivi `shell:startup`, e trascina lì il collegamento.

### Quando controlla

- all'avvio del bat;
- ogni **30 minuti** mentre il server principale funziona;
- ogni **2 minuti** mentre il nodo di emergenza sta lavorando;
- quando lo chiedi tu, dal menu.

Il ritmo è diverso di proposito: a riposo non c'è fretta, in emergenza il
ritardo è la finestra in cui entrambi i nodi potrebbero risultare attivi.

---

## Cosa succede quando la VPS cade

1. Tre controlli falliti di fila — non uno, perché un pacchetto perso o un
   riavvio del bot non sono un guasto.
2. Il nodo locale si accende. Il bot torna online su Discord in una decina di
   secondi, con la configurazione predefinita.
3. Da qui in poi modera, registra e archivia sul database locale.
4. Il pannello del nodo è su `http://localhost:781`.

**Cosa il nodo non fa:** annunci Twitch e YouTube restano spenti. Sono
integrazioni che al rientro il principale ripubblicherebbe, e nessuno vuole
l'annuncio della stessa diretta due volte.

---

## Quando la VPS torna

Il sorvegliante se ne accorge entro due minuti e:

1. chiede al nodo di **esportare** ciò che ha raccolto, in `dati\angel-<data>`;
2. **spegne** il nodo;
3. ti dice come riportare i dati sul server.

### Il rientro non è automatico

È una scelta. Importare significa **scrivere nel registro del server
principale**: righe di provvedimenti, eventi, messaggi archiviati. Va fatto da
chi sa cosa è successo mentre era giù, non da uno script che nel dubbio importa
tutto.

Dal pannello del server: **Strumenti → Rientro dal nodo di emergenza**, e
carichi la cartella indicata.

### Cosa viene importato, e cosa no

**Sì**, perché sono righe che nascono e non cambiano più — unirle non ha
ambiguità: registro eventi, provvedimenti, incidenti, messaggi archiviati,
sessioni vocali.

**No**: configurazione, profili utente, sessioni del pannello. Sono le uniche
cose che entrambi i nodi possono aver modificato nello stesso periodo, e non
esiste un criterio corretto per decidere quale versione vince. Se hai cambiato
una configurazione mentre eri in emergenza, rifalla sul principale: sono due
minuti, e sono due minuti che valgono meno del rischio di sovrascrivere le
modifiche fatte nel frattempo.

---

## Se il server risponde ma non funziona

Capita: `/health` risponde e il bot non modera più niente. Il sorvegliante non
può accorgersene — vede una risposta e conclude che va tutto bene.

Per questo esiste l'**accensione forzata** (voce 3 del menu). Chiede di
scrivere `ACCENDI` per esteso quando il principale risulta vivo, perché quella
è la situazione in cui si ottengono davvero due bot attivi insieme.

In quel caso: spegni prima il container sulla VPS, poi accendi il nodo.

---

## File di questa cartella

| File | Cosa fa |
|---|---|
| `angel-emergenza.bat` | Quello da avviare |
| `sorveglia.ps1` | La logica: controlli, accensione, spegnimento |
| `impostazioni.txt` | Indirizzo del server, tempi, tentativi |
| `docker-compose.emergenza.yml` | Il modello, con i segnaposto |
| `docker-compose.emergenza.local.yml` | La tua copia compilata — **contiene le credenziali**, fuori da git |
| `dati\` | Le esportazioni da riportare sul server |
| `sorveglianza.log` | Cosa è successo e quando |

La copia `.local` contiene le stesse credenziali del server: resta fuori da git,
come il compose della VPS.

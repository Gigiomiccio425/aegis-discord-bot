# Tornare indietro, e rifare un passo alla volta

Questo documento elenca **tutto** quello che è cambiato da `1.27.2` — l'ultima
immagine che ha girato sulla tua macchina prima del 20 settembre — fino a
`1.30.0` di adesso. Serve a due cose: decidere dove tornare, e poi rimettere
i pezzi uno alla volta sapendo cosa sono.

---

## Dove siamo, in numeri

| | |
|---|---|
| Da | `1.27.2` · commit `6096639` · **4 settembre 2026, 23:17** |
| A | `1.30.0` · commit `6a5f110` · **21 settembre 2026, 10:56** |
| Commit in mezzo | **34** |
| File toccati | **126** |
| Righe | **+11 787 / −2 328** |

---

## La data che hai indicato

Hai scritto *«la versione precedente a dell'ultima prima del 18/09/2026 20:02»*.

Nel repository **non c'è niente datato 18 settembre**: fra il 5 e il 19
settembre non è stato scritto un commit, e fra il 4 e il 20 settembre non è
stata pubblicata un'immagine.

Quindi il 18 settembre, sulla tua macchina, stava girando questa:

| Immagine | Pubblicata | Che cos'è |
|---|---|---|
| **`1.27.2`** | 4 set, 21:29 UTC | **L'ultima prima del 20 settembre.** È quella che avevi installata il 18 |
| `1.24.0` | 2 set, 01:38 UTC | Quella prima ancora |
| `1.28.0` | 20 set, 02:51 UTC | La prima del blocco nuovo |

Se «l'ultima prima del 18/09» significa *l'ultima che avevi installato*, il
bersaglio è **`1.27.2`**. Se invece intendevi letteralmente *quella prima
ancora*, è **`1.24.0`**, che però è più vecchia di due giorni e non cambia
niente di sostanziale.

**La mia lettura: `1.27.2`.** È l'ultimo stato che ha funzionato per due
settimane di fila.

---

## Cosa è cambiato, in ordine

### Blocco A — umbrelOS (5 settembre) · 5 commit

Precede tutto il resto di due settimane. Queste modifiche **non hanno mai
girato in un'immagine**: la 1.27.2 è stata l'ultima pubblicata prima di esse.

| Commit | Cosa |
|---|---|
| `836f64d` | App per lo store di umbrelOS |
| `c4912a7` | L'app aveva tre nomi diversi e umbrelOS la rifiutava |
| `da96e8e` | Il repository chiamava l'app in un modo, la macchina in un altro |
| `aedfdb8` | «bot: non risponde» accusava il container sbagliato |
| `e215a9c` | L'avviso sulle versioni restava fermo al caricamento della pagina |

**Rischio di averlo perso:** nessuno per il funzionamento del bot. Riguarda
solo come umbrelOS trova e nomina l'app.

---

### Blocco B — il grande cambio (19–20 settembre) · 7 commit → `1.28.0`

**È qui che l'architettura è cambiata.** Se qualcosa ha rotto i comandi del
pannello, il sospettato principale è questo blocco.

| Commit | Cosa | Perché è delicato |
|---|---|---|
| `db57a05` | Lockdown: chiude anche le chat delle vocali | Tocca i permessi dei canali |
| `e4375e9` | **I comandi al bot non si perdono più, e l'esito torna al pannello** | **Ha sostituito il pub/sub Redis con uno stream e gruppi di consumo.** È il meccanismo che oggi non consegna |
| `5876ede` | Una lettura vecchia non riscrive più la cache dopo un salvataggio | Tocca la cache della configurazione |
| `e2999cf` | I due pannelli non si fidano più dell'altra porta, e l'accesso segue Discord | Tocca l'autenticazione |
| `0b841fb` | Un secondo modello di server, «yuyu» | Aggiunta isolata, nessun rischio |
| `aef42c0` | Lo scanner non segue più i link verso la rete interna | Correzione SSRF, isolata |
| `d3346e8` | Rilascio 1.28.0 | Solo numeri di versione |

> **Il cambio che conta è `e4375e9`.** Prima, il pannello chiedeva al bot con
> un `PUBLISH` Redis: se il bot non era in ascolto in quell'istante, il
> comando spariva — **rumorosamente**, perché nessuno prometteva niente.
> Dopo, il comando entra in uno stream e ci resta finché il bot non lo
> conferma. Se la consegna si inceppa, il comando **non si perde: resta lì**,
> e il pannello dice «ci sto lavorando» per sempre.
>
> È esattamente il sintomo che vedi.

---

### Blocco C — i segreti fuori dal compose (20 settembre) · 8 commit → `1.29.x`

| Commit | Cosa |
|---|---|
| `78da3a7` | I valori si scrivono una volta, non a ogni aggiornamento |
| `5b209e8` | Anche `PUBLIC_URL` nel file dei segreti |
| `4b723d6` | Script di travaso dal compose al file |
| `e0826be` | Documentazione del travaso |
| `3e6af44` | **Niente dati sensibili nel compose, il container aspetta** |
| `f64a953` | Il log dice perché la cartella non scrivibile ferma Postgres |
| `505b21c` | Il `chown` va sulla cartella dei segreti, non su tutta `data` |
| `45c9b61` | La cartella dei segreti nasce scrivibile, senza `chown` a mano |

**Rischio:** tornare indietro qui significa **rimettere i segreti nel
compose**, che umbrelOS riscrive a ogni aggiornamento. Torneresti a doverli
reinserire ogni volta. Non è la causa dei comandi fermi: i segreti vengono
letti correttamente, e il log lo conferma a ogni avvio.

---

### Blocco D — inseguendo il guasto (21 settembre) · 10 commit → `1.29.3…1.29.8`

Tutto quello fatto stanotte cercando la causa. **Nessuno di questi ha
introdotto il problema: sono tentativi di trovarlo**, alcuni riusciti.

| Commit | Cosa | Ha risolto qualcosa? |
|---|---|---|
| `22b2bd0` | Un comando non confermato non fa rieseguire tutti gli altri | **Sì**, verificato nei tuoi log: lo snapshot ogni 2 secondi è sparito |
| `5b20bda` | Gli snapshot non sono minacce | **Sì**, il contatore è tornato a 0 |
| `b5e2b22` | I guasti di Redis non spariscono più in silenzio | Diagnosi |
| `483dc81` | Una consegna che non finisce non ferma tutte le altre | Probabile, non verificato |
| `0cff013` | Ogni `Worker` la sua connessione Redis | Probabile, non verificato |
| `a80a720` | Un ciclo bloccato non si confonde con Redis | Diagnosi |
| `6a5f110` | Tre silenzi fra pannello e bot | Diagnosi |
| `81ec4fe`, `2cf7ff7`, `0c797be` | Numeri di versione e note | Niente |

---

### Blocco E — documentazione e copia leggera (20–21 settembre) · 4 commit → `1.30.0`

| Commit | Cosa |
|---|---|
| `aa2d467` | README spezzato in 15 pagine sotto `docs/`, più licenza e file di servizio |
| `23e2f72` | Note di rilascio |
| `4a820aa` | Formato della copia leggera |
| `a005248` | La copia leggera arriva su Discord e da lì si rimette |

**Rischio:** nessuno per il funzionamento. Sono documentazione e una funzione
nuova che parte spenta.

---

## Cosa perderesti tornando a `1.27.2`

Tutto quello sopra. In pratica, le cose che contano:

| Perdi | Peso |
|---|---|
| I segreti fuori dal compose | **Alto.** Torni a reinserirli a ogni aggiornamento |
| Lockdown sulle chat delle vocali | Medio |
| Le due correzioni di sicurezza (SSRF, accesso ai pannelli) | **Alto** |
| Il modello «yuyu» | Basso, si rifà |
| La copia leggera su Discord | Basso, è nuova e spenta |
| Documentazione e store aggiornati | Basso |
| **La consegna affidabile dei comandi** | **Torni al pub/sub: i comandi si perdono di nuovo, ma in modo visibile** |

E **guadagni** il ritorno a uno stato che sai aver funzionato per due
settimane.

---

## Un'alternativa che vale la pena considerare

Riavvolgere tutto rimette anche i problemi che quelle 34 modifiche hanno
risolto, e ne rimette due di sicurezza.

C'è una strada più corta verso la stessa risposta: **tornare indietro solo
`e4375e9`**, cioè il passaggio da pub/sub a stream. È il sospettato numero
uno, è il solo cambio architetturale del gruppo, e isolarlo risponde alla
domanda in un colpo:

- se i comandi ricominciano a funzionare → la causa è lì, e la si affronta
  sapendo esattamente dove;
- se restano fermi → la causa **non** è lì, e il sospettato principale è
  escluso senza perdere nient'altro.

Non è un argomento contro il riavvolgimento. È che la stessa domanda si può
fare con un taglio piccolo invece che con uno grande, e il taglio grande
resta disponibile dopo.

---

## Come si torna indietro, in concreto

Qualunque sia la scelta, **niente viene cancellato**: si crea un ramo nuovo
dal punto scelto, e `main` resta dov'è.

```bash
# Il ramo di lavoro, dal punto scelto
git switch -c ripartenza v1.27.2

# main resta intatto: ci si torna quando si vuole
git switch main
```

Per far girare quel codice sulla macchina basta riportare l'app store a
`1.27.2`: l'immagine **esiste ancora** su ghcr, non va ricostruita.

---

## Poi: un passo alla volta

L'ordine dal meno rischioso al più:

1. **Segreti fuori dal compose** (blocco C). Indipendente da tutto, e toglie
   il fastidio di reinserirli.
2. **Le due correzioni di sicurezza** (`e2999cf`, `aef42c0`). Isolate.
3. **Lockdown sulle vocali** (`db57a05`). Isolata.
4. **La consegna dei comandi** (`e4375e9`), da sola, e **si prova subito**:
   premi un pulsante e guardi se succede. È il pezzo da verificare con
   attenzione, perché è quello sotto accusa.
5. Il resto: modello yuyu, documentazione, copia leggera.

A ogni passo: aggiorni, provi un comando dal pannello, e o va o si sa
esattamente quale passo l'ha rotto.

---

## Quello che non so

Non ho dimostrato che `e4375e9` sia la causa. È il sospettato più forte per
tre ragioni — è l'unico cambio architetturale, è nell'unico percorso che non
funziona, e il sintomo («in coda per sempre») è esattamente ciò che quel
meccanismo rende possibile — ma **non l'ho provato**, e le ultime versioni
hanno aggiunto diagnostica proprio per poterlo provare al prossimo avvio.

C'è anche la strada opposta: aggiornare alla `1.30.0`, leggere una riga di
log, e **poi** decidere se riavvolgere sapendo cosa cercare.

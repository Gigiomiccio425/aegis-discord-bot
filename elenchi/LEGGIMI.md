# Elenchi di parole

File di testo che si leggono a occhio, si commentano, si tengono sotto controllo di versione e si
importano nel bot senza toccare la configurazione a mano.

Servono a tre cose che il JSON della configurazione non copre: portare un elenco da un server
all'altro, scriverlo in più persone, e allineare un server configurato mesi fa alle voci aggiunte nel
frattempo — perché i valori predefiniti valgono **solo** per le configurazioni nuove.

---

## Formato

```
# Le righe che iniziano con # sono commenti.
# Le direttive valgono da dove compaiono fino alla successiva.

@categoria INSULTO
@gravita MEDIA

scemo
imbecille
testa di rapa

# Una riga può dichiarare tutto da sola, e in quel caso vince sulle direttive:
ti ammazzo | MINACCIA | GRAVE
porco dio  | BESTEMMIA | GRAVE
```

**Categorie**: `VOLGARITA`, `INSULTO`, `DISCRIMINAZIONE`, `MINACCIA`, `AUTOLESIONISMO`,
`BESTEMMIA`, `SESSUALE`.

**Gravità**: `LIEVE`, `MEDIA`, `GRAVE`.

Senza direttive né colonne, una riga vale `INSULTO` / `MEDIA`.

Una riga sbagliata **non ferma l'importazione**: viene saltata e riportata con il suo numero, il
resto entra lo stesso. Un file di trecento parole che non si importa perché la riga 118 ha un refuso
è un file che si smette di usare.

---

## Importare

| Da dove | Come |
|---|---|
| Discord | `/parole importa` con il file allegato |
| Pannello | *Sicurezza → Linguaggio*, pulsante **Importa da file** |
| Aggiornare alle voci nuove del bot | `/parole aggiorna`, o il pulsante nel pannello |

**Le voci già presenti non vengono toccate**, nemmeno se il file in arrivo dà loro una gravità
diversa. Chi ha abbassato `cazzo` a lieve sul proprio server lo ha fatto apposta, e
un'importazione che rimette tutto «come dovrebbe essere» è un'importazione che nessuno rifà una
seconda volta.

Esportare l'elenco corrente: `/parole esporta`, che restituisce un file in questo stesso formato.

---

## I file qui dentro

| File | Cosa contiene |
|---|---|
| `italiano-base.elenco` | Le 718 voci che un server nuovo si trova già dentro |

---

## Scriverne uno

Tre criteri, gli stessi con cui è stato costruito l'elenco di base. Valgono più delle parole che ci
si mette dentro:

1. **È offensivo fuori contesto?** Se serve il contesto, non entra: il filtro il contesto non ce
   l'ha. `muori` è fuori perché esiste «muori dal ridere»; `vai a morire` è dentro.
2. **Esiste una parola legittima che lo contiene?** `cazzuola`, `Cagliari`, `finocchietto`,
   `analisi`. O si aggiunge l'eccezione, o la voce resta fuori.
3. **La gravità corrisponde a ciò che faresti davvero?** Un'imprecazione e un insulto razzista non
   meritano la stessa risposta, e metterli allo stesso livello significa o punire troppo o non
   punire affatto.

Non serve elencare le varianti scritte storte: prima del confronto il testo viene normalizzato, e
`c a z z o`, `c-a-z-z-o`, `di0p0rc0` e `CAZZOOOO` arrivano tutti alla stessa forma. Servono invece
le varianti vere della lingua — maschile e femminile, singolare e plurale — e, per le bestemmie, la
forma unita: `dioporco` non si ricava da `dio porco`, perché unire due parole non è un'evasione ma
un modo di scriverle.

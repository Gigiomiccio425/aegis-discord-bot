# Altre funzioni

## Notifiche da fonti esterne

Twitch, YouTube e qualunque feed RSS/Atom. Tutte funzionano leggendo un documento pubblico: niente
chiavi API, niente quote, niente token da rinnovare.

**Perché non ci sono TikTok, Instagram e X.** Non offrono un modo pubblico e stabile di leggere i
contenuti: le opzioni sarebbero scraping fragile o servizi a pagamento. Un'integrazione che si
rompe da sola dopo tre settimane è peggio della sua assenza, perché nel frattempo si smette di
controllare a mano. Dove esiste un feed RSS — e ne esistono per moltissime fonti — il modulo
generico copre già tutto.

Due protezioni che contano più della logica di pubblicazione:

- **Nessun diluvio alla prima lettura.** Un feed appena aggiunto contiene quindici elementi già
  vecchi: la prima volta si registra soltanto il più recente, senza annunciare nulla.
- **Le fonti morte si mettono in pausa da sole.** Dopo dieci errori consecutivi si smette di
  interrogarle: un feed inesistente letto ogni dieci minuti per mesi è traffico sprecato e rumore.

Il confronto per capire cosa è nuovo usa l'**identificativo**, non la data: i feed hanno date
inaffidabili — fusi sbagliati, aggiornamenti che ne cambiano il valore, elementi ripubblicati.

---
## Bacheca e ticket

**Bacheca** — i messaggi che raccolgono abbastanza reazioni finiscono in un canale dedicato.
Sembra una funzione frivola, ma sposta l'attenzione su ciò che il server vuole premiare invece che
solo su ciò che va punito. L'autovoto è disattivo per impostazione predefinita: altrimenti bastano
quattro amici e l'autore per arrivare a cinque, e la bacheca smette di dire qualcosa.

**Ticket** — assistenza privata in un canale creato al momento, non nei DM. La differenza non è di
comodità: nei DM non c'è registro, non c'è passaggio di consegne fra moderatori, e soprattutto
**nessuno può verificare chi sta scrivendo** — che è esattamente il terreno di chi si finge staff.

L'apertura passa da una finestra modale che chiede l'oggetto *prima* di creare il canale, così non
si accumula una fila di ticket vuoti intitolati «aiuto». I permessi del canale sono espliciti e non
ereditati dalla categoria: ereditarli renderebbe la riservatezza dipendente da una configurazione
altrove, che è il modo classico in cui un ticket privato smette di esserlo.

Alla chiusura viene generata la trascrizione HTML, inviata in privato a chi ha aperto il ticket e
allegata al registro; poi il canale viene eliminato dopo dieci secondi, il tempo di leggere il
messaggio di chiusura. I ticket senza attività si chiudono da soli: uno dimenticato aperto per
settimane è rumore che nasconde quelli veri.

### La trascrizione

Contiene la conversazione intera — messaggi, immagini, video, link, allegati eliminati — e in cima
la scheda del ticket: numero, oggetto, chi lo ha aperto, **chi lo ha preso in carico e quando**,
**chi lo ha chiuso, quando e con quale motivazione**, la durata, chi è stato invitato nel canale e
quante righe ha scritto ciascun partecipante.

Va in tre posti, perché ognuno dei tre può sparire da solo:

| Dove | Perché |
|---|---|
| In privato a chi ha aperto | È la sua conversazione: senza copia resterebbe con nulla in mano |
| Nel canale `angel-trascrizioni`, creato con gli altri alla predisposizione | È l'archivio che lo staff consulta senza aprire il pannello |
| Su disco sulla VPS, sotto `STORAGE_DIR/trascrizioni/<server>/` | Un allegato Discord vive finché vive il messaggio, e un messaggio si può cancellare |

Vale anche quando il canale del ticket viene **eliminato** invece che chiuso: ANGEL se ne accorge,
chiude il ticket con motivazione automatica e produce comunque la trascrizione. È il caso che conta
di più — eliminare il canale è esattamente ciò che si fa quando si vuole che una conversazione non
esista più. La ricostruzione parte dall'archivio dei messaggi, non dal canale, e quindi non dipende
dal canale essendo ancora lì.

Dal pannello, sezione **Ticket e trascrizioni**, si rilegge tutto: serve il ruolo `MOD`, non i
permessi Discord.


---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

# Aggiornare

## Aggiornare

**Una riga, un riavvio.** Nel compose la versione compare in un punto solo:

```yaml
image: ghcr.io/gigiomiccio425/aegis-discord-bot:1.1.2
```

Cambiala e riavvia l'app. Non c'è altro da toccare.

Un tag preciso resta fermo finché non lo cambi tu, ed è la scelta giusta se preferisci decidere
quando aggiornare invece di scoprirlo dopo un riavvio. `:latest` aggiorna a ogni ricreazione.

---

### I dati restano

Nessun aggiornamento tocca i dati. Vivono nei volumi Docker, che sopravvivono alla ricreazione del
container: registro eventi, configurazione, snapshot, archivio messaggi, casi, profili di rischio.

Lo schema lo allinea il supervisore all'avvio con `prisma migrate deploy`: applica solo le
migrazioni mancanti, non fa nulla se sono già tutte presenti, e i tre processi partono solo dopo
che ha finito. Non esiste il momento in cui il codice nuovo parla a uno schema vecchio.

---

### Sapere cosa sta girando

La versione è scritta nell'immagine dalla CI e compare in fondo alla colonna di sinistra del
pannello. Se su GitHub esiste una release più recente, al suo posto appare un avviso con il numero
della nuova versione e il link alle note. Il confronto lo fa l'API, con la risposta di GitHub in
cache per sei ore.

### Tornare indietro

Rimetti la versione precedente nella riga `image:`, `docker compose up -d`, e se quella versione
aveva uno schema diverso ripristina il dump corrispondente — il comando esatto lo stampa
`aggiorna.sh` alla fine di ogni esecuzione.

---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>

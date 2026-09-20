# Il pacchetto per umbrelOS

Questa cartella **non è** lo store: è la sorgente da cui lo store viene aggiornato. Lo store
pubblico è [Gigio-dany-appstore](https://github.com/Gigiomiccio425/Gigio-dany-appstore), e la
guida per chi installa sta in
**[docs/installazione-umbrel.md](../docs/installazione-umbrel.md)**.

Qui c'è solo quello che serve a chi pubblica una versione nuova.

## Cosa va dove

Il contenuto di questa cartella va nella **radice** dello store, non dentro una sottocartella:

```
Gigio-dany-appstore/
  umbrel-app-store.yml
  g-d-app-store-gd-angel/
    umbrel-app.yml
    docker-compose.yml
```

Il nome della cartella dell'app **deve** cominciare con l'`id` dello store (`g-d-app-store`), ed è
anche il prefisso con cui compose battezza i container — quindi la stringa che finisce in
`APP_HOST`. Rinominarla senza aggiornare `APP_HOST` produce un'app che si installa, parte, e
mostra una pagina bianca.

## Pubblicare una versione

Tre passaggi, in quest'ordine. L'ordine conta: invertire i primi due fa proporre a umbrelOS un
aggiornamento verso un'immagine che non esiste ancora.

1. **Allinea i due numeri** nel repository del bot: `version:` in `umbrel-app.yml` e il tag
   dell'immagine in `docker-compose.yml`. Sono scritti in due file diversi e devono combaciare —
   c'è un test che lo verifica, perché cambiarne uno solo produce un aggiornamento che dice di
   aver funzionato senza fare niente.
2. **Aspetta che la CI pubblichi l'immagine** su ghcr. Solo dopo:
3. **Copia i due file** in `Gigio-dany-appstore/g-d-app-store-gd-angel/` e spingi.

## Cosa il test tiene fermo

`packages/shared/src/__tests__/umbrel.test.ts` confronta questi file fra loro e con il manifesto.
Niente di ciò che verifica lo controlla umbrelOS: l'app si installa lo stesso e fallisce dopo, in
modi che non assomigliano alla causa.

| Invariante | Cosa succede se salta |
|---|---|
| `APP_HOST` = `<id-app>_<servizio>_1` | L'app parte e mostra una pagina bianca |
| `version` = tag dell'immagine | Un aggiornamento che non scarica niente, o un'immagine nuova che si dichiara vecchia |
| Nessun valore sensibile nel compose | Token in chiaro in un file che l'aggiornamento riscrive |
| `POSTGRES_PASSWORD_FILE` e il mount `:ro` | Postgres esce in ciclo: `No such file or directory` |
| Il servizio `preparasegreti` con il suo `chown` | Su un'installazione nuova la password non nasce, e Postgres non parte |
| I volumi sotto `${APP_DATA_DIR}` | Percorsi che funzionano finché qualcuno non sposta i dati |
| Redis: `noeviction`, AOF spento | Lavori in coda persi senza un errore; «fsync is taking too long» a ripetizione |

## Perché nel compose non c'è nessun segreto

Due motivi indipendenti, ognuno sufficiente.

**Sparirebbero.** umbrelOS riscrive il compose dallo store a ogni aggiornamento: quello che ci si
scrive a mano dura fino al prossimo.

**GitHub rifiuta il push.** La protezione contro i segreti riconosce il formato di un token
Discord e blocca con `GH013` prima ancora che il file arrivi nella repository:

```
remote: - GITHUB PUSH PROTECTION
remote:     Push cannot contain secrets
remote:   —— Discord Bot Token ——
```

Provato: rifiutato. E forzando con il link di sblocco resterebbe il problema vero — Discord
analizza GitHub in cerca di token e revoca quelli che trova.

## Differenze dal compose di ZimaOS

| | ZimaOS | umbrelOS |
|---|---|---|
| Pubblicazione | `ports: 780:8080` | `app_proxy` con `APP_HOST`/`APP_PORT` |
| Dati | `/DATA/AppData/Angel/…` | `${APP_DATA_DIR}/data/…` |
| Segreti | `.env` accanto al compose | `data/segreti/`, fuori dal repository |
| Copie | `/DATA/angel-backup`, fuori dai volumi | dentro i dati dell'app — **sparisce se disinstalli** |
| Redis | `volatile-lru`, AOF acceso | `noeviction`, AOF spento |

Le copie sono la differenza che conta. Su ZimaOS stavano fuori dai volumi apposta: disinstallando
l'app i volumi spariscono, e una copia che sparisce insieme a ciò che protegge non protegge nulla.
Su umbrelOS l'app scrive solo dentro `${APP_DATA_DIR}`, quindi quella garanzia non c'è —
**scarica il kit dal pannello ogni tanto** e tienilo su un'altra macchina.

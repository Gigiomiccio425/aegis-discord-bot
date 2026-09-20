# Contribuire

## Prima di tutto

Se hai trovato una vulnerabilità, **[SECURITY.md](SECURITY.md)** — non una issue.

Per tutto il resto: le issue sono benvenute, anche solo per dire che qualcosa non si capisce. Una
documentazione poco chiara è un difetto come gli altri.

## Aprire una issue

Dì **cosa ti aspettavi** e **cosa è successo**. Se riguarda il bot in funzione, servono anche la
versione (`/versione`, o il piè di pagina del pannello) e le righe di log intorno al problema —
senza token né ID di server, che dai log si tolgono facilmente.

Un falso positivo di un rilevatore è una issue legittima e utile: allega il messaggio o
l'immagine che è stata sanzionata per sbaglio.

## Preparare l'ambiente

```bash
npm ci
docker compose up -d postgres redis   # solo Postgres e Redis
npm run db:migrate
npm run dev:api                                   # oppure dev:bot, dev:worker, dev:web
```

Dettagli: **[docs/sviluppo.md](docs/sviluppo.md)**.

## Prima di aprire una pull request

Tre comandi, tutti e tre verdi:

```bash
npm run typecheck    # tsc -b, nessun errore
npm test             # vitest run
npm run lint         # eslint
```

Una PR che non passa questi tre non viene guardata — non per rigidità, ma perché il primo commento
sarebbe comunque «passa i test».

## Come sono scritti i test qui

I test di questo progetto non verificano che il codice faccia quello che fa. Verificano **che un
guasto già successo non possa ripetersi**, e il commento sopra dice qual era quel guasto e perché
non assomigliava a un guasto.

Due regole che vengono da errori veri:

- **Ogni test ha una controprova.** Se un test legge un file e cerca qualcosa dentro, deve prima
  verificare di aver letto davvero qualcosa. Senza, una lettura sbagliata fa passare il test su
  qualunque file — ed è successo.
- **Un test che si sbaglia è un test che qualcuno disattiva.** Se cercare una stringa nel testo
  intero segnalerebbe come guasto il commento che spiega perché quel guasto è stato evitato,
  cerca nelle righe giuste, non nel testo intero.

## Messaggi di commit

`tipo(ambito): cosa cambia`, in italiano, all'infinito o al presente.

```
feat(segreti): niente dati sensibili nel compose, il container aspetta
fix(umbrel): la cartella dei segreti nasce scrivibile, senza chown a mano
docs(twitch): i livelli di sicurezza, e cosa cambia fra uno e l'altro
```

Tipi: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

Il corpo del messaggio conta più del titolo. Scrivi **perché**, non cosa: il cosa si legge dal
diff, il perché no — e fra sei mesi è l'unica cosa che serve davvero.

## Stile del codice

Segui quello che c'è intorno: nomi in italiano per il dominio, inglese dove lo impone una libreria.
Commenti dove il codice fa qualcosa di non ovvio, con il motivo, non la parafrasi della riga
sotto.

`eslint` e `prettier` sono configurati: non discutere di formattazione, esegui `npm run lint`.

## Aggiungere un'opzione di configurazione

C'è un test che lo pretende: ogni campo della configurazione deve avere una descrizione in
`packages/shared/src/config/docs.ts`. Senza, il pannello mostra il nome tecnico e nessuno capisce
cosa fa quella spunta.

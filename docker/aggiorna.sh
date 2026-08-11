#!/bin/sh
# ─────────────────────────────────────────────────────────────
#  Aggiornamento di ANGEL.
#
#      sudo sh aggiorna.sh [percorso-del-compose] [versione]
#
#  Con la versione indicata riscrive **ogni** riga `image:` del file, non solo
#  l'àncora in cima. Serve perché l'app store di ZimaOS espande le àncore YAML
#  al momento dell'installazione: nella sua copia `x-image` non esiste più, e
#  modificarla non cambia nulla. Il risultato è un aggiornamento che ricrea
#  qualche container e ne lascia indietro altri — il guasto peggiore da
#  diagnosticare, perché non assomiglia a un guasto.
#
#  Fa tre cose, in quest'ordine: copia il database, scarica l'immagine nuova,
#  ricrea i container. L'ordine conta — la copia va fatta *prima* che le
#  migrazioni tocchino lo schema, perché una migrazione non si annulla e
#  tornare a una versione precedente senza un dump significa ripartire da zero.
#
#  I volumi non vengono mai toccati: log, configurazione, archivio e snapshot
#  sopravvivono all'aggiornamento. Nulla qui dentro cancella dati.
#
#  Niente `docker exec`: su ZimaOS viene rifiutato con «permission denied».
#  pg_dump gira quindi in un container usa-e-getta attaccato alla stessa rete,
#  che raggiunge il database via TCP come farebbero bot e pannello.
# ─────────────────────────────────────────────────────────────
set -eu

COMPOSE="${1:-docker-compose.yml}"
VERSIONE="${2:-}"
IMMAGINE="${IMMAGINE:-ghcr.io/gigiomiccio425/aegis-discord-bot}"
BACKUP_DIR="${BACKUP_DIR:-/DATA/aegis-backup}"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ ! -f "$COMPOSE" ]; then
	echo "File compose non trovato: $COMPOSE"
	echo "Uso: sudo sh aggiorna.sh /percorso/docker-compose.yml [versione]"
	exit 1
fi

# ── Individuazione del container Postgres ────────────────────
# Per nome e non per `container_name`: ZimaOS lo riscrive, e cercare
# «aegis-postgres» darebbe «No such object» su un'installazione fatta
# dall'App Store.
PG="$(docker ps --format '{{.Names}}' | grep -i 'postgres' | head -1)"
if [ -z "$PG" ]; then
	echo "Nessun container Postgres in esecuzione: aggiornamento interrotto."
	exit 1
fi

RETE="$(docker inspect "$PG" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')"
PASSWORD="$(docker inspect "$PG" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')"
UTENTE="$(docker inspect "$PG" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p')"
UTENTE="${UTENTE:-aegis}"

# ── 1. Copia del database ────────────────────────────────────
mkdir -p "$BACKUP_DIR"
DUMP="$BACKUP_DIR/aegis-$STAMP.sql.gz"
echo "Copia del database in $DUMP"
docker run --rm --network "$RETE" -e PGPASSWORD="$PASSWORD" postgres:17 \
	pg_dump -h aegis-postgres -U "$UTENTE" -d aegis | gzip > "$DUMP"

# Un dump vuoto è peggio di nessun dump: darebbe l'illusione di poter tornare
# indietro. Se pg_dump non ha prodotto nulla di sensato, meglio fermarsi qui.
if [ ! -s "$DUMP" ] || [ "$(wc -c < "$DUMP")" -lt 1000 ]; then
	echo "La copia è vuota o troppo piccola: aggiornamento interrotto."
	echo "Nessuna modifica è stata fatta. Controlla i log di $PG."
	exit 1
fi
echo "Copia riuscita: $(du -h "$DUMP" | cut -f1)"

# Vengono tenute le ultime dieci copie. Con 2 TB non è una questione di spazio,
# ma di riuscire a trovare quella giusta quando serve davvero.
ls -1t "$BACKUP_DIR"/aegis-*.sql.gz 2>/dev/null | tail -n +11 | while read -r vecchia; do
	echo "Rimuovo la copia vecchia $(basename "$vecchia")"
	rm -f "$vecchia"
done

# ── 2. Versione, su ogni riga ────────────────────────────────
# Sostituisce sia l'àncora `x-image` sia le righe `image:` già espanse. Sono
# la stessa informazione scritta in due modi, e a seconda di come il file è
# stato installato ne esiste solo uno dei due: cambiarne uno solo lascerebbe
# metà dei servizi alla versione precedente.
if [ -n "$VERSIONE" ]; then
	ATTUALI="$(grep -c "$IMMAGINE" "$COMPOSE" || true)"
	if [ "$ATTUALI" = "0" ]; then
		echo "Nel file non compare $IMMAGINE: niente da aggiornare."
		exit 1
	fi

	cp "$COMPOSE" "$COMPOSE.prima-di-$STAMP"
	# Il separatore è la virgola perché il nome dell'immagine contiene barre.
	sed -i "s,$IMMAGINE:[A-Za-z0-9._-]*,$IMMAGINE:$VERSIONE,g" "$COMPOSE"

	echo "Versione impostata a $VERSIONE su $ATTUALI righe."
	echo "Copia del file precedente: $COMPOSE.prima-di-$STAMP"
	grep -n "$IMMAGINE" "$COMPOSE" | sed 's/^/  /'
fi

# ── 3. Immagine nuova ────────────────────────────────────────
echo "Scarico l'immagine"
docker compose -f "$COMPOSE" pull

# ── 4. Ricreazione ───────────────────────────────────────────
# `up -d` da solo ricrea i container la cui immagine è cambiata, ma su ZimaOS
# la definizione registrata dall'app store può non coincidere con questo file:
# `--force-recreate` toglie di mezzo il dubbio. Ricreare un container che era
# già aggiornato costa qualche secondo; lasciarne indietro uno costa un'ora di
# ricerca del perché la correzione «non funziona».
echo "Riavvio i servizi"
docker compose -f "$COMPOSE" up -d --force-recreate --remove-orphans

# ── 5. Verifica ──────────────────────────────────────────────
# Si controllano tutti e quattro, non solo l'API: è precisamente il caso in cui
# un container resta indietro che questa verifica deve intercettare.
echo
echo "Versione per container:"
DISALLINEATI=0
for NOME in $(docker ps --format '{{.Names}}' | grep -iE 'bot|worker|api' || true); do
	V="$(docker inspect "$NOME" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^ANGEL_VERSION=//p')"
	printf '  %-24s %s\n' "$NOME" "${V:-sconosciuta}"
	if [ -n "$VERSIONE" ] && [ "$V" != "$VERSIONE" ]; then DISALLINEATI=1; fi
done

if [ "$DISALLINEATI" = "1" ]; then
	echo
	echo "⚠️  Qualche container gira ancora una versione diversa da $VERSIONE."
	echo "   Succede quando l'app store di ZimaOS conserva una propria copia della"
	echo "   definizione. Rimuovili a mano e lascia che si ricreino:"
	echo "     sudo docker rm -f \$(sudo docker ps -q --filter 'name=aegis')"
	echo "     sudo docker compose -f $COMPOSE up -d"
fi

echo
echo "Se qualcosa non torna, i log:"
echo "  docker compose -f $COMPOSE logs --tail 50 aegis-migrate aegis-bot aegis-api"
echo
echo "Per tornare indietro: rimetti la versione precedente in x-image, poi"
echo "  gunzip -c $DUMP | docker run --rm -i --network $RETE -e PGPASSWORD=... postgres:17 psql -h aegis-postgres -U $UTENTE -d aegis"

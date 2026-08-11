#!/bin/sh
# ─────────────────────────────────────────────────────────────
#  Aggiornamento di Aegis.
#
#      sudo sh aggiorna.sh [percorso-del-compose]
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
BACKUP_DIR="${BACKUP_DIR:-/DATA/aegis-backup}"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ ! -f "$COMPOSE" ]; then
	echo "File compose non trovato: $COMPOSE"
	echo "Uso: sudo sh aggiorna.sh /percorso/docker-compose.yml"
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

# ── 2. Immagine nuova ────────────────────────────────────────
echo "Scarico l'immagine"
docker compose -f "$COMPOSE" pull

# ── 3. Ricreazione ───────────────────────────────────────────
# `up -d` ricrea solo i container la cui immagine o configurazione è cambiata.
# aegis-migrate riparte e applica le migrazioni mancanti prima che bot, worker
# e api si avviino: è la dipendenza dichiarata nel compose.
echo "Riavvio i servizi"
docker compose -f "$COMPOSE" up -d

API="$(docker ps --format '{{.Names}}' | grep -i 'aegis.*api' | head -1)"
if [ -n "$API" ]; then
	VERSIONE="$(docker inspect "$API" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^AEGIS_VERSION=//p')"
	echo
	echo "Versione in esecuzione: ${VERSIONE:-sconosciuta}"
fi

echo
echo "Se qualcosa non torna, i log:"
echo "  docker compose -f $COMPOSE logs --tail 50 aegis-migrate aegis-bot aegis-api"
echo
echo "Per tornare indietro: rimetti la versione precedente in x-image, poi"
echo "  gunzip -c $DUMP | docker run --rm -i --network $RETE -e PGPASSWORD=... postgres:17 psql -h aegis-postgres -U $UTENTE -d aegis"

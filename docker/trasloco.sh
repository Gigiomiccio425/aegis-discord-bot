#!/bin/sh
# ─────────────────────────────────────────────────────────────
#  TRASLOCO DI ANGEL SU UN'ALTRA MACCHINA
#
#      sudo sh trasloco.sh esporta [cartella]
#      sudo sh trasloco.sh importa  <cartella>
#
#  Porta via tutto quello che serve a far ripartire ANGEL altrove uguale a
#  com'era: il database, i file archiviati e i segreti senza i quali metà dei
#  dati resterebbe illeggibile.
#
#  Perché esiste, visto che il bot fa già una copia ogni notte: quella copia
#  è NDJSON, cioè un formato che si legge fra dieci anni con qualunque cosa,
#  ed è la rete di sicurezza. Questa è un `pg_dump`, cioè una copia esatta,
#  con sequenze, indici e vincoli — è quella giusta per un trasloco, dove non
#  serve leggibilità fra dieci anni ma fedeltà fra dieci minuti.
#
#  Le due si coprono a vicenda. Se il dump non si rilegge (versione di
#  Postgres diversa, file corrotto), c'è la copia notturna; se la copia
#  notturna manca un pezzo, c'è il dump.
#
#  Niente `docker exec`: su ZimaOS viene rifiutato con «permission denied».
#  Tutto passa da container usa-e-getta attaccati alla stessa rete.
# ─────────────────────────────────────────────────────────────
set -eu

AZIONE="${1:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"

uso() {
	cat <<'FINE'
Uso:
  sudo sh trasloco.sh esporta [cartella]     prepara il trasloco (macchina vecchia)
  sudo sh trasloco.sh importa  <cartella>    lo completa      (macchina nuova)

Sulla macchina vecchia:
  sudo sh trasloco.sh esporta /DATA/trasloco

Poi si copia la cartella sulla macchina nuova, con quello che si preferisce:
  scp -r utente@vecchia:/DATA/trasloco/angel-trasloco-AAAAMMGG-HHMMSS ./

Sulla macchina nuova, dopo aver installato ANGEL e averlo fatto partire
almeno una volta (servono le tabelle):
  sudo sh trasloco.sh importa ./angel-trasloco-AAAAMMGG-HHMMSS
FINE
}

# ── Individuazione dei container ─────────────────────────────
# Per nome parziale e non per `container_name`: ZimaOS lo riscrive, e cercare
# «aegis-postgres» darebbe «No such object» su un'installazione fatta
# dall'App Store.
trova_postgres() {
	docker ps --format '{{.Names}}' | grep -i 'postgres' | head -1
}

trova_angel() {
	docker ps --format '{{.Names}}' | grep -iE '^angel$|angel|aegis-bot' | grep -vi postgres | grep -vi redis | head -1
}

variabile_di() {
	docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$2=//p" | head -1
}

# Percorso sull'host di un volume montato dentro un container. Serve perché
# `/DATA/AppData/aegis/storage` è una convenzione, non una certezza: chi ha
# spostato i dati sul disco grande ce l'ha altrove, ed è proprio quella
# l'installazione che si sta traslocando.
sorgente_montaggio() {
	docker inspect "$1" \
		--format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}"
}

# ═════════════════════════════════════════════════════════════
#  ESPORTA
# ═════════════════════════════════════════════════════════════
esporta() {
	BASE="${1:-/DATA/trasloco}"
	FUORI="$BASE/angel-trasloco-$STAMP"

	PG="$(trova_postgres)"
	if [ -z "$PG" ]; then
		echo "Nessun container Postgres in esecuzione: non c'è nulla da esportare."
		exit 1
	fi
	ANGEL="$(trova_angel)"

	RETE="$(docker inspect "$PG" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')"
	PASSWORD="$(variabile_di "$PG" POSTGRES_PASSWORD)"
	UTENTE="$(variabile_di "$PG" POSTGRES_USER)"
	UTENTE="${UTENTE:-aegis}"
	DB="$(variabile_di "$PG" POSTGRES_DB)"
	DB="${DB:-aegis}"

	mkdir -p "$FUORI"
	echo "Cartella di trasloco: $FUORI"
	echo

	# ── 1. Database ──────────────────────────────────────
	echo "[1/4] Copia del database"
	docker run --rm --network "$RETE" -e PGPASSWORD="$PASSWORD" postgres:17 \
		pg_dump -h "$PG" -U "$UTENTE" -d "$DB" | gzip > "$FUORI/database.sql.gz"

	# Un dump vuoto è peggio di nessun dump: darebbe l'illusione di poter
	# ripartire. Meglio fermarsi qui, dove c'è ancora la macchina vecchia.
	if [ ! -s "$FUORI/database.sql.gz" ] || [ "$(wc -c < "$FUORI/database.sql.gz")" -lt 1000 ]; then
		echo "      La copia è vuota o troppo piccola: trasloco interrotto."
		echo "      Nessuna modifica è stata fatta. Controlla i log di $PG."
		exit 1
	fi
	echo "      $(du -h "$FUORI/database.sql.gz" | cut -f1)"

	# ── 2. File archiviati ───────────────────────────────
	# Nel database c'è il *percorso* dell'allegato, non l'allegato. Senza
	# questa parte si ripristina un archivio pieno di riferimenti a file che
	# non esistono.
	echo "[2/4] Copia dei file archiviati"
	STORAGE=""
	if [ -n "$ANGEL" ]; then
		STORAGE="$(sorgente_montaggio "$ANGEL" /data/storage)"
	fi
	if [ -n "$STORAGE" ] && [ -d "$STORAGE" ]; then
		tar czf "$FUORI/archivio.tar.gz" -C "$STORAGE" .
		echo "      da $STORAGE — $(du -h "$FUORI/archivio.tar.gz" | cut -f1)"
	else
		echo "      ⚠️  Cartella dei file archiviati non trovata."
		echo "         Cercata come volume montato su /data/storage nel container $ANGEL."
		echo "         Se l'hai altrove, copiala a mano: allegati e trascrizioni stanno lì."
	fi

	# ── 3. Copie notturne ────────────────────────────────
	echo "[3/4] Ultima copia notturna del bot"
	BACKUP=""
	if [ -n "$ANGEL" ]; then
		BACKUP="$(sorgente_montaggio "$ANGEL" /backup)"
	fi
	if [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
		ULTIMA="$(ls -1d "$BACKUP"/angel-* 2>/dev/null | sort | tail -1 || true)"
		if [ -n "$ULTIMA" ]; then
			cp -a "$ULTIMA" "$FUORI/copia-notturna"
			echo "      $(basename "$ULTIMA")"
		else
			echo "      nessuna copia notturna presente (non è un problema: c'è il dump)"
		fi
	else
		echo "      cartella BACKUP_DIR non montata (non è un problema: c'è il dump)"
	fi

	# ── 4. Segreti ───────────────────────────────────────
	echo "[4/4] Variabili d'ambiente"
	if [ -n "$ANGEL" ]; then
		{
			echo "# Variabili lette dal container $ANGEL il $(date -Iseconds)."
			echo "#"
			echo "# ⚠️  QUESTO FILE CONTIENE SEGRETI IN CHIARO."
			echo "#     Token del bot, chiave di cifratura, password del database."
			echo "#     Cancellalo appena finito il trasloco, e non passarlo su un canale"
			echo "#     che conserva i messaggi."
			echo "#"
			echo "# Devono essere IDENTICHE sulla macchina nuova:"
			echo "#   ENCRYPTION_KEY   senza la stessa, i token delle integrazioni cifrati"
			echo "#                    dentro il database restano illeggibili"
			echo "#   DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, OWNER_IDS"
			echo "#   SESSION_SECRET   diversa fa solo ricollegare al pannello, nulla di grave"
			echo "#"
			echo "# Cambia con la macchina:"
			echo "#   PUBLIC_URL       il nuovo indirizzo va aggiunto ai redirect OAuth2 nel"
			echo "#                    Developer Portal di Discord, altrimenti l'accesso al"
			echo "#                    pannello fallisce con «stato non valido»"
			echo "#   TWITCH_PUBLIC_URL idem, ma sul Developer Portal di Twitch: senza,"
			echo "#                    nessuno streamer riesce a collegare il proprio canale"
			echo "#"
			echo "# NON riportata di proposito:"
			echo "#   TWITCH_SETUP_KEY chiave temporanea per ottenere i token dell'account"
			echo "#                    bot. Portarsela dietro lascia aperta una porta che"
			echo "#                    serviva dieci minuti."
			echo ""
			for NOME in ENCRYPTION_KEY SESSION_SECRET DISCORD_TOKEN DISCORD_CLIENT_ID \
				DISCORD_CLIENT_SECRET OWNER_IDS PUBLIC_URL DATABASE_URL \
				GOOGLE_SAFE_BROWSING_KEY ABUSECH_AUTH_KEY THREAT_FEEDS_ENABLED THREAT_FEED_MAX \
				TWITCH_CLIENT_ID TWITCH_CLIENT_SECRET TWITCH_EVENTSUB_SECRET \
				TWITCH_BOT_USER_ID TWITCH_BOT_LOGIN TWITCH_BOT_ACCESS_TOKEN \
				TWITCH_BOT_REFRESH_TOKEN TWITCH_PUBLIC_URL TWITCH_PANEL_PORT \
				SHARD_COUNT BACKUP_DIR BACKUP_KEEP BACKUP_INCLUDE_STORAGE \
				BACKUP_STORAGE_MAX_MB STORAGE_DIR; do
				VALORE="$(variabile_di "$ANGEL" "$NOME")"
				[ -n "$VALORE" ] && echo "$NOME=$VALORE"
			done
			echo ""
			echo "POSTGRES_USER=$UTENTE"
			echo "POSTGRES_PASSWORD=$PASSWORD"
			echo "POSTGRES_DB=$DB"
		} > "$FUORI/ambiente.txt"
		chmod 600 "$FUORI/ambiente.txt"
		echo "      $FUORI/ambiente.txt (permessi 600)"
	else
		echo "      ⚠️  Container di ANGEL non trovato: copia a mano il blocco in cima"
		echo "         al compose. Senza ENCRYPTION_KEY i segreti nel database sono persi."
	fi

	# ── Foglio di istruzioni ─────────────────────────────
	cat > "$FUORI/LEGGIMI.txt" <<FINE
TRASLOCO DI ANGEL — $STAMP

Contenuto:
  database.sql.gz    il database intero
  archivio.tar.gz    allegati archiviati e trascrizioni dei ticket
  copia-notturna/    l'ultima copia NDJSON prodotta dal bot (rete di sicurezza)
  ambiente.txt       i segreti — CANCELLALO APPENA FINITO

Sulla macchina nuova:

  1. Installa ANGEL con lo stesso compose, riportando i valori di
     ambiente.txt nel blocco in cima. ENCRYPTION_KEY deve essere identica.
     PUBLIC_URL invece va cambiata con il nuovo indirizzo, e quel nuovo
     indirizzo va aggiunto ai redirect OAuth2 nel Developer Portal.

  2. Fallo partire una volta e aspetta che il pannello si apra: servono le
     migrazioni, cioè le tabelle vuote in cui versare i dati.

  3. Copia qui questa cartella e lancia:
       sudo sh trasloco.sh importa /percorso/di/questa/cartella

  4. Riavvia l'app. Controlla dal pannello che il registro contenga la
     storia di prima e che i ticket vecchi abbiano ancora la trascrizione.

  5. Cancella ambiente.txt da tutte e due le macchine.

  6. Spegni il bot sulla macchina vecchia PRIMA di accenderlo sulla nuova.
     Due ANGEL collegati allo stesso token si contendono il gateway: Discord
     ne fa cadere uno di continuo, e ogni sanzione rischia di essere
     applicata due volte.
FINE

	echo
	echo "Fatto: $FUORI"
	du -sh "$FUORI"
	echo
	echo "Leggi $FUORI/LEGGIMI.txt prima di procedere."
	echo "⚠️  ambiente.txt contiene segreti in chiaro: cancellalo a trasloco finito."
}

# ═════════════════════════════════════════════════════════════
#  IMPORTA
# ═════════════════════════════════════════════════════════════
importa() {
	DENTRO="${1:-}"
	if [ -z "$DENTRO" ] || [ ! -d "$DENTRO" ]; then
		echo "Indica la cartella prodotta da 'trasloco.sh esporta'."
		exit 1
	fi
	if [ ! -f "$DENTRO/database.sql.gz" ]; then
		echo "In $DENTRO non c'è database.sql.gz: non è una cartella di trasloco."
		exit 1
	fi

	PG="$(trova_postgres)"
	if [ -z "$PG" ]; then
		echo "Nessun container Postgres in esecuzione: installa e avvia ANGEL prima."
		exit 1
	fi
	ANGEL="$(trova_angel)"

	RETE="$(docker inspect "$PG" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')"
	PASSWORD="$(variabile_di "$PG" POSTGRES_PASSWORD)"
	UTENTE="$(variabile_di "$PG" POSTGRES_USER)"
	UTENTE="${UTENTE:-aegis}"
	DB="$(variabile_di "$PG" POSTGRES_DB)"
	DB="${DB:-aegis}"

	# Il confronto delle chiavi si fa qui, prima di scrivere: dopo, i dati
	# sarebbero dentro e illeggibili, e non ci sarebbe modo di accorgersene
	# se non provando un'integrazione alla volta.
	if [ -f "$DENTRO/ambiente.txt" ] && [ -n "$ANGEL" ]; then
		VECCHIA="$(sed -n 's/^ENCRYPTION_KEY=//p' "$DENTRO/ambiente.txt" | head -1)"
		NUOVA="$(variabile_di "$ANGEL" ENCRYPTION_KEY)"
		if [ -n "$VECCHIA" ] && [ "$VECCHIA" != "$NUOVA" ]; then
			echo "⚠️  ENCRYPTION_KEY diversa da quella della macchina vecchia."
			echo "    I dati tornerebbero tutti, ma i token delle integrazioni cifrati"
			echo "    dentro il database resterebbero illeggibili, e il sintomo sarebbe"
			echo "    un'integrazione che smette di funzionare senza dire perché."
			echo
			echo "    Metti nel compose la ENCRYPTION_KEY che sta in ambiente.txt,"
			echo "    riavvia, e rilancia questo comando."
			echo
			printf "    Procedere lo stesso? [scrivi: si] "
			read -r RISPOSTA
			[ "$RISPOSTA" = "si" ] || exit 1
		fi
	fi

	echo
	echo "⚠️  Il database '$DB' di QUESTA macchina verrà sostituito da quello della copia."
	printf "    Continuare? [scrivi: si] "
	read -r CONFERMA
	[ "$CONFERMA" = "si" ] || { echo "Annullato. Niente è stato toccato."; exit 1; }

	# ── 1. Il bot si ferma ───────────────────────────────
	# Scrivere nel database mentre il bot ci lavora sopra significa che metà
	# delle sue cache si riferiscono a righe che non esistono più.
	if [ -n "$ANGEL" ]; then
		echo "[1/3] Fermo $ANGEL"
		docker stop "$ANGEL" >/dev/null
	fi

	# ── 2. Database ──────────────────────────────────────
	echo "[2/3] Ripristino del database"
	# Si ricrea lo schema da zero: un dump versato sopra tabelle già create
	# dalle migrazioni fallisce riga per riga con «relation already exists»,
	# e il risultato è un database mezzo pieno che sembra funzionare.
	docker run --rm --network "$RETE" -e PGPASSWORD="$PASSWORD" postgres:17 \
		psql -h "$PG" -U "$UTENTE" -d "$DB" \
		-c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null

	# ON_ERROR_STOP=1: si vuole sapere subito se il dump non passa. Senza,
	# psql tira dritto riga per riga e alla fine restituisce zero comunque,
	# lasciando un database mezzo pieno che a prima vista sembra funzionare —
	# ed è il modo peggiore di scoprire un trasloco fallito, cioè fra tre
	# giorni, quando la macchina vecchia non c'è più.
	if ! gunzip -c "$DENTRO/database.sql.gz" | docker run --rm -i --network "$RETE" \
		-e PGPASSWORD="$PASSWORD" postgres:17 \
		psql -v ON_ERROR_STOP=1 -h "$PG" -U "$UTENTE" -d "$DB" >/dev/null; then
		echo
		echo "❌ Il ripristino del database è fallito (l'errore è nelle righe qui sopra)."
		echo "   $ANGEL resta SPENTO di proposito: un bot che parte su un database"
		echo "   a metà fa danni peggiori di un bot fermo."
		echo
		echo "   La macchina vecchia non è stata toccata: puoi riaccendere lì e riprovare."
		echo "   In alternativa c'è la copia notturna in $DENTRO/copia-notturna,"
		echo "   che si ripristina mettendo nel compose:"
		echo "     RESTORE_FROM: /backup/<nome della cartella>"
		exit 1
	fi
	echo "      fatto"

	# ── 3. File archiviati ───────────────────────────────
	echo "[3/3] Ripristino dei file archiviati"
	if [ -f "$DENTRO/archivio.tar.gz" ] && [ -n "$ANGEL" ]; then
		STORAGE="$(sorgente_montaggio "$ANGEL" /data/storage)"
		if [ -n "$STORAGE" ]; then
			mkdir -p "$STORAGE"
			tar xzf "$DENTRO/archivio.tar.gz" -C "$STORAGE"
			echo "      in $STORAGE"
		else
			echo "      ⚠️  volume /data/storage non trovato: estrai archivio.tar.gz a mano"
		fi
	else
		echo "      niente da ripristinare"
	fi

	if [ -n "$ANGEL" ]; then
		echo "Riaccendo $ANGEL"
		docker start "$ANGEL" >/dev/null
	fi

	echo
	echo "Trasloco completato."
	echo
	echo "Da controllare adesso, in quest'ordine:"
	echo "  • il pannello si apre e mostra i server di prima"
	echo "  • il registro contiene eventi vecchi di giorni, non solo di adesso"
	echo "  • un ticket chiuso tempo fa ha ancora la sua trascrizione"
	echo "  • le integrazioni Twitch e YouTube funzionano (se no: ENCRYPTION_KEY sbagliata)"
	echo
	echo "Poi: cancella ambiente.txt, e spegni il bot sulla macchina vecchia."
}

case "$AZIONE" in
esporta) shift; esporta "$@" ;;
importa) shift; importa "$@" ;;
*) uso; exit 1 ;;
esac

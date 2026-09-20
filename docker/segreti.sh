#!/bin/sh
# ─────────────────────────────────────────────────────────────
#  I SEGRETI, DAL COMPOSE AL FILE CHE SOPRAVVIVE
#
#      sh segreti.sh [container] [cartella dei dati]
#
#  Su umbrelOS il `docker-compose.yml` dell'app appartiene al repository: a
#  ogni aggiornamento viene riscritto da lì, e i valori messi a mano —
#  token, chiavi, password, indirizzo del pannello — tornano ai segnaposto.
#  Da ANGEL 1.28.1 quei valori si leggono da `segreti.env`, che sta dentro i
#  dati dell'app e che nessun aggiornamento tocca.
#
#  Questo script fa il travaso una volta sola: prende dal container quello
#  che c'è ancora, lo scrive nel file, e dice cosa manca.
#
#  Cosa NON fa, di proposito:
#
#  • non sovrascrive un valore già presente nel file. Chi l'ha scritto lo ha
#    deciso, e un travaso non è il momento di discuterne;
#  • non copia i segnaposto `METTI_QUI…` né i valori vuoti: scriverli
#    significherebbe far vincere il segnaposto sul file, cioè il guasto che
#    tutto questo esiste per togliere;
#  • non stampa mai un valore. Solo i nomi.
# ─────────────────────────────────────────────────────────────
set -eu

CONTENITORE="${1:-g-d-app-store-gd-angel_angel_1}"
DATI="${2:-$HOME/umbrel/app-data/g-d-app-store-gd-angel/data/storage}"
FILE="$DATI/segreti.env"

# Quelle che vale la pena portarsi dietro: i segreti veri, più le due che
# sono di chi installa e che il compose riporterebbe a `umbrel.local`.
NOMI="DISCORD_TOKEN DISCORD_CLIENT_SECRET SESSION_SECRET ENCRYPTION_KEY \
DATABASE_URL PUBLIC_URL TWITCH_PUBLIC_URL OWNER_IDS \
TWITCH_CLIENT_ID TWITCH_CLIENT_SECRET TWITCH_EVENTSUB_SECRET \
TWITCH_BOT_USER_ID TWITCH_BOT_LOGIN TWITCH_BOT_ACCESS_TOKEN TWITCH_BOT_REFRESH_TOKEN \
GOOGLE_SAFE_BROWSING_KEY ABUSECH_AUTH_KEY"

if ! docker inspect "$CONTENITORE" >/dev/null 2>&1; then
	echo "Container «$CONTENITORE» non trovato."
	echo "Elencali con:  docker ps --format '{{.Names}}'"
	echo "e ripassa il nome giusto:  sh segreti.sh <nome> [cartella dei dati]"
	exit 1
fi

mkdir -p "$DATI"
# Il file nasce con i permessi giusti, non ci arriva dopo: fra la creazione e
# il `chmod` c'è un istante in cui è leggibile, e i segreti ci sono già.
umask 077
[ -f "$FILE" ] || : > "$FILE"

AMBIENTE="$(docker inspect "$CONTENITORE" --format '{{range .Config.Env}}{{println .}}{{end}}')"

SCRITTI=""
SALTATI=""
MANCANTI=""

for NOME in $NOMI; do
	# Già nel file: non si tocca.
	if grep -q "^[[:space:]]*\(export[[:space:]]\+\)\?$NOME=" "$FILE" 2>/dev/null; then
		SALTATI="$SALTATI $NOME"
		continue
	fi

	VALORE="$(printf '%s\n' "$AMBIENTE" | sed -n "s/^$NOME=//p" | head -1)"

	case "$VALORE" in
		"" | METTI_QUI*)
			MANCANTI="$MANCANTI $NOME"
			continue
			;;
	esac

	# Uno spazio seguito da un cancelletto apre un commento, e chi rilegge il
	# file troverebbe il valore tagliato lì. Fra apici no: nessuno interpreta
	# più niente.
	case "$VALORE" in
		*" #"*) printf "%s='%s'\n" "$NOME" "$VALORE" >> "$FILE" ;;
		*) printf '%s=%s\n' "$NOME" "$VALORE" >> "$FILE" ;;
	esac
	SCRITTI="$SCRITTI $NOME"
done

chmod 600 "$FILE"

echo "File: $FILE"
[ -n "$SCRITTI" ] && echo "Presi dal container:$SCRITTI"
[ -n "$SALTATI" ] && echo "Già presenti, lasciati stare:$SALTATI"

if [ -n "$MANCANTI" ]; then
	echo ""
	echo "Da scrivere a mano (nel container erano vuoti o segnaposto):$MANCANTI"
	echo ""
	echo "  nano $FILE"
	echo ""
	echo "Una riga per valore, senza virgolette. Dove prenderli:"
	echo "  DISCORD_TOKEN, DISCORD_CLIENT_SECRET  Developer Portal di Discord"
	echo "  SESSION_SECRET, ENCRYPTION_KEY        openssl rand -hex 32"
	echo "  DATABASE_URL                          se non ricordi la password, si cambia"
	echo "                                        senza perdere niente: il comando è nel"
	echo "                                        README dello store"
	echo ""
	echo "ENCRYPTION_KEY merita una riga a parte: se ne metti una nuova, i token"
	echo "cifrati nel database diventano illeggibili — i canali Twitch collegati"
	echo "vanno riautorizzati. Tutto il resto (registro, provvedimenti, archivio,"
	echo "configurazione) non è cifrato e non si tocca."
fi

echo ""
echo "Poi riavvia l'app. Nei log deve comparire: «segreti.env: letti …»"

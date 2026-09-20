# Segnalare una vulnerabilità

**Non aprire una issue pubblica.** ANGEL è un bot di sicurezza: una issue che descrive come
aggirarlo è, di fatto, istruzioni per farlo — e restano leggibili a chiunque finché non esiste
una correzione.

## Come segnalare

Usa **[GitHub Security Advisories](https://github.com/Gigiomiccio425/aegis-discord-bot/security/advisories/new)**.
La segnalazione resta privata fino alla pubblicazione della correzione.

Se non puoi usarlo, apri una issue vuota con scritto solo «segnalazione privata» e attendi che ti
venga aperto un canale. Non scrivere dettagli lì dentro.

## Cosa scrivere

Una segnalazione utile risponde a tre domande:

1. **Cosa si ottiene.** Non «c'è un bug in X», ma «un utente senza permessi riesce a Y».
2. **Come riprodurlo.** I passaggi minimi, e la versione di ANGEL.
3. **Cosa hai già verificato.** Se hai provato la correzione ovvia e non funziona, dillo:
   risparmia un giro.

## Cosa rientra

| Rientra | Non rientra |
|---|---|
| Aggirare un controllo di sicurezza (lockdown, anti-raid, filtri) | Un falso positivo o un falso negativo di un rilevatore |
| Accedere al pannello senza averne diritto | Una segnalazione che il pannello è raggiungibile in rete locale: è voluto |
| Leggere o modificare dati di un altro server Discord | Rate limit di Discord o di Twitch |
| Esecuzione di codice, SSRF, injection | Dipendenze con CVE non raggiungibili dal codice |
| Segreti che finiscono nei log o in un file leggibile | Vulnerabilità in Discord, Twitch o umbrelOS |

I falsi positivi dei rilevatori non sono vulnerabilità, ma sono comunque **benvenuti come issue
normali**: un filtro che sanziona chi non c'entra è un problema serio, solo non riservato.

## Versioni supportate

Solo l'ultima versione pubblicata. Non ci sono backport: il progetto ha un manutentore, e una
seconda linea di versioni significherebbe correzioni applicate a metà.

## Tempi

Nessun impegno formale — è un progetto di una persona sola. In pratica: risposta entro pochi
giorni, correzione appena è chiaro cosa fare.

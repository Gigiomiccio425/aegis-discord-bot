/**
 * Testi rivolti agli utenti. Il pannello e i log restano in italiano; qui
 * servono le due lingue perché i messaggi arrivano ai membri del server, che
 * possono non parlare italiano.
 */
export type Locale = 'it' | 'en';

type Dict = Record<string, string>;

const it: Dict = {
  'common.noPermission': 'Non hai i permessi per usare questo comando.',
  'common.error': 'Qualcosa è andato storto. L\'errore è stato registrato.',
  'common.cooldown': 'Aspetta ancora {seconds}s prima di riusare questo comando.',
  'common.dryRun': '⚠️ Modalità prova attiva: nessuna sanzione è stata applicata davvero.',

  'mod.warned': 'Hai ricevuto un avvertimento in **{guild}**.\nMotivo: {reason}',
  'mod.muted': 'Sei stato silenziato in **{guild}** per {duration}.\nMotivo: {reason}',
  'mod.kicked': 'Sei stato espulso da **{guild}**.\nMotivo: {reason}',
  'mod.banned': 'Sei stato bandito da **{guild}**.\nMotivo: {reason}',
  'mod.quarantined':
    'Il tuo account è stato messo in quarantena in **{guild}**.\nMotivo: {reason}\n' +
    'Se pensi sia un errore, contatta lo staff.',

  'security.compromiseWarning':
    '⚠️ **Il tuo account potrebbe essere compromesso.**\n' +
    'Da **{guild}** abbiamo rilevato messaggi che non sembrano tuoi. Ti consigliamo di:\n' +
    '1. Cambiare subito la password di Discord (le sessioni attive verranno chiuse)\n' +
    '2. Attivare l\'autenticazione a due fattori\n' +
    '3. Controllare le app autorizzate in Impostazioni → App autorizzate e revocare quelle sconosciute\n' +
    '4. Fare una scansione antivirus del computer\n\n' +
    'Non condividere mai il tuo token e non inquadrare codici QR di login inviati da altri.',

  'security.remoteAuthWarning':
    '🚨 Il messaggio conteneva un **QR di login Discord**. Chi lo inquadra consegna il proprio ' +
    'account a chi ha generato il codice: non serve la password e non compare alcun avviso. ' +
    'Se lo hai inquadrato, cambia subito la password e revoca le sessioni attive.',

  'verify.button': 'Verificami',
  'verify.prompt':
    'Benvenuto in **{guild}**! Premi il pulsante qui sotto per accedere al server.',
  'verify.success': '✅ Verifica completata. Buona permanenza!',
  'verify.tooFast': 'Aspetta qualche secondo prima di premere il pulsante.',

  'staff.codewordMissing':
    'Nessuna parola d\'ordine configurata per questo server. Impostala dal pannello: è la sola ' +
    'difesa pratica contro chi imita lo staff con voce o video generati da IA.',
  'staff.codewordOk': '✅ Parola d\'ordine corretta: la richiesta proviene davvero dallo staff.',
  'staff.codewordBad': '❌ Parola d\'ordine errata. Non fidarti di chi ti ha contattato.',

  'gdpr.done':
    'I tuoi dati registrati da questo bot in **{guild}** sono stati cancellati. ' +
    'I provvedimenti di moderazione restano conservati in forma pseudonimizzata, come previsto.',
  'gdpr.disabled': 'Questo server non consente la cancellazione autonoma dei dati.',
};

const en: Dict = {
  'common.noPermission': 'You do not have permission to use this command.',
  'common.error': 'Something went wrong. The error has been logged.',
  'common.cooldown': 'Wait {seconds}s before using this command again.',
  'common.dryRun': '⚠️ Dry-run mode is on: no punishment was actually applied.',

  'mod.warned': 'You received a warning in **{guild}**.\nReason: {reason}',
  'mod.muted': 'You have been muted in **{guild}** for {duration}.\nReason: {reason}',
  'mod.kicked': 'You have been kicked from **{guild}**.\nReason: {reason}',
  'mod.banned': 'You have been banned from **{guild}**.\nReason: {reason}',
  'mod.quarantined':
    'Your account has been quarantined in **{guild}**.\nReason: {reason}\n' +
    'If you think this is a mistake, contact the staff.',

  'security.compromiseWarning':
    '⚠️ **Your account may be compromised.**\n' +
    'We detected messages from you in **{guild}** that do not look like yours. We recommend:\n' +
    '1. Change your Discord password now (this ends all active sessions)\n' +
    '2. Enable two-factor authentication\n' +
    '3. Check Settings → Authorized Apps and revoke anything unknown\n' +
    '4. Run an antivirus scan on your computer\n\n' +
    'Never share your token and never scan a login QR code sent by someone else.',

  'security.remoteAuthWarning':
    '🚨 That message contained a **Discord login QR code**. Scanning it hands your account to ' +
    'whoever generated it — no password needed, no warning shown. If you scanned it, change your ' +
    'password and revoke active sessions immediately.',

  'verify.button': 'Verify me',
  'verify.prompt': 'Welcome to **{guild}**! Press the button below to access the server.',
  'verify.success': '✅ Verification complete. Enjoy your stay!',
  'verify.tooFast': 'Wait a few seconds before pressing the button.',

  'staff.codewordMissing':
    'No staff codeword is configured for this server. Set one in the panel: it is the only ' +
    'practical defence against AI-cloned voice or video impersonating your staff.',
  'staff.codewordOk': '✅ Correct codeword: the request really comes from the staff.',
  'staff.codewordBad': '❌ Wrong codeword. Do not trust whoever contacted you.',

  'gdpr.done':
    'Your data recorded by this bot in **{guild}** has been deleted. Moderation records are kept ' +
    'in pseudonymised form, as permitted.',
  'gdpr.disabled': 'This server does not allow self-service data deletion.',
};

const dictionaries: Record<Locale, Dict> = { it, en };

/** Traduce una chiave, sostituendo i segnaposto `{nome}`. */
export function t(
  locale: Locale,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const template = dictionaries[locale]?.[key] ?? dictionaries.it[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

/** Durata leggibile: 90 → "1m 30s". */
export function humanDuration(seconds: number, locale: Locale = 'it'): string {
  if (seconds <= 0) return locale === 'it' ? 'sempre' : 'permanent';
  const units: [number, string, string][] = [
    [86400, 'g', 'd'],
    [3600, 'h', 'h'],
    [60, 'm', 'm'],
    [1, 's', 's'],
  ];
  const parts: string[] = [];
  let remaining = Math.floor(seconds);
  for (const [size, itLabel, enLabel] of units) {
    const value = Math.floor(remaining / size);
    if (value > 0) {
      parts.push(`${value}${locale === 'it' ? itLabel : enLabel}`);
      remaining -= value * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/* ═══════════════════════════════════════════════════════════════════════
   LA CACHE DELLA CONFIGURAZIONE, SENZA LA CORSA

   Il bot legge la configurazione a ogni messaggio, e la tiene in cache in
   Redis per dieci minuti. Il pannello, quando salva, cancella la cache e
   annuncia la modifica. Fin qui il modello classico — con il suo difetto
   classico:

     1. il bot non trova la cache e comincia a leggere dal database;
     2. il pannello salva, cancella la cache, annuncia;
     3. la lettura del bot finisce, con i dati di **prima**, e li scrive in
        cache per dieci minuti.

   Il pannello dice «salvato», il bot usa la configurazione vecchia per dieci
   minuti, e riaprire la pagina mostra i valori nuovi: da fuori sembra che il
   bot ignori il pannello a caso. Su un server attivo, dove la cache si
   ricostruisce di continuo, non è un caso raro.

   ── La correzione ──────────────────────────────────────────────────────

   Un numero di revisione, che ogni salvataggio incrementa. Chi ricostruisce
   la cache legge la revisione **prima** del database, e scrive in cache solo
   se nel frattempo non è cambiata — in un unico passo, con uno script, così
   che fra il controllo e la scrittura non possa infilarsi nessuno.
   ═══════════════════════════════════════════════════════════════════════ */

import { RedisKeys } from './index.js';

export interface RedisCacheConfig {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export const revisioneConfig = (guildId: string) => `cfg:rev:${guildId}`;

/**
 * Da chiamare dopo aver salvato la configurazione nel database.
 *
 * L'ordine conta: prima la revisione, poi la cancellazione. Al contrario,
 * una lettura partita fra le due troverebbe la revisione vecchia ancora
 * valida e riscriverebbe la cache appena cancellata.
 */
export async function invalidaConfigurazione(
  redis: RedisCacheConfig,
  guildId: string,
): Promise<void> {
  await redis.call('INCR', revisioneConfig(guildId));
  await redis.call('DEL', RedisKeys.guildConfig(guildId));
  await redis.call('PUBLISH', RedisKeys.configChannel, guildId);
}

/** La revisione attuale, da leggere prima di andare al database. */
export async function leggiRevisione(redis: RedisCacheConfig, guildId: string): Promise<string> {
  return (await redis.get(revisioneConfig(guildId))) ?? '0';
}

const SCRIVI_SE_INVARIATA = `
if (redis.call('GET', KEYS[2]) or '0') == ARGV[2] then
  return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
end
return false
`;

/**
 * Scrive in cache solo se nessuno ha salvato nel frattempo.
 *
 * Restituisce `false` quando la scrittura è stata saltata: non è un errore,
 * vuol dire che quello letto è già vecchio, e il prossimo lettore lo rileggerà
 * aggiornato.
 */
export async function salvaSeInvariata(
  redis: RedisCacheConfig,
  guildId: string,
  valore: string,
  revisione: string,
  ttlSec: number,
): Promise<boolean> {
  const esito = await redis.call(
    'EVAL',
    SCRIVI_SE_INVARIATA,
    2,
    RedisKeys.guildConfig(guildId),
    revisioneConfig(guildId),
    valore,
    revisione,
    ttlSec,
  );
  return esito === 'OK';
}

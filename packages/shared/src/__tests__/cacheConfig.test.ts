import { describe, expect, it } from 'vitest';
import {
  invalidaConfigurazione,
  leggiRevisione,
  revisioneConfig,
  salvaSeInvariata,
  type RedisCacheConfig,
} from '../cacheConfig.js';
import { RedisKeys } from '../index.js';

/*
 * La corsa che questo modulo chiude: il bot rilegge la configurazione dal
 * database, il pannello salva nel frattempo, e la lettura — ormai vecchia —
 * finisce in cache per dieci minuti. Il pannello dice «salvato» e il bot
 * continua a comportarsi come prima.
 *
 * Lo script Lua fa un confronto e una scrittura; qui il Redis finto fa la
 * stessa cosa in JavaScript, per verificare che chi lo usa lo usi nell'ordine
 * giusto.
 */
function redisFinto() {
  const valori = new Map<string, string>();
  const ordine: string[] = [];
  const redis: RedisCacheConfig & { valori: typeof valori; ordine: typeof ordine } = {
    valori,
    ordine,
    async call(comando, ...args) {
      ordine.push(comando);
      const a = args.map(String);
      switch (comando) {
        case 'INCR': {
          const n = Number(valori.get(a[0]!) ?? '0') + 1;
          valori.set(a[0]!, String(n));
          return n;
        }
        case 'DEL':
          valori.delete(a[0]!);
          return 1;
        case 'PUBLISH':
          return 0;
        case 'EVAL': {
          // KEYS[1]=cache, KEYS[2]=revisione, ARGV = valore, revisione attesa, ttl
          const [, , chiave, chiaveRev, valore, attesa] = a;
          if ((valori.get(chiaveRev!) ?? '0') !== attesa) return null;
          valori.set(chiave!, valore!);
          return 'OK';
        }
        default:
          return null;
      }
    },
    async get(chiave) {
      return valori.get(chiave) ?? null;
    },
  };
  return redis;
}

const G = '123456789012345678';

describe('cache della configurazione', () => {
  it('una lettura vecchia non finisce in cache dopo un salvataggio', async () => {
    const redis = redisFinto();

    // Il bot comincia a leggere: fotografa la revisione.
    const revisione = await leggiRevisione(redis, G);

    // Nel frattempo il pannello salva.
    await invalidaConfigurazione(redis, G);

    // La lettura del bot finisce, con i dati di prima.
    const scritta = await salvaSeInvariata(redis, G, '{"vecchia":true}', revisione, 600);

    expect(scritta).toBe(false);
    expect(redis.valori.has(RedisKeys.guildConfig(G))).toBe(false);
  });

  it('una lettura senza salvataggi in mezzo va in cache', async () => {
    // La controprova: senza, un modulo che non scrive mai passerebbe il test sopra.
    const redis = redisFinto();
    const revisione = await leggiRevisione(redis, G);
    expect(await salvaSeInvariata(redis, G, '{"nuova":true}', revisione, 600)).toBe(true);
    expect(redis.valori.get(RedisKeys.guildConfig(G))).toBe('{"nuova":true}');
  });

  /*
   * Prima la revisione, poi la cancellazione. Al contrario, una lettura
   * partita fra le due troverebbe la revisione vecchia ancora valida e
   * riscriverebbe la cache appena cancellata.
   */
  it('il salvataggio incrementa la revisione prima di cancellare la cache', async () => {
    const redis = redisFinto();
    await invalidaConfigurazione(redis, G);
    expect(redis.ordine.indexOf('INCR')).toBeLessThan(redis.ordine.indexOf('DEL'));
    expect(redis.valori.get(revisioneConfig(G))).toBe('1');
  });
});

import { describe, expect, it } from 'vitest';
import { enumChoices, objectArrayPaths, objectArrayTemplates } from '../config/shapes.js';
import { defaultGuildConfig } from '../config/index.js';
import { describeValue } from '../config/docs.js';

/**
 * La forma dei campi va letta dallo schema, non dal valore: è tutto il punto
 * di questo modulo, e questi test lo verificano proprio sui campi che nella
 * configurazione predefinita sono elenchi vuoti — dove guardare il valore non
 * direbbe nulla.
 */
describe('objectArrayPaths', () => {
  const paths = objectArrayPaths();

  it('riconosce gli elenchi di oggetti anche quando sono vuoti', () => {
    const config = defaultGuildConfig();
    expect(config.integrations.twitch.streamers).toEqual([]);
    expect(paths).toContain('integrations.twitch.streamers');
  });

  it('include le altre strutture complesse note', () => {
    expect(paths).toContain('integrations.youtube.channels');
    expect(paths).toContain('integrations.rss.feeds');
    expect(paths).toContain('security.antiSpam.ladder');
  });

  it('non include gli elenchi di valori semplici', () => {
    expect(paths).not.toContain('general.staffRoleIds');
    expect(paths).not.toContain('logging.ignoredChannelIds');
    expect(paths).not.toContain('security.antiNuke.whitelistUserIds');
  });

  it('offre uno scheletro per ogni elenco di oggetti', () => {
    const templates = objectArrayTemplates();

    for (const path of paths) {
      const template = templates[path];
      expect(template, `${path} senza scheletro`).toBeTypeOf('object');
      expect(Object.keys(template as object).length, `${path} vuoto`).toBeGreaterThan(0);
    }
  });

  it('lo scheletro porta i valori predefiniti dello schema', () => {
    const streamer = objectArrayTemplates()['integrations.twitch.streamers'] as Record<
      string,
      unknown
    >;

    // Il campo da riempire resta vuoto, il resto arriva già impostato: è la
    // differenza fra un modulo da compilare e un JSON da inventare.
    expect(streamer.login).toBe('');
    expect(streamer.cooldownMinutes).toBe(60);
    expect(streamer.template).toContain('{streamer}');
    expect(streamer.announceChannelId).toBeNull();
  });

  it('restituisce percorsi che esistono davvero nella configurazione', () => {
    const config = defaultGuildConfig() as unknown as Record<string, unknown>;

    for (const path of paths) {
      const value = path.split('.').reduce<unknown>((corrente, chiave) => {
        if (corrente === null || typeof corrente !== 'object') return undefined;
        return (corrente as Record<string, unknown>)[chiave];
      }, config);

      expect(Array.isArray(value), `${path} non è un elenco`).toBe(true);
    }
  });
});

describe('enumChoices', () => {
  const scelte = enumChoices();
  const config = defaultGuildConfig() as unknown as Record<string, unknown>;
  const leggi = (percorso: string): unknown =>
    percorso.split('.').reduce<unknown>((corrente, chiave) => {
      if (corrente === null || typeof corrente !== 'object') return undefined;
      return (corrente as Record<string, unknown>)[chiave];
    }, config);

  it('trova i campi a scelta fissa, anche dentro gli elenchi di oggetti', () => {
    expect(scelte['security.antiRaid.responseLevel']).toEqual(['MONITOR', 'VERIFY', 'QUARANTINE', 'LOCKDOWN']);
    expect(scelte['security.antiNuke.rules.memberBan.action']).toContain('STRIP_ROLES');
    expect(scelte['security.antiSpam.ladder.*.action']).toContain('TIMEOUT');
  });

  // Controprova: un testo libero resta testo libero.
  it('non prende per scelta fissa un campo di testo', () => {
    expect(scelte['security.antiRaid.lockdownMessage']).toBeUndefined();
    expect(scelte['general.identity.nickname']).toBeUndefined();
  });

  it('ha il valore predefinito fra le scelte, per ogni campo fuori dagli elenchi', () => {
    const fuori = Object.entries(scelte)
      .filter(([percorso]) => !percorso.includes('*'))
      .filter(([percorso, valori]) => !valori.includes(String(leggi(percorso))))
      .map(([percorso]) => percorso);
    expect(fuori).toEqual([]);
  });

  /*
   * Il pannello mostra queste scelte come tendine, con un nome italiano al
   * posto del valore tecnico. Un valore nuovo senza nome comparirebbe come
   * «REQUIRE_VERIFICATION»: esattamente la cosa che la tendina doveva evitare.
   */
  it('ogni valore ha un nome leggibile', () => {
    const senzaNome = [...new Set(Object.values(scelte).flat())].filter(
      (valore) => describeValue(valore) === null,
    );
    expect(senzaNome).toEqual([]);
  });
});

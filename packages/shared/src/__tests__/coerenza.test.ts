import { describe, expect, it } from 'vitest';
import { defaultGuildConfig, MODULE_REGISTRY, type GuildConfig } from '../config/index.js';
import { analizzaConfigurazione, MODULE_DEPS } from '../config/coerenza.js';

/*
 * Le dipendenze sono dichiarate a mano, quindi possono mentire: un campo
 * rinominato, un modulo tolto, e la dichiarazione continua a parlare di
 * qualcosa che non esiste più — senza rompere niente, che è il modo in cui
 * questi errori sopravvivono per mesi.
 *
 * Questi test rendono la dichiarazione verificabile. Sono il motivo per cui
 * scriverla a mano è accettabile.
 */

function esiste(config: GuildConfig, path: string): boolean {
  return (
    path.split('.').reduce<unknown>((valore, chiave) => {
      if (valore === null || typeof valore !== 'object') return undefined;
      return (valore as Record<string, unknown>)[chiave];
    }, config) !== undefined
  );
}

describe('dichiarazione delle dipendenze', () => {
  const config = defaultGuildConfig();

  it('copre ogni modulo del pannello', () => {
    const mancanti = MODULE_REGISTRY.map((modulo) => modulo.key).filter(
      (chiave) => !(chiave in MODULE_DEPS),
    );
    expect(mancanti).toEqual([]);
  });

  it('non parla di moduli che non esistono', () => {
    const conosciuti = new Set<string>(MODULE_REGISTRY.map((modulo) => modulo.key));
    for (const [modulo, dipendenze] of Object.entries(MODULE_DEPS)) {
      expect(conosciuti.has(modulo), `${modulo} non è un modulo`).toBe(true);
      for (const richiesta of dipendenze.richiede ?? []) {
        expect(conosciuti.has(richiesta.modulo), `${modulo} → ${richiesta.modulo}`).toBe(true);
      }
    }
  });

  it('non parla di campi che non esistono', () => {
    for (const [modulo, dipendenze] of Object.entries(MODULE_DEPS)) {
      for (const campo of dipendenze.campi ?? []) {
        expect(esiste(config, campo.path), `${modulo} → ${campo.path}`).toBe(true);
      }
    }
  });

  it('ogni problema indica un campo che si può aprire', () => {
    for (const problema of analizzaConfigurazione(config)) {
      if (!problema.campo) continue;
      expect(esiste(config, problema.campo), problema.campo).toBe(true);
    }
  });
});

describe('analisi della configurazione', () => {
  it('su un server appena predisposto non resta nessun errore', () => {
    // Ciò che la predisposizione compila davvero: ruoli, canali di servizio,
    // verifica. Se dopo averla eseguita restassero errori, vorrebbe dire che la
    // predisposizione non basta a rendere coerente il bot.
    const config = defaultGuildConfig();
    config.general.quarantineRoleId = '100000000000000001';
    config.general.staffRoleIds = ['100000000000000002'];
    config.general.alertChannelId = '200000000000000001';
    config.logging.defaultChannelId = '200000000000000002';
    config.security.verification.verifiedRoleId = '100000000000000003';
    config.security.verification.unverifiedRoleId = '100000000000000004';
    config.security.verification.verifyChannelId = '200000000000000003';
    config.security.safety.reportChannelId = '200000000000000004';

    const errori = analizzaConfigurazione(config).filter(
      (problema) => problema.livello === 'errore',
    );
    expect(errori).toEqual([]);
  });

  it('riconosce il ruolo di quarantena usato anche per chi non ha verificato', () => {
    const config = defaultGuildConfig();
    config.general.quarantineRoleId = '100000000000000001';
    config.security.verification.unverifiedRoleId = '100000000000000001';

    const problemi = analizzaConfigurazione(config);
    expect(problemi.some((p) => p.titolo.includes('Stesso ruolo'))).toBe(true);
  });

  it('riconosce il ruolo di quarantena finito fra i ruoli staff', () => {
    const config = defaultGuildConfig();
    config.general.quarantineRoleId = '100000000000000001';
    config.general.staffRoleIds = ['100000000000000001'];

    const problemi = analizzaConfigurazione(config);
    expect(problemi.some((p) => p.titolo.includes('fra i ruoli staff'))).toBe(true);
  });

  it('riconosce le soglie invertite del rilevatore di account compromessi', () => {
    const config = defaultGuildConfig();
    config.security.compromise.deleteAtScore = 90;
    config.security.compromise.quarantineAtScore = 50;

    const problemi = analizzaConfigurazione(config);
    expect(problemi.some((p) => p.titolo === 'Soglie invertite')).toBe(true);
  });

  it('riconosce un modulo che dipende da uno spento', () => {
    const config = defaultGuildConfig();
    config.scanner.enabled = false;

    const problemi = analizzaConfigurazione(config);
    expect(
      problemi.some((p) => p.modulo === 'security.compromise' && p.dettaglio.includes('scanner')),
    ).toBe(true);
  });

  it('riconosce lo streamer con il ruolo in diretta e nessuno a cui darlo', () => {
    const config = defaultGuildConfig();
    config.integrations.twitch.enabled = true;
    config.integrations.twitch.streamers = [
      {
        enabled: true,
        login: 'tizio',
        announceChannelId: '200000000000000001',
        liveRoleId: '100000000000000005',
        discordUserId: null,
        mentionRoleId: null,
        template: '{streamer} è in diretta',
        cooldownMinutes: 60,
        clipMinViews: 0,
        clipChannelId: null,
      },
    ];

    const problemi = analizzaConfigurazione(config);
    expect(problemi.some((p) => p.titolo.includes('senza destinatario'))).toBe(true);
  });

  it('ordina dal più grave al più lieve', () => {
    const config = defaultGuildConfig();
    const livelli = analizzaConfigurazione(config).map((p) => p.livello);
    const ordine = { errore: 0, avviso: 1, nota: 2 };
    for (let i = 1; i < livelli.length; i += 1) {
      expect(ordine[livelli[i]!]).toBeGreaterThanOrEqual(ordine[livelli[i - 1]!]);
    }
  });
});

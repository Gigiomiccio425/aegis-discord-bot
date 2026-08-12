import { describe, expect, it } from 'vitest';
import { defaultGuildConfig, MODULE_REGISTRY } from '../config/index.js';
import { BY_PATH as FIELD_DOCS, COMMAND_DOCS, describeField, SECTION_DOCS } from '../config/docs.js';

/** Ogni foglia della configurazione, come percorso puntato. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('spiegazioni della configurazione', () => {
  /*
   * È il test che dà senso al file delle descrizioni. Senza, aggiungere
   * un'opzione senza spiegarla non rompe nulla: compare nel pannello come nome
   * tecnico, nessuno se ne accorge, e il divario si allarga versione dopo
   * versione finché metà delle spunte è di nuovo indecifrabile.
   */
  it('copre ogni singolo campo della configurazione predefinita', () => {
    const missing = leafPaths(defaultGuildConfig()).filter((path) => describeField(path) === null);
    expect(missing).toEqual([]);
  });

  /*
   * Il controllo opposto: una descrizione che parla di un'opzione non più
   * esistente. Non rompe niente, e proprio per questo resta lì per sempre — a
   * documentare un comportamento che il bot non ha, che è peggio di non
   * documentare affatto.
   */
  it('non descrive opzioni che non esistono più', () => {
    const config = defaultGuildConfig() as unknown as Record<string, unknown>;
    const esiste = (path: string): boolean =>
      path.split('.').reduce<unknown>((valore, chiave) => {
        if (valore === null || typeof valore !== 'object') return undefined;
        return (valore as Record<string, unknown>)[chiave];
      }, config) !== undefined;

    // Solo i percorsi completi: il file contiene anche scorciatoie `padre.campo`
    // che per costruzione non partono dalla radice della configurazione.
    const radici = ['general', 'security', 'scanner', 'logging', 'integrations'];
    const orfani = Object.keys(FIELD_DOCS).filter(
      (path) => radici.includes(path.split('.')[0]!) && path.includes('.') && !esiste(path),
    );

    expect(orfani).toEqual([]);
  });

  it('spiega cosa cambia, non ripete il nome del campo', () => {
    const doc = describeField('general.dryRun');
    expect(doc).not.toBeNull();
    // Una descrizione utile dice cosa succede: è più lunga dell'etichetta e
    // non si limita a riscriverla con altre parole.
    expect(doc!.help.length).toBeGreaterThan(doc!.label.length * 2);
    expect(doc!.help.toLowerCase()).not.toBe(doc!.label.toLowerCase());
  });

  it('risolve le chiavi ripetute in ogni modulo', () => {
    for (const path of [
      'security.antiRaid.enabled',
      'security.antiSpam.exemptions.roleIds',
      'integrations.twitch.enabled',
      'logging.retentionDays.MESSAGE',
      'security.antiNuke.rules.channelDelete.threshold.count',
    ]) {
      expect(describeField(path), path).not.toBeNull();
    }
  });

  it('preferisce il percorso esatto alla chiave generica', () => {
    const generic = describeField('security.antiNuke.enabled');
    const specific = describeField('logging.enabled');
    expect(generic!.label).toBe('Attivo');
    // `logging.enabled` ha una spiegazione propria: spegnere il registro non
    // mette in pausa nulla, cancella per sempre ciò che non viene scritto.
    expect(specific!.label).toBe('Registro attivo');
  });
});

describe('descrizione delle sezioni', () => {
  it('descrive ogni sezione del pannello', () => {
    const sections = ['general', ...MODULE_REGISTRY.map((module) => module.key)];
    const missing = sections.filter((key) => !SECTION_DOCS[key]);
    expect(missing).toEqual([]);
  });
});

describe('elenco dei comandi', () => {
  it('non elenca due volte lo stesso comando', () => {
    const names = COMMAND_DOCS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('dice per ogni comando cosa fa e chi può usarlo', () => {
    for (const command of COMMAND_DOCS) {
      expect(command.name.startsWith('/'), command.name).toBe(true);
      expect(command.summary.length, command.name).toBeGreaterThan(15);
      expect(command.permission.length, command.name).toBeGreaterThan(0);
    }
  });
});

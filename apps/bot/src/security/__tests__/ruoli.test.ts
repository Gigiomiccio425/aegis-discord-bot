import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { defaultGuildConfig } from '@angel/shared';
import { RUOLI, STILI, appiattisci, nomiConosciuti } from '../ruoli.js';
import { scegliSuperstite } from '../riparaRuoli.js';

const STILI_CHIAVI = STILI.map((voce) => voce.chiave);

/** Il valore a un percorso puntato della configurazione predefinita. */
function leggi(percorso: string): unknown {
  return percorso.split('.').reduce<unknown>((valore, chiave) => {
    if (valore && typeof valore === 'object' && chiave in valore) {
      return (valore as Record<string, unknown>)[chiave];
    }
    return undefined;
  }, defaultGuildConfig());
}

describe('il registro dei ruoli', () => {
  it('ha un vestito per ogni stile dichiarato', () => {
    for (const spec of RUOLI) {
      for (const stile of STILI_CHIAVI) {
        expect(spec.vestiti[stile], `${spec.chiave} in stile ${stile}`).toBeDefined();
      }
    }
  });

  it('non ripete nessuna chiave', () => {
    const chiavi = RUOLI.map((spec) => spec.chiave);
    expect(new Set(chiavi).size).toBe(chiavi.length);
  });

  /*
   * Il test che protegge dal danno peggiore.
   *
   * Due ruoli diversi con lo stesso nome in uno stile qualsiasi
   * significherebbe che `trovaRuolo` ne restituisce uno a caso, e che la
   * riparazione li considera doppioni e **ne cancella uno**. Sarebbe un ruolo
   * legittimo distrutto perché due righe di questo file si somigliavano.
   */
  it('nessun nome si ripete, in nessuno stile', () => {
    for (const stile of STILI_CHIAVI) {
      const nomi = RUOLI.map((spec) => spec.vestiti[stile].nome);
      const doppi = nomi.filter((nome, indice) => nomi.indexOf(nome) !== indice);
      expect(doppi, `nomi ripetuti nello stile ${stile}`).toEqual([]);
    }
  });

  /*
   * E nemmeno dopo la normalizzazione.
   *
   * La ricerca confronta i nomi appiattiti — via simboli, accenti e
   * maiuscole — perché chi rinomina a mano toglie quasi sempre i caratteri
   * decorativi. Due nomi che si appiattiscono allo stesso modo sono lo stesso
   * ruolo per il codice, anche se a schermo sono diversissimi.
   */
  it('nessun nome collide una volta appiattito, nemmeno fra stili diversi', () => {
    const visti = new Map<string, string>();

    for (const spec of RUOLI) {
      for (const nome of nomiConosciuti(spec)) {
        const piatto = appiattisci(nome);
        const primo = visti.get(piatto);
        expect(
          primo === undefined || primo === spec.chiave,
          `«${nome}» si confonde con il ruolo ${primo}`,
        ).toBe(true);
        visti.set(piatto, spec.chiave);
      }
    }
  });

  it('i percorsi di configurazione esistono davvero', () => {
    const inesistenti = RUOLI.flatMap((spec) =>
      spec.percorsi.filter((percorso) => leggi(percorso) === undefined),
    );
    expect(inesistenti).toEqual([]);
  });

  /*
   * Un percorso puntato da due ruoli diversi vorrebbe dire che due ruoli si
   * contendono lo stesso campo: l'ultimo eseguito vince, e quale sia dipende
   * dall'ordine dell'elenco.
   */
  it('nessun percorso è conteso fra due ruoli', () => {
    const tutti = RUOLI.flatMap((spec) => spec.percorsi);
    expect(new Set(tutti).size).toBe(tutti.length);
  });

  it('i ruoli di base sono quelli che servono alle difese', () => {
    const base = RUOLI.filter((spec) => spec.base).map((spec) => spec.chiave);
    expect(base).toContain('staff');
    expect(base).toContain('quarantena');
    expect(base).toContain('verificato');
    expect(base).toContain('non-verificato');
    // Guida, aiutanti e avvisi arrivano con il modello: su un'installazione
    // che vuole solo la sicurezza sarebbero ruoli decorativi mai chiesti.
    expect(base).not.toContain('guida');
    expect(base).not.toContain('avviso-video');
  });
});

/* ── Permessi ─────────────────────────────────────────────────────────── */

describe('i permessi che il bot assegna', () => {
  /*
   * Le tre chiavi del server.
   *
   * `Administrator` è tutto. `ManageRoles` permette di assegnarsi qualunque
   * ruolo sotto il proprio, quindi di arrivare a tutto. `ManageChannels`
   * permette di riscrivere ogni permesso di ogni canale, quindi di arrivare a
   * tutto. Un bot che le distribuisce da solo è un bot che regala il server,
   * e nessuno stile deve poterlo fare.
   */
  const VIETATI = [
    { nome: 'Administrator', bit: PermissionFlagsBits.Administrator },
    { nome: 'ManageRoles', bit: PermissionFlagsBits.ManageRoles },
    { nome: 'ManageChannels', bit: PermissionFlagsBits.ManageChannels },
    { nome: 'ManageGuild', bit: PermissionFlagsBits.ManageGuild },
    { nome: 'ManageWebhooks', bit: PermissionFlagsBits.ManageWebhooks },
  ];

  it('nessun livello contiene le chiavi del server', async () => {
    // I livelli non sono esportati di proposito — nessuno deve poterli
    // comporre da fuori — quindi si leggono dal sorgente. Meno elegante di un
    // import, e per un test di sicurezza è la lettura che conta.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const sorgente = readFileSync(
      fileURLToPath(new URL('../ruoli.ts', import.meta.url)),
      'utf8',
    );

    const blocco = sorgente.slice(
      sorgente.indexOf('const PERMESSI = {'),
      sorgente.indexOf('} as const;', sorgente.indexOf('const PERMESSI = {')),
    );

    /*
     * Parola intera, non sottostringa.
     *
     * `ManageGuildExpressions` — gestire emoji e adesivi — contiene
     * `ManageGuild`, e un confronto per sottostringa lo segnalerebbe come
     * chiave del server. Non lo è: dà accesso alle emoji, non alle
     * impostazioni. Il confine di parola evita di trasformare un test di
     * sicurezza in un test che si sbaglia e viene disattivato.
     */
    const contiene = (nome: string): boolean =>
      new RegExp('PermissionFlagsBits\\.' + nome + '(?![A-Za-z])').test(blocco);

    /*
     * La controprova.
     *
     * Un test di sicurezza che non sa fallire è peggio di nessun test: dà
     * la stessa tranquillità senza controllare niente. Prima di fidarsi
     * delle risposte negative si verifica che il rilevatore trovi un
     * permesso che *c'è* per davvero, e che non si faccia ingannare da
     * quello che gli somiglia.
     */
    expect(contiene('KickMembers'), 'il rilevatore non funziona').toBe(true);
    expect(contiene('ManageGuildExpressions')).toBe(true);

    for (const vietato of VIETATI) {
      expect(
        contiene(vietato.nome),
        `${vietato.nome} non deve comparire fra i permessi assegnati automaticamente`,
      ).toBe(false);
    }
  });

  it('solo staff e guida ricevono qualcosa', () => {
    const conPermessi = RUOLI.filter((spec) => spec.permessi !== 'NESSUNO').map(
      (spec) => spec.chiave,
    );
    expect(conPermessi.sort()).toEqual(['guida', 'staff']);
  });

  /*
   * La quarantena riceve permessi solo sopra il proprio cadavere.
   *
   * È il ruolo che serve a *togliere*: un permesso concesso qui annullerebbe
   * l'isolamento, e lo farebbe in silenzio — la persona resterebbe segnata
   * come in quarantena continuando a scrivere.
   */
  it('il ruolo isolante non riceve mai niente', () => {
    const quarantena = RUOLI.find((spec) => spec.isolante);
    expect(quarantena?.permessi).toBe('NESSUNO');
  });
});

/* ── Appiattimento ────────────────────────────────────────────────────── */

describe('confronto dei nomi', () => {
  it('ignora simboli, accenti e maiuscole', () => {
    expect(appiattisci('☾ Ali Guardiane')).toBe('ali guardiane');
    expect(appiattisci('ali guardiane')).toBe('ali guardiane');
    expect(appiattisci('⋆｡°✩ Angelo Maggiore')).toBe('angelo maggiore');
  });

  it('il separatore del nome tecnico non fa differenza', () => {
    expect(appiattisci('ANGEL · Staff')).toBe(appiattisci('Angel Staff'));
  });

  it('non confonde due nomi che condividono una parola', () => {
    expect(appiattisci('ANGEL · In diretta')).not.toBe(appiattisci('ANGEL · Avviso diretta'));
  });
});

/* ── Scelta del superstite ────────────────────────────────────────────── */

describe('quale doppione sopravvive', () => {
  const finto = (id: string, membri: number, position: number) =>
    ({ id, members: { size: membri }, position }) as never;

  it('vince quello scritto in configurazione, anche se ha meno gente', () => {
    const config = defaultGuildConfig();
    config.general.staffRoleIds = ['secondo'];

    const scelto = scegliSuperstite(
      [finto('primo', 100, 5), finto('secondo', 2, 1)],
      config,
      ['general.staffRoleIds'],
    );

    expect(scelto.id).toBe('secondo');
  });

  it('senza indicazioni vince quello con più persone', () => {
    const scelto = scegliSuperstite(
      [finto('poco', 3, 9), finto('molto', 40, 1)],
      defaultGuildConfig(),
      ['general.staffRoleIds'],
    );

    expect(scelto.id).toBe('molto');
  });

  it('a parità di persone vince il più alto', () => {
    const scelto = scegliSuperstite(
      [finto('basso', 5, 1), finto('alto', 5, 9)],
      defaultGuildConfig(),
      [],
    );

    expect(scelto.id).toBe('alto');
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   RIPARAZIONE DEI RUOLI DOPPI

   Serve ai server costruiti prima che i due elenchi diventassero uno: là
   fuori esistono installazioni con `ANGEL · Staff` **e** `☾ Ali Guardiane`,
   che significano la stessa cosa e non fanno la stessa cosa. Chi modera deve
   avere il secondo per comparire nella lista membri e il primo perché il bot
   lo esenti, e nessuno dei due da solo funziona.

   Cosa fa questo file: per ogni concetto trova tutti i ruoli che gli
   corrispondono, ne sceglie uno, sposta le persone dagli altri, cancella i
   vuoti e scrive l'identificativo giusto in configurazione.

   ── Perché si guarda prima e si agisce dopo ────────────────────────────

   Cancellare un ruolo è irreversibile e porta via con sé ogni permesso che
   qualcuno gli aveva dato sui canali, uno per uno, senza avviso. Il comando
   quindi **non fa niente** finché non glielo si chiede esplicitamente: la
   prima esecuzione dice cosa farebbe, e quel riepilogo è l'unica occasione
   di accorgersi che uno dei doppioni non era un doppione.

   ── Come si sceglie quello che sopravvive ──────────────────────────────

   In quest'ordine, e ogni gradino ha una ragione:

   1. **Quello scritto in configurazione.** È quello che il bot già usa: gli
      altri sono decorativi anche se sembrano più importanti.
   2. **Quello con più persone dentro.** Spostare dieci membri invece di
      cento è meno lavoro e meno occasioni di sbagliare.
   3. **Il più alto nella gerarchia.** Se sono pari, è quello che ha già i
      permessi sui canali configurati attorno.

   Un ruolo `managed` — creato da un'integrazione o da un altro bot — non
   viene mai toccato, nemmeno se il nome combacia: appartiene a qualcun altro.
   ═══════════════════════════════════════════════════════════════════════ */

import { PermissionFlagsBits, type Guild, type Role } from 'discord.js';
import { GuildConfigSchema, type GuildConfig } from '@angel/shared';
import { childLogger } from '../core/logger.js';
import { saveGuildConfig } from '../core/config.js';
import { applicaStile, RUOLI, trovaTutti, type StileRuoli } from './ruoli.js';

const log = childLogger('ripara-ruoli');

/**
 * Membri spostati al massimo, per ruolo doppio.
 *
 * Ogni spostamento sono due chiamate a Discord. Su un doppione con migliaia
 * di persone il comando finirebbe il limite di frequenza e si fermerebbe a
 * metà — con un ruolo cancellato e le persone divise fra i due. Meglio
 * fermarsi prima, dirlo, e non cancellare niente.
 */
const MAX_SPOSTAMENTI = 500;

export interface DoppioneTrovato {
  chiave: string;
  /** Quello che resta. */
  tiene: { id: string; nome: string; membri: number };
  /** Quelli che spariscono. */
  toglie: { id: string; nome: string; membri: number; motivo?: string }[];
}

export interface EsitoRiparazione {
  /** Nessuna modifica applicata: era solo un'anteprima. */
  anteprima: boolean;
  doppioni: DoppioneTrovato[];
  /** Ruoli mancanti del tutto, che verranno creati. */
  mancanti: string[];
  membriSpostati: number;
  ruoliEliminati: string[];
  campiCorretti: string[];
  rinominati: { da: string; a: string }[];
  permessiDati: { ruolo: string; quanti: number }[];
  avvisi: string[];
}

export interface OpzioniRiparazione {
  /** Falso = guarda e racconta. Vero = agisce. */
  applica?: boolean;
  /** Lo stile da applicare alla fine. Senza, resta quello già scelto. */
  stile?: StileRuoli;
  attore?: string;
}

/* ── Ingresso ─────────────────────────────────────────────────────────── */

export async function riparaRuoli(
  guild: Guild,
  config: GuildConfig,
  opzioni: OpzioniRiparazione = {},
): Promise<EsitoRiparazione> {
  const esito: EsitoRiparazione = {
    anteprima: !opzioni.applica,
    doppioni: [],
    mancanti: [],
    membriSpostati: 0,
    ruoliEliminati: [],
    campiCorretti: [],
    rinominati: [],
    permessiDati: [],
    avvisi: [],
  };

  const io = await guild.members.fetchMe().catch(() => null);
  if (!io?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    esito.avvisi.push('manca il permesso «Gestire i ruoli»: non posso toccare niente');
    return esito;
  }

  const bozza = GuildConfigSchema.parse(structuredClone(config));
  const stile = opzioni.stile ?? bozza.general.stileRuoli;

  /*
   * I membri servono per contarli e per spostarli.
   *
   * Un `fetch` di tutti su un server grande è lento, ma è l'unica cosa che
   * dice davvero quante persone ha un ruolo: la cache contiene solo chi si è
   * fatto vedere di recente, e su quella base si sceglierebbe di cancellare
   * il ruolo sbagliato.
   */
  await guild.members.fetch().catch((errore: unknown) => {
    log.warn({ err: errore, guildId: guild.id }, 'elenco dei membri non caricato');
    esito.avvisi.push(
      'non sono riuscito a caricare tutti i membri: i conteggi qui sotto sono parziali',
    );
    return null;
  });

  for (const spec of RUOLI) {
    const candidati = trovaTutti(guild, spec).filter((ruolo) => !ruolo.managed);

    if (candidati.length === 0) {
      esito.mancanti.push(spec.vestiti[stile].nome);
      continue;
    }
    if (candidati.length === 1) {
      // Uno solo: non è un doppione, ma la configurazione potrebbe puntare
      // altrove o a niente. Si corregge comunque.
      if (opzioni.applica) esito.campiCorretti.push(...scriviPercorsi(bozza, spec.percorsi, candidati[0]!.id));
      continue;
    }

    const tiene = scegliSuperstite(candidati, bozza, spec.percorsi);
    const toglie = candidati.filter((ruolo) => ruolo.id !== tiene.id);

    const doppione: DoppioneTrovato = {
      chiave: spec.chiave,
      tiene: { id: tiene.id, nome: tiene.name, membri: tiene.members.size },
      toglie: toglie.map((ruolo) => ({
        id: ruolo.id,
        nome: ruolo.name,
        membri: ruolo.members.size,
      })),
    };

    if (!opzioni.applica) {
      esito.doppioni.push(doppione);
      continue;
    }

    for (const vecchio of toglie) {
      const problema = perchéNonPosso(vecchio, io.roles.highest.position);
      if (problema) {
        const voce = doppione.toglie.find((v) => v.id === vecchio.id);
        if (voce) voce.motivo = problema;
        esito.avvisi.push(`«${vecchio.name}» lasciato dov'è: ${problema}`);
        continue;
      }

      const spostati = await trasferisci(vecchio, tiene, esito);
      esito.membriSpostati += spostati;

      // Si cancella **solo se è vuoto**. Se qualcuno è rimasto dentro — un
      // limite di frequenza a metà strada, un membro che Discord non ha
      // restituito — cancellare significherebbe togliergli il ruolo senza
      // avergli dato il sostituto.
      if (vecchio.members.size > 0) {
        const voce = doppione.toglie.find((v) => v.id === vecchio.id);
        if (voce) voce.motivo = `${vecchio.members.size} persone non spostate: non lo cancello`;
        esito.avvisi.push(
          `«${vecchio.name}» non cancellato: ${vecchio.members.size} persone sono ancora dentro`,
        );
        continue;
      }

      const cancellato = await vecchio
        .delete(`Doppione di «${tiene.name}», unificato${opzioni.attore ? ` da ${opzioni.attore}` : ''}`)
        .then(() => true)
        .catch((errore: unknown) => {
          log.warn({ err: errore, ruolo: vecchio.name }, 'ruolo doppio non eliminato');
          esito.avvisi.push(`«${vecchio.name}» non eliminato: Discord ha rifiutato`);
          return false;
        });

      if (cancellato) esito.ruoliEliminati.push(vecchio.name);
    }

    esito.campiCorretti.push(...scriviPercorsi(bozza, spec.percorsi, tiene.id));
    esito.doppioni.push(doppione);
  }

  if (!opzioni.applica) return esito;

  /* ── Il vestito, alla fine ──────────────────────────────────────
     Dopo l'unione e non prima: rinominare due doppioni allo stesso nome
     produrrebbe due ruoli identici, che è il problema peggiorato. */
  const applicato = await applicaStile(guild, bozza, stile, {
    crea: true,
    permessi: true,
    ...(opzioni.attore ? { attore: opzioni.attore } : {}),
  });

  esito.rinominati = applicato.rinominati;
  esito.permessiDati = applicato.permessiDati;
  for (const saltato of applicato.saltati) {
    esito.avvisi.push(`«${saltato.ruolo}» non rivestito: ${saltato.motivo}`);
  }

  if (bozza.general.stileRuoli !== stile) {
    bozza.general.stileRuoli = stile;
    esito.campiCorretti.push('general.stileRuoli');
  }

  if (esito.campiCorretti.length > 0) {
    await saveGuildConfig(guild.id, bozza, {
      id: opzioni.attore ?? 'system',
      source: 'command',
      paths: esito.campiCorretti,
    }).catch((errore: unknown) => {
      log.error({ err: errore, guildId: guild.id }, 'configurazione non salvata');
      esito.avvisi.push('i ruoli sono a posto ma la configurazione non si è salvata');
    });
  }

  log.info(
    {
      guildId: guild.id,
      doppioni: esito.doppioni.length,
      spostati: esito.membriSpostati,
      eliminati: esito.ruoliEliminati.length,
    },
    'riparazione dei ruoli completata',
  );

  return esito;
}

/* ── Scelta ───────────────────────────────────────────────────────────── */

export function scegliSuperstite(
  candidati: Role[],
  config: GuildConfig,
  percorsi: string[],
): Role {
  // 1. Quello che il bot già usa.
  for (const percorso of percorsi) {
    const valore = leggi(config, percorso);
    const ids = Array.isArray(valore) ? valore : [valore];
    const trovato = candidati.find((ruolo) => ids.includes(ruolo.id));
    if (trovato) return trovato;
  }

  // 2. Quello con più persone. 3. A parità, il più alto.
  return [...candidati].sort(
    (a, b) => b.members.size - a.members.size || b.position - a.position,
  )[0]!;
}

/** Perché un ruolo non si può toccare. `null` = si può. */
function perchéNonPosso(ruolo: Role, altezzaBot: number): string | null {
  if (ruolo.managed) return 'appartiene a un\'integrazione';
  if (ruolo.id === ruolo.guild.id) return 'è @everyone';
  if (ruolo.position >= altezzaBot) return 'sta più in alto del mio ruolo';
  if (ruolo.members.size > MAX_SPOSTAMENTI) {
    return `ha ${ruolo.members.size} persone: troppe da spostare in una volta`;
  }
  return null;
}

/* ── Spostamento ──────────────────────────────────────────────────────── */

/**
 * Sposta le persone da un ruolo all'altro.
 *
 * Prima si dà il nuovo, poi si toglie il vecchio. L'ordine conta: al
 * contrario, un errore fra le due chiamate lascerebbe la persona senza
 * nessuno dei due — e su un ruolo che dà accesso ai canali significa
 * chiudere fuori qualcuno che non ha fatto niente.
 */
async function trasferisci(da: Role, a: Role, esito: EsitoRiparazione): Promise<number> {
  let spostati = 0;

  for (const [, membro] of da.members) {
    if (!membro.roles.cache.has(a.id)) {
      const dato = await membro.roles
        .add(a, `Unificazione dei ruoli: da «${da.name}»`)
        .then(() => true)
        .catch(() => false);

      if (!dato) {
        esito.avvisi.push(`non sono riuscito a dare «${a.name}» a ${membro.user.tag}`);
        continue;
      }
    }

    const tolto = await membro.roles
      .remove(da, `Unificazione dei ruoli: verso «${a.name}»`)
      .then(() => true)
      .catch(() => false);

    if (tolto) spostati += 1;
  }

  return spostati;
}

/* ── Configurazione ───────────────────────────────────────────────────── */

function leggi(oggetto: unknown, percorso: string): unknown {
  return percorso.split('.').reduce<unknown>((valore, chiave) => {
    if (valore && typeof valore === 'object' && chiave in valore) {
      return (valore as Record<string, unknown>)[chiave];
    }
    return undefined;
  }, oggetto);
}

/**
 * Scrive l'identificativo, **sostituendo** quello che c'era.
 *
 * Diverso dalla predisposizione, che scrive solo nei campi vuoti per non
 * calpestare le scelte di nessuno. Qui il punto è proprio correggere un campo
 * che punta a un ruolo che sta per sparire: rispettarlo lascerebbe la
 * configurazione a indicare un ruolo eliminato.
 */
function scriviPercorsi(
  config: GuildConfig,
  percorsi: string[],
  id: string,
): string[] {
  const cambiati: string[] = [];

  for (const percorso of percorsi) {
    const chiavi = percorso.split('.');
    const ultima = chiavi.pop();
    if (!ultima) continue;

    let cursore = config as unknown as Record<string, unknown>;
    let valido = true;
    for (const chiave of chiavi) {
      const prossimo = cursore[chiave];
      if (typeof prossimo !== 'object' || prossimo === null) {
        valido = false;
        break;
      }
      cursore = prossimo as Record<string, unknown>;
    }
    if (!valido) continue;

    const attuale = cursore[ultima];

    if (Array.isArray(attuale)) {
      if (attuale.includes(id)) continue;
      // Gli altri identificativi restano: un elenco di ruoli staff può
      // contenere ruoli scelti a mano, e sostituirlo con il solo nostro
      // toglierebbe i permessi a chi li aveva.
      cursore[ultima] = [...attuale, id];
      cambiati.push(percorso);
      continue;
    }

    if (attuale === id) continue;
    cursore[ultima] = id;
    cambiati.push(percorso);
  }

  return cambiati;
}

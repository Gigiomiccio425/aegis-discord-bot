import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import { BOT_NON_IN_ASCOLTO, botNonInAscolto } from '../../redis.js';

/* ═══════════════════════════════════════════════════════════════════════
   UN COMANDO CHE NESSUNO RICEVE NON È «FATTO»

   Per settimane lockdown e backup dal pannello hanno risposto «fatto» senza
   che il bot li ricevesse: pannello e bot erano collegati a due Redis
   diversi, e il pannello non guardava quanti avevano ricevuto il comando.

   Adesso le rotte in cui il comando **è** l'azione rispondono 503 quando i
   ricevitori sono zero. Questo test tiene ferma la regola nei due versi:

   • ogni rotta che manda un'azione controlla il recapito — una rotta nuova
     che se lo dimentica torna a dire «fatto» per niente;
   • le rotte che mandano un avviso dopo un salvataggio **non** lo fanno —
     lì un 503 farebbe sembrare fallito un salvataggio andato bene.

   Il confronto è sul testo, come negli altri test di deriva del progetto.
   ═══════════════════════════════════════════════════════════════════════ */

const qui = path.dirname(fileURLToPath(import.meta.url));
const ROTTE = path.resolve(qui, '..');

/** Comandi che partono dopo un salvataggio: il salvataggio è l'azione. */
const DOPO_UN_SALVATAGGIO = new Set(['config.reloaded', 'commands.reload']);

/**
 * Comandi che partono dopo una scrittura nel database fatta dalla rotta
 * stessa. Un 503 direbbe «fallito» di qualcosa che nel registro è già
 * cambiato: si lasciano alla riga di log di `sendBotCommand`.
 */
const DOPO_UNA_SCRITTURA = new Set(['case.undo']);

interface Chiamata {
  file: string;
  azione: string;
  controllata: boolean;
  /** Dentro un ciclo: il rilascio dell'incidente, dopo scritture. */
  inUnCiclo: boolean;
}

function leggiChiamate(): Chiamata[] {
  const chiamate: Chiamata[] = [];
  for (const file of readdirSync(ROTTE).filter((f) => f.endsWith('.ts'))) {
    const righe = readFileSync(path.join(ROTTE, file), 'utf8').split(/\r?\n/);
    righe.forEach((riga, i) => {
      const trovata = /^(\s*)(?:const ricevuto = )?await sendBotCommand\(\{/.exec(riga);
      if (!trovata) return;
      const azione = /action:\s*'([^']+)'/.exec(righe.slice(i, i + 3).join(' '))?.[1];
      if (!azione) return;
      const seguito = righe.slice(i, i + 15).join('\n');
      chiamate.push({
        file,
        azione,
        controllata: seguito.includes('if (!ricevuto) return botNonInAscolto(reply);'),
        inUnCiclo: trovata[1]!.length > 6,
      });
    });
  }
  return chiamate;
}

describe('comandi che nessuno riceve', () => {
  it('la risposta è 503, con un testo che dice cosa fare', () => {
    let codice = 0;
    let corpo: unknown;
    const reply = {
      code(c: number) {
        codice = c;
        return this;
      },
      send(b: unknown) {
        corpo = b;
        return this;
      },
    } as unknown as FastifyReply;

    botNonInAscolto(reply);

    expect(codice).toBe(503);
    // `error` è il campo che il pannello mostra.
    expect(corpo).toEqual({ error: BOT_NON_IN_ASCOLTO });
    expect(BOT_NON_IN_ASCOLTO).toContain('non ha ricevuto');
  });

  const chiamate = leggiChiamate();

  it('le rotte si leggono', () => {
    // La controprova: senza, una lettura sbagliata non troverebbe niente e
    // i due test sotto passerebbero su qualunque codice.
    expect(chiamate.length).toBeGreaterThan(10);
    expect(chiamate.some((c) => c.azione === 'lockdown.enable')).toBe(true);
  });

  it('ogni azione controlla che il bot l’abbia ricevuta', () => {
    const scoperte = chiamate
      .filter((c) => !DOPO_UN_SALVATAGGIO.has(c.azione) && !DOPO_UNA_SCRITTURA.has(c.azione))
      .filter((c) => !c.inUnCiclo)
      .filter((c) => !c.controllata)
      .map((c) => `${c.file}: ${c.azione}`);

    expect(scoperte, 'azioni che direbbero «fatto» anche senza bot').toEqual([]);
  });

  it('gli avvisi dopo un salvataggio non fanno fallire il salvataggio', () => {
    const sbagliate = chiamate
      .filter((c) => DOPO_UN_SALVATAGGIO.has(c.azione) && c.controllata)
      .map((c) => `${c.file}: ${c.azione}`);

    expect(sbagliate).toEqual([]);
  });
});

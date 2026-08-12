/* ═══════════════════════════════════════════════════════════════════════
   RIENTRO DAL NODO DI EMERGENZA

   Quando il server principale è giù, il nodo di emergenza lavora sul proprio
   database. Al rientro quei dati vanno riportati indietro, altrimenti le ore
   passate in emergenza spariscono: i provvedimenti presi non risultano, il
   registro ha un buco, e chi rivede un caso non trova la riga che lo spiega.

   ── Cosa si importa, e perché solo quello ────────────────────────────────

   Solo le tabelle **append-only**: eventi del registro, provvedimenti,
   messaggi archiviati, incidenti. Sono righe che nascono e non cambiano più,
   quindi unirle è un'operazione senza ambiguità — o la riga c'è, o va
   aggiunta.

   **La configurazione non si importa mai.** È l'unica cosa che entrambi i
   nodi possono aver modificato nello stesso periodo, e non esiste un criterio
   corretto per decidere quale versione vince: sovrascrivere quella del
   principale con quella di un nodo temporaneo significherebbe perdere le
   modifiche fatte dal pannello nel frattempo. Chi ha cambiato qualcosa in
   emergenza lo rifà, e sono due minuti.

   Stesso ragionamento per profili utente e sessioni: contengono contatori e
   stati che i due nodi hanno fatto evolvere in parallelo, e sommarli
   produrrebbe numeri che non corrispondono a niente.

   ── Come si evitano i duplicati ──────────────────────────────────────────

   Gli identificatori sono generati dal database (`uuid`) o da Discord
   (snowflake), quindi sono già unici fra i due nodi. `skipDuplicates` fa il
   resto: reimportare due volte lo stesso file non produce righe doppie, e
   questo conta perché un rientro interrotto va poi ripetuto.
   ═══════════════════════════════════════════════════════════════════════ */

import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@angel/db';
import { getSessionUser, ownerIds } from '../auth.js';
import { logger } from '../logger.js';

/**
 * Tabelle importabili, in ordine di dipendenza.
 *
 * `guild` per prima: tutto il resto vi si riferisce, e inserire un evento che
 * punta a un server non ancora presente fallirebbe sul vincolo.
 */
const IMPORTABILI = [
  'guild',
  'incident',
  'case',
  'auditEvent',
  'messageArchive',
  'attachmentArchive',
  'voiceSession',
] as const;

type Tabella = (typeof IMPORTABILI)[number];

interface EsitoTabella {
  tabella: string;
  lette: number;
  inserite: number;
  errore?: string;
}

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Importa un'esportazione prodotta dal nodo di emergenza.
   *
   * Riservato ai proprietari del bot e non ai soli amministratori del server:
   * chi può eseguire questa chiamata può inserire righe arbitrarie nel
   * registro e nei provvedimenti, cioè riscrivere la storia di ciò che è
   * successo. È un potere che non ha senso delegare.
   */
  app.post<{ Body: { tabelle?: Record<string, unknown[]> } }>(
    '/api/sync/import',
    async (request, reply) => {
      const session = await getSessionUser(request);
      if (!session) return reply.code(401).send({ error: 'non autenticato' });
      if (!ownerIds().includes(session.id)) {
        return reply.code(403).send({
          error: 'Riservato ai proprietari del bot: importare significa poter riscrivere il registro.',
        });
      }

      const tabelle = request.body?.tabelle;
      if (!tabelle || typeof tabelle !== 'object') {
        return reply.code(400).send({ error: 'corpo non valido: manca `tabelle`' });
      }

      const prisma = getPrisma() as unknown as Record<
        string,
        { createMany: (args: unknown) => Promise<{ count: number }> }
      >;

      const esiti: EsitoTabella[] = [];

      for (const tabella of IMPORTABILI) {
        const righe = tabelle[tabella];
        if (!Array.isArray(righe) || righe.length === 0) continue;

        const modello = prisma[tabella as Tabella];
        if (!modello?.createMany) continue;

        try {
          // A blocchi: un'importazione di centomila eventi in una sola query
          // supera i limiti dei parametri di Postgres e fallisce per intero,
          // proprio quando si sta recuperando da un disservizio.
          let inserite = 0;
          for (let i = 0; i < righe.length; i += 500) {
            const blocco = righe.slice(i, i + 500);
            const risultato = await modello.createMany({ data: blocco, skipDuplicates: true });
            inserite += risultato.count;
          }
          esiti.push({ tabella, lette: righe.length, inserite });
        } catch (errore) {
          logger.warn({ err: errore, tabella }, 'importazione della tabella fallita');
          esiti.push({
            tabella,
            lette: righe.length,
            inserite: 0,
            errore: errore instanceof Error ? errore.message.slice(0, 200) : 'errore sconosciuto',
          });
        }
      }

      const inserite = esiti.reduce((somma, esito) => somma + esito.inserite, 0);
      logger.info({ inserite, tabelle: esiti.length }, 'rientro dal nodo di emergenza');

      return {
        ok: true,
        inserite,
        dettaglio: esiti,
        // Detto esplicitamente, perché chi importa se lo aspetta e non deve
        // scoprirlo dal fatto che una modifica è sparita.
        nota:
          'Configurazione, profili utente e sessioni non vengono importati: ' +
          'sono gli unici dati che entrambi i nodi possono aver modificato in parallelo, ' +
          'e non esiste un criterio corretto per decidere quale versione vince.',
      };
    },
  );
}

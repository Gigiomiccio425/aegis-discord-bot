/* ═══════════════════════════════════════════════════════════════════════
   STATO DI SALUTE

   Esisteva `/health` come indirizzo HTTP, che serve al nodo di emergenza e a
   chi ha un terminale aperto. Non serviva a chi è su Discord e vede i comandi
   non rispondere: da lì l'unica informazione disponibile era «l'applicazione
   non ha risposto», che è vera per qualunque causa.

   Questo comando dice **quale** pezzo è rotto. Il caso che l'ha reso
   necessario: disco pieno, Redis che rifiuta ogni scrittura, e il bot che
   sembrava semplicemente non funzionare più.
   ═══════════════════════════════════════════════════════════════════════ */

import { statfs } from 'node:fs/promises';
import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getPrisma } from '@angel/db';
import { runningVersion } from '@angel/shared';
import type { Command } from './types.js';
import { getRedis } from '../core/redis.js';

function durata(secondi: number): string {
  const giorni = Math.floor(secondi / 86400);
  const ore = Math.floor((secondi % 86400) / 3600);
  const minuti = Math.floor((secondi % 3600) / 60);
  if (giorni > 0) return `${giorni}g ${ore}h`;
  if (ore > 0) return `${ore}h ${minuti}m`;
  return `${minuti}m`;
}

/**
 * Redis risponde, ma accetta ancora scritture?
 *
 * La distinzione conta: con il disco pieno Redis continua a rispondere a
 * `PING` mentre rifiuta ogni scrittura. Un controllo che si ferma al ping dice
 * «tutto bene» proprio nel momento in cui non funziona più niente.
 */
async function provaScrittura(): Promise<{ ok: boolean; dettaglio: string }> {
  try {
    await getRedis().set('angel:salute:prova', '1', 'EX', 30);
    return { ok: true, dettaglio: 'legge e scrive' };
  } catch (errore) {
    const messaggio = (errore as Error).message ?? '';
    if (messaggio.includes('MISCONF')) {
      return {
        ok: false,
        dettaglio: 'rifiuta le scritture — non riesce a salvare su disco (disco pieno?)',
      };
    }
    return { ok: false, dettaglio: messaggio.slice(0, 150) || 'errore sconosciuto' };
  }
}

const salute: Command = {
  data: new SlashCommandBuilder()
    .setName('salute')
    .setDescription('Stato del bot: database, Redis, disco, versione')
    .setDMPermission(false),
  async execute({ client, interaction }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const prisma = getPrisma();

    const database = await prisma
      .$queryRaw`SELECT 1`
      .then(() => ({ ok: true, dettaglio: 'raggiungibile' }))
      .catch((errore: Error) => ({ ok: false, dettaglio: errore.message.slice(0, 150) }));

    const redis = await provaScrittura();

    let disco = 'non leggibile';
    let discoOk = true;
    try {
      const stat = await statfs(process.env.STORAGE_DIR ?? '/data');
      const totale = stat.blocks * stat.bsize;
      const libero = stat.bavail * stat.bsize;
      const usato = totale > 0 ? Math.round((1 - libero / totale) * 100) : 0;

      // Gli inode finiscono per conto loro, e quando finiscono il sistema dice
      // «No space left on device» con centinaia di giga liberi. Senza questo
      // numero, quel messaggio manda a cercare nel posto sbagliato.
      const inode = stat.files > 0 ? Math.round((1 - stat.ffree / stat.files) * 100) : 0;

      discoOk = usato < 90 && inode < 90;
      disco =
        `Spazio: **${usato}%** usato · ${(libero / 1_073_741_824).toFixed(1)} GB liberi ` +
        `su ${(totale / 1_073_741_824).toFixed(1)}
` +
        `Inode: **${inode}%** usati` +
        (inode >= 90
          ? ' — **è questo il problema**: i file sono troppi, non troppo grandi'
          : '');
    } catch {
      /* Su alcune configurazioni il percorso non esiste: non è un guasto. */
    }

    const tutto = database.ok && redis.ok && discoOk;
    const segno = (ok: boolean): string => (ok ? '🟢' : '🔴');

    const embed = new EmbedBuilder()
      .setTitle(tutto ? '🟢 ANGEL funziona' : '🔴 Qualcosa non va')
      .setColor(tutto ? 0x6f8a95 : 0xe05263)
      .addFields(
        { name: `${segno(database.ok)} Database`, value: database.dettaglio, inline: false },
        { name: `${segno(redis.ok)} Redis`, value: redis.dettaglio, inline: false },
        { name: `${segno(discoOk)} Disco`, value: disco, inline: false },
        {
          name: 'Bot',
          value:
            `Versione **${runningVersion()}**\n` +
            `Acceso da ${durata(process.uptime())}\n` +
            `Latenza gateway: ${Math.max(0, Math.round(client.ws.ping))} ms\n` +
            `Server: ${client.guilds.cache.size}`,
          inline: false,
        },
      );

    if (!redis.ok) {
      embed.setFooter({
        text: 'Con Redis bloccato quasi nessun comando funziona: è la prima cosa da sistemare.',
      });
    } else if (!discoOk) {
      embed.setFooter({ text: 'Sopra il 90% il disco pieno ferma database e code.' });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

export const healthCommands: Command[] = [salute];

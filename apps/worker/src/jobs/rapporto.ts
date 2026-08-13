import { statfs } from 'node:fs/promises';
import { getPrisma } from '@angel/db';
import { analizzaConfigurazione, GuildConfigSchema, runningVersion } from '@angel/shared';
import { childLogger } from '../logger.js';
import { inviaInPrivato } from '../discord.js';

const log = childLogger('rapporto');

/* ═══════════════════════════════════════════════════════════════════════
   RAPPORTO GIORNALIERO

   Ogni notte, a chi possiede il bot, un messaggio privato per server: cosa è
   successo nelle ventiquattro ore e cosa non va nella configurazione.

   La ragione è che il pannello lo si apre quando si sospetta un problema, e
   quindi non lo si apre mai finché il problema non è già successo. Un rapporto
   che arriva da solo racconta anche i giorni in cui non è successo niente — ed
   è confrontando quei giorni che ci si accorge di quello in cui è successo
   qualcosa.

   I limiti di Discord non sono un dettaglio da gestire in fondo: 4096 caratteri
   per descrizione, 1024 per campo, 6000 per messaggio, 25 campi e 10 embed.
   Superarne uno significa che il messaggio non parte affatto, quindi ogni
   pezzo viene troncato alla fonte e il rapporto si divide in più messaggi
   invece di crescere.
   ═══════════════════════════════════════════════════════════════════════ */

const MAX_CAMPO = 1000;
const MAX_DESCRIZIONE = 3800;
const EMBED_PER_MESSAGGIO = 8;

interface Embed {
  title: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
}

function taglia(testo: string, massimo: number): string {
  if (testo.length <= massimo) return testo;
  return testo.slice(0, massimo - 1) + '…';
}

/** Conta le righe di un elenco per chiave, tenendo solo le più frequenti. */
function classifica(voci: { chiave: string; quanti: number }[], quante: number): string {
  if (voci.length === 0) return '—';
  return voci
    .slice(0, quante)
    .map((voce) => `${voce.chiave}: **${voce.quanti}**`)
    .join('\n');
}

export async function rapportoProcessor(): Promise<void> {
  const destinatari = (process.env.OWNER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d{17,20}$/.test(id));

  if (destinatari.length === 0) {
    log.debug('nessun proprietario configurato: rapporto non inviato');
    return;
  }

  const prisma = getPrisma();
  const guilds = await prisma.guild.findMany({ where: { active: true } });
  if (guilds.length === 0) return;

  const da = new Date(Date.now() - 86_400_000);
  const embeds: Embed[] = [];
  let totaleEventi = 0;
  let totaleProvvedimenti = 0;
  let serverConErrori = 0;

  for (const guild of guilds) {
    const scheda = await schedaServer(guild.id, guild.name, guild.config, da);
    embeds.push(scheda.embed);
    totaleEventi += scheda.eventi;
    totaleProvvedimenti += scheda.provvedimenti;
    if (scheda.errori > 0) serverConErrori += 1;
  }

  const sistema = await statoSistema();

  const intestazione: Embed = {
    title: `🛡️ ANGEL · rapporto del ${new Date().toLocaleDateString('it-IT')}`,
    color: sistema.critico ? 0xe05263 : serverConErrori > 0 ? 0xd8b45f : 0x6f8a95,
    description: taglia(
      `**${guilds.length}** ${guilds.length === 1 ? 'server' : 'server'} · ` +
        `**${totaleEventi}** eventi registrati · **${totaleProvvedimenti}** provvedimenti\n` +
        (serverConErrori > 0
          ? `⚠️ **${serverConErrori}** ${serverConErrori === 1 ? 'server ha' : 'server hanno'} una configurazione da sistemare — dettagli qui sotto.`
          : 'Nessun problema di configurazione.'),
      MAX_DESCRIZIONE,
    ),
    fields: [{ name: 'Macchina', value: taglia(sistema.testo, MAX_CAMPO) }],
    footer: { text: `versione ${runningVersion()} · le ultime 24 ore` },
  };

  const tutti = [intestazione, ...embeds];

  for (const destinatario of destinatari) {
    // A blocchi: dieci embed è il limite per messaggio, e restare sotto evita
    // che un server in più faccia sparire l'intero rapporto.
    for (let i = 0; i < tutti.length; i += EMBED_PER_MESSAGGIO) {
      const blocco = tutti.slice(i, i + EMBED_PER_MESSAGGIO);
      const inviato = await inviaInPrivato(destinatario, { embeds: blocco });
      if (!inviato) {
        log.warn({ destinatario }, 'rapporto non consegnato: forse ha i messaggi privati chiusi');
        break;
      }
    }
  }

  log.info({ server: guilds.length, destinatari: destinatari.length }, 'rapporto giornaliero inviato');
}

/**
 * Spazio su disco e peso di ciò che il bot conserva.
 *
 * Sta in cima al rapporto perché il disco pieno è il guasto che non si
 * annuncia: il bot risponde ancora, il pannello si apre, e intanto Postgres
 * non riesce più a scrivere e Redis blocca le code. Quando ce se ne accorge
 * è già tutto fermo da ore.
 */
async function statoSistema(): Promise<{ testo: string; critico: boolean }> {
  const prisma = getPrisma();
  const righe: string[] = [];
  let critico = false;

  try {
    const stat = await statfs(process.env.STORAGE_DIR ?? '/data');
    const totale = stat.blocks * stat.bsize;
    const libero = stat.bavail * stat.bsize;
    const usato = totale > 0 ? Math.round((1 - libero / totale) * 100) : 0;
    const giga = (byte: number): string => (byte / 1_073_741_824).toFixed(1);

    critico = usato >= 90;
    righe.push(
      `${critico ? '🔴' : usato >= 75 ? '🟠' : '🟢'} Disco: **${usato}%** usato · ` +
        `${giga(libero)} GB liberi su ${giga(totale)}`,
    );
    if (critico) {
      righe.push('**Sopra il 90% il bot smette di funzionare bene: fai spazio adesso.**');
    }
  } catch {
    righe.push('Disco: non leggibile');
  }

  const [firme, archivio, eventi] = await Promise.all([
    prisma.threatSignature.count().catch(() => 0),
    prisma.messageArchive.count().catch(() => 0),
    prisma.auditEvent.count().catch(() => 0),
  ]);

  righe.push(
    `Righe: **${eventi.toLocaleString('it-IT')}** eventi · ` +
      `**${archivio.toLocaleString('it-IT')}** messaggi · ` +
      `**${firme.toLocaleString('it-IT')}** firme di minaccia`,
  );

  return { testo: righe.join('\n'), critico };
}

/** La scheda di un singolo server. */
async function schedaServer(
  guildId: string,
  nome: string,
  configGrezza: unknown,
  da: Date,
): Promise<{ embed: Embed; eventi: number; provvedimenti: number; errori: number }> {
  const prisma = getPrisma();

  const [perCategoria, perTipo, casi, profili, ticket, incidenti, archivio] = await Promise.all([
    prisma.auditEvent.groupBy({
      by: ['category'],
      where: { guildId, createdAt: { gte: da } },
      _count: true,
    }),
    prisma.auditEvent.groupBy({
      by: ['type'],
      where: { guildId, createdAt: { gte: da } },
      _count: true,
      orderBy: { _count: { type: 'desc' } },
      take: 8,
    }),
    prisma.case.groupBy({
      by: ['type'],
      where: { guildId, createdAt: { gte: da } },
      _count: true,
    }),
    prisma.userProfile.aggregate({
      where: { guildId },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ['status'],
      where: { guildId, createdAt: { gte: da } },
      _count: true,
    }),
    prisma.incident.findMany({
      where: { guildId, startedAt: { gte: da } },
      orderBy: { startedAt: 'desc' },
      take: 5,
    }),
    prisma.messageArchive.count({ where: { guildId, createdAt: { gte: da } } }),
  ]);

  const [quarantenati, attenzionati, aRischio, eliminati] = await Promise.all([
    prisma.userProfile.count({ where: { guildId, quarantinedAt: { not: null } } }),
    prisma.userProfile.count({ where: { guildId, watchedAt: { not: null } } }),
    prisma.userProfile.count({ where: { guildId, riskScore: { gte: 60 } } }),
    prisma.messageArchive.count({ where: { guildId, deletedAt: { gte: da } } }),
  ]);

  const eventi = perCategoria.reduce((totale, riga) => totale + riga._count, 0);
  const provvedimenti = casi.reduce((totale, riga) => totale + riga._count, 0);

  const ingressi = perTipo.find((riga) => riga.type === 'MEMBER_JOINED')?._count ?? 0;
  const uscite = perTipo.find((riga) => riga.type === 'MEMBER_LEFT')?._count ?? 0;

  /* Diagnosi della configurazione: la parte che il rapporto ha in più
     rispetto a un riepilogo di numeri. Un server che non ha avuto incidenti
     ma ha l'anti-nuke senza ruolo di quarantena non è un server tranquillo,
     è un server scoperto. */
  const parsed = GuildConfigSchema.safeParse(configGrezza);
  const problemi = parsed.success ? analizzaConfigurazione(parsed.data) : [];
  const errori = problemi.filter((problema) => problema.livello === 'errore');
  const avvisi = problemi.filter((problema) => problema.livello === 'avviso');

  const fields: Embed['fields'] = [];

  fields.push({
    name: 'Movimento',
    value: taglia(
      `Ingressi: **${ingressi}**\nUscite: **${uscite}**\n` +
        `Messaggi archiviati: **${archivio}**\nEliminati: **${eliminati}**`,
      MAX_CAMPO,
    ),
    inline: true,
  });

  fields.push({
    name: 'Persone sotto osservazione',
    value: taglia(
      `In quarantena: **${quarantenati}**\nAttenzionati: **${attenzionati}**\n` +
        `Rischio alto: **${aRischio}**\nProfili noti: **${profili._count._all}**`,
      MAX_CAMPO,
    ),
    inline: true,
  });

  if (provvedimenti > 0) {
    fields.push({
      name: `Provvedimenti (${provvedimenti})`,
      value: taglia(
        classifica(
          casi.map((riga) => ({ chiave: riga.type.toLowerCase(), quanti: riga._count })).sort((a, b) => b.quanti - a.quanti),
          10,
        ),
        MAX_CAMPO,
      ),
      inline: true,
    });
  }

  if (perCategoria.length > 0) {
    fields.push({
      name: `Eventi per categoria (${eventi})`,
      value: taglia(
        classifica(
          perCategoria
            .map((riga) => ({ chiave: riga.category.toLowerCase(), quanti: riga._count }))
            .sort((a, b) => b.quanti - a.quanti),
          8,
        ),
        MAX_CAMPO,
      ),
      inline: true,
    });
  }

  if (perTipo.length > 0) {
    fields.push({
      name: 'Cosa è successo di più',
      value: taglia(
        classifica(
          perTipo.map((riga) => ({ chiave: riga.type.toLowerCase().replace(/_/g, ' '), quanti: riga._count })),
          8,
        ),
        MAX_CAMPO,
      ),
      inline: true,
    });
  }

  const ticketAperti = ticket.find((riga) => riga.status === 'OPEN')?._count ?? 0;
  const ticketChiusi = ticket.find((riga) => riga.status === 'CLOSED')?._count ?? 0;
  if (ticketAperti + ticketChiusi > 0) {
    fields.push({
      name: 'Assistenza',
      value: `Aperti: **${ticketAperti}**\nChiusi: **${ticketChiusi}**`,
      inline: true,
    });
  }

  if (incidenti.length > 0) {
    fields.push({
      name: `⚠️ Incidenti (${incidenti.length})`,
      value: taglia(
        incidenti
          .map(
            (incidente) =>
              `**${incidente.kind}** · ${incidente.startedAt.toLocaleTimeString('it-IT', {
                hour: '2-digit',
                minute: '2-digit',
              })}` + (incidente.summary ? ` — ${incidente.summary}` : ''),
          )
          .join('\n'),
        MAX_CAMPO,
      ),
    });
  }

  if (errori.length > 0) {
    fields.push({
      name: `🔴 Da sistemare (${errori.length})`,
      value: taglia(
        errori.map((problema) => `**${problema.titolo}** — \`${problema.modulo}\``).join('\n'),
        MAX_CAMPO,
      ),
    });
  }

  if (avvisi.length > 0) {
    fields.push({
      name: `🟠 Da guardare (${avvisi.length})`,
      value: taglia(
        avvisi
          .slice(0, 6)
          .map((problema) => `${problema.titolo} — \`${problema.modulo}\``)
          .join('\n'),
        MAX_CAMPO,
      ),
    });
  }

  // Il colore dice in un colpo d'occhio se c'è da fare qualcosa: rosso per la
  // configurazione rotta, giallo per gli incidenti, grigio per la normalità.
  const color = errori.length > 0 ? 0xe05263 : incidenti.length > 0 ? 0xd8b45f : 0x6f8a95;

  return {
    embed: {
      title: taglia(nome, 240),
      color,
      description:
        eventi === 0
          ? 'Nessun evento registrato nelle ultime 24 ore.'
          : `**${eventi}** eventi · **${provvedimenti}** provvedimenti`,
      // Venticinque è il limite di Discord: qui non ci si arriva, ma il taglio
      // resta perché il giorno in cui si aggiungessero altri riquadri il
      // rapporto smetterebbe di partire senza dire perché.
      fields: fields.slice(0, 25),
      footer: { text: guildId },
    },
    eventi,
    provvedimenti,
    errori: errori.length,
  };
}

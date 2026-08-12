import { getPrisma } from './index.js';

/* ═══════════════════════════════════════════════════════════════════════
   TRASCRIZIONI

   Sta nel pacchetto del database, e non nel bot, perché serve a due
   chiamanti: il comando `/archivio esporta` e la rotta di download del
   pannello. Non tocca Discord — legge righe archiviate e produce HTML — quindi
   duplicarla nei due progetti significherebbe solo vederle divergere.

   Genera un file HTML autonomo con la cronologia archiviata di un canale.
   Autonomo davvero: nessun CSS o script esterno, nessuna immagine remota.
   Una trascrizione che smette di essere leggibile quando cambia una CDN non è
   una prova, è un ricordo.

   Il contenuto degli utenti viene sempre marcato come testo: un messaggio che
   contiene `<script>` deve comparire come testo, non essere eseguito da chi
   apre il file per indagare.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Dati del ticket, quando la trascrizione ne documenta uno.
 *
 * Sono le domande che ci si pone rileggendo il file mesi dopo: chi l'ha
 * aperto, chi se n'è occupato, chi l'ha chiuso e perché. Senza risposta la
 * trascrizione è una conversazione senza contesto — si vede cosa è stato
 * detto e non si capisce come è finita.
 */
export interface TicketMeta {
  number: number;
  subject: string;
  openerId: string;
  openerTag?: string | null;
  claimedBy?: string | null;
  claimedByTag?: string | null;
  claimedAt?: Date | null;
  closedBy?: string | null;
  closedByTag?: string | null;
  closedAt?: Date | null;
  closeReason?: string | null;
  createdAt: Date;
  /** Chi è stato aggiunto al canale oltre a chi lo ha aperto. */
  invitati?: { id: string; tag?: string | null }[];
}

export interface TranscriptOptions {
  guildId: string;
  channelId: string;
  channelName: string;
  guildName: string;
  /** Limite di messaggi. Le trascrizioni enormi diventano illeggibili. */
  limit: number;
  /** Solo i messaggi successivi a questa data. */
  since?: Date;
  /** Include anche i messaggi eliminati (che sono spesso il motivo dell'export). */
  includeDeleted: boolean;
  /** Dati del ticket, se la trascrizione ne documenta uno. */
  ticket?: TicketMeta;
}

export interface TranscriptResult {
  html: string;
  /** Chi ha scritto almeno un messaggio, ricavato dall'archivio. */
  partecipanti: { id: string; tag: string | null; messaggi: number }[];
  messageCount: number;
  deletedCount: number;
  attachmentCount: number;
  oldest: Date | null;
  newest: Date | null;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Formattazione minima di Discord, applicata *dopo* l'escape. */
function renderContent(raw: string): string {
  return escapeHtml(raw)
    .replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre>${code.trim()}</pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/__([^_\n]+)__/g, '<u>$1</u>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@$1</span>')
    .replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#$1</span>')
    .replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="mention">@ruolo $1</span>')
    .replace(/\n/g, '<br>');
}

export async function buildTranscript(options: TranscriptOptions): Promise<TranscriptResult> {
  const prisma = getPrisma();

  const messages = await prisma.messageArchive.findMany({
    where: {
      guildId: options.guildId,
      channelId: options.channelId,
      ...(options.since ? { createdAt: { gte: options.since } } : {}),
      ...(options.includeDeleted ? {} : { deletedAt: null }),
    },
    orderBy: { createdAt: 'asc' },
    take: options.limit,
    include: { attachments: true },
  });

  // Chi ha davvero partecipato, ricavato dai messaggi e non dai permessi del
  // canale: i permessi dicono chi *poteva* leggere, l'archivio dice chi c'era.
  const conteggi = new Map<string, { tag: string | null; messaggi: number }>();
  for (const message of messages) {
    const voce = conteggi.get(message.authorId) ?? { tag: message.authorTag, messaggi: 0 };
    voce.messaggi += 1;
    if (!voce.tag && message.authorTag) voce.tag = message.authorTag;
    conteggi.set(message.authorId, voce);
  }
  const partecipanti = [...conteggi.entries()]
    .map(([id, voce]) => ({ id, tag: voce.tag, messaggi: voce.messaggi }))
    .sort((a, b) => b.messaggi - a.messaggi);

  const deletedCount = messages.filter((message) => message.deletedAt).length;
  const attachmentCount = messages.reduce(
    (total, message) => total + message.attachments.length,
    0,
  );

  const rows = messages
    .map((message) => {
      const time = new Intl.DateTimeFormat('it-IT', {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(message.createdAt);

      const attachments = message.attachments
        .map(
          (attachment) =>
            `<div class="att">📎 ${escapeHtml(attachment.filename)} ` +
            `<span class="meta">${Math.round(attachment.sizeBytes / 1024)} KB` +
            (attachment.verdict !== 'UNSCANNED' && attachment.verdict !== 'CLEAN'
              ? ` · <span class="verdict">${escapeHtml(attachment.verdict)}</span>`
              : '') +
            (attachment.sha256 ? ` · sha256 ${attachment.sha256.slice(0, 16)}…` : '') +
            `</span></div>`,
        )
        .join('');

      const body =
        message.content !== null
          ? renderContent(message.content)
          : '<span class="meta">(contenuto non conservato: registrazione in modalità ridotta)</span>';

      return `
<article class="msg${message.deletedAt ? ' deleted' : ''}">
  <header>
    <span class="author">${escapeHtml(message.authorTag ?? message.authorId)}</span>
    <span class="id">${escapeHtml(message.authorId)}</span>
    <time>${time}</time>
    ${message.editedAt ? '<span class="tag">modificato</span>' : ''}
    ${message.deletedAt ? '<span class="tag danger">eliminato</span>' : ''}
  </header>
  <div class="body">${body}</div>
  ${attachments}
</article>`;
    })
    .join('\n');

  const generated = new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(new Date());

  const quando = (data: Date | null | undefined): string =>
    data
      ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(data)
      : '—';

  const chi = (id: string | null | undefined, tag: string | null | undefined): string =>
    id ? `${escapeHtml(tag ?? 'sconosciuto')} <span class="id">${escapeHtml(id)}</span>` : '—';

  const t = options.ticket;
  const schedaTicket = t
    ? `
<section class="scheda">
  <h2>Ticket #${String(t.number).padStart(4, '0')}</h2>
  <p class="oggetto">${escapeHtml(t.subject)}</p>
  <dl>
    <dt>Aperto da</dt><dd>${chi(t.openerId, t.openerTag)}</dd>
    <dt>Aperto il</dt><dd>${quando(t.createdAt)}</dd>
    <dt>Preso in carico da</dt><dd>${chi(t.claimedBy, t.claimedByTag)}</dd>
    <dt>Preso in carico il</dt><dd>${quando(t.claimedAt)}</dd>
    <dt>Chiuso da</dt><dd>${chi(t.closedBy, t.closedByTag)}</dd>
    <dt>Chiuso il</dt><dd>${quando(t.closedAt)}</dd>
    <dt>Motivo della chiusura</dt><dd>${escapeHtml(t.closeReason ?? '—')}</dd>
    <dt>Durata</dt><dd>${
      t.closedAt
        ? `${Math.max(1, Math.round((t.closedAt.getTime() - t.createdAt.getTime()) / 60000))} minuti`
        : '—'
    }</dd>
    ${
      t.invitati && t.invitati.length > 0
        ? `<dt>Invitati nel canale</dt><dd>${t.invitati
            .map((persona) => chi(persona.id, persona.tag))
            .join('<br>')}</dd>`
        : ''
    }
  </dl>
</section>`
    : '';

  const schedaPartecipanti =
    partecipanti.length > 0
      ? `
<section class="scheda">
  <h2>Chi ha scritto</h2>
  <ul class="partecipanti">
    ${partecipanti
      .map(
        (persona) =>
          `<li>${escapeHtml(persona.tag ?? persona.id)} <span class="id">${escapeHtml(persona.id)}</span> — ${persona.messaggi} messaggi</li>`,
      )
      .join('')}
  </ul>
</section>`
      : '';

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>Trascrizione #${escapeHtml(options.channelName)} — ${escapeHtml(options.guildName)}</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0f1116; color:#e4e6eb; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; margin:0; padding:2rem; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size:1.25rem; margin:0 0 .25rem; }
  .summary { color:#8b93a5; font-size:.85rem; margin-bottom:1.5rem; padding-bottom:1rem; border-bottom:1px solid #2a2f3a; }
  .msg { padding:.6rem .8rem; border-radius:8px; margin-bottom:.4rem; background:#171a21; }
  .msg.deleted { background:#2a1416; border-left:3px solid #ed4245; }
  .msg header { display:flex; gap:.6rem; align-items:baseline; flex-wrap:wrap; margin-bottom:.3rem; }
  .author { font-weight:600; color:#a5adff; }
  .id, time, .meta { color:#6b7280; font-size:.75rem; }
  .tag { font-size:.7rem; background:#2a2f3a; padding:.1rem .4rem; border-radius:4px; color:#9aa3b2; }
  .tag.danger { background:rgba(237,66,69,.2); color:#ff9b9d; }
  .body { white-space:pre-wrap; word-break:break-word; line-height:1.5; }
  .body pre { background:#0b0d12; padding:.6rem; border-radius:6px; overflow-x:auto; margin:.4rem 0; }
  .body code { background:#0b0d12; padding:.1rem .3rem; border-radius:4px; font-size:.9em; }
  .mention { background:rgba(88,101,242,.2); color:#a5adff; padding:0 .2rem; border-radius:3px; }
  .att { margin-top:.3rem; font-size:.85rem; color:#9aa3b2; }
  .verdict { color:#ff9b9d; }
  footer { margin-top:2rem; padding-top:1rem; border-top:1px solid #2a2f3a; color:#6b7280; font-size:.75rem; }
  .scheda { background:#14161e; border:1px solid #2b2f3d; border-radius:10px; padding:1rem 1.2rem; margin-bottom:1.2rem; }
  .scheda h2 { margin:0 0 .4rem; font-size:1rem; color:#e8d8a0; letter-spacing:.02em; }
  .scheda .oggetto { margin:0 0 .8rem; color:#c9cdd6; }
  .scheda dl { display:grid; grid-template-columns:auto 1fr; gap:.35rem 1rem; margin:0; font-size:.85rem; }
  .scheda dt { color:#8b93a3; }
  .scheda dd { margin:0; color:#e4e6eb; }
  .partecipanti { margin:0; padding-left:1.1rem; font-size:.85rem; color:#e4e6eb; }
  .partecipanti li { margin:.15rem 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>#${escapeHtml(options.channelName)}</h1>
  ${schedaTicket}
  ${schedaPartecipanti}
  <div class="summary">
    Server: ${escapeHtml(options.guildName)} · canale <code>${escapeHtml(options.channelId)}</code><br>
    ${messages.length} messaggi archiviati · ${deletedCount} eliminati · ${attachmentCount} allegati<br>
    Trascrizione generata il ${generated}
  </div>
  ${rows || '<p class="meta">Nessun messaggio archiviato per questo canale nel periodo richiesto.</p>'}
  <footer>
    Generata da ANGEL a partire dal proprio archivio. Contiene solo i messaggi che il bot aveva
    già registrato: quelli precedenti alla sua installazione, o esclusi dalla configurazione della
    privacy, non compaiono. Gli allegati sono conservati separatamente sul server che ospita il bot.
  </footer>
</div>
</body>
</html>`;

  return {
    html,
    partecipanti,
    messageCount: messages.length,
    deletedCount,
    attachmentCount,
    oldest: messages[0]?.createdAt ?? null,
    newest: messages[messages.length - 1]?.createdAt ?? null,
  };
}

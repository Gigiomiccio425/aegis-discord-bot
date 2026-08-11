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
}

export interface TranscriptResult {
  html: string;
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
</style>
</head>
<body>
<div class="wrap">
  <h1>#${escapeHtml(options.channelName)}</h1>
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
    messageCount: messages.length,
    deletedCount,
    attachmentCount,
    oldest: messages[0]?.createdAt ?? null,
    newest: messages[messages.length - 1]?.createdAt ?? null,
  };
}

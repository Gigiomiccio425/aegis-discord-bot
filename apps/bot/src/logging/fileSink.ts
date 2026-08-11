import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileSinkConfig, LogCategory, LogEventType } from '@angel/shared';
import { childLogger } from '../core/logger.js';

const log = childLogger('fileSink');

/* ═══════════════════════════════════════════════════════════════════════
   REGISTRO SU FILE

   Ogni evento viene scritto anche su disco, in file di testo append-only che
   ruotano per giorno. Serve all'archivio a lungo termine: il database resta
   leggero e veloce, i file conservano tutto per anni al costo del solo spazio.

   Tre scelte che spiegano il resto:

   • **Scritture bufferizzate.** Una syscall per evento, su un server attivo,
     è spreco puro. Il buffer si svuota a intervalli e comunque prima dello
     spegnimento: in caso di crash si perdono al massimo gli ultimi secondi,
     che sono comunque nel database.

   • **Uno stream aperto per file, riusato.** Aprire e chiudere a ogni riga
     costerebbe più della scrittura stessa. Gli stream dei giorni passati
     vengono chiusi alla rotazione.

   • **Append-only, mai riscrittura.** Un archivio che si riscrive è un
     archivio che si può corrompere. Qui l'unica operazione è aggiungere in
     fondo.

   Struttura:
     storage/logs/<guildId>/<AAAA-MM-GG>/<CATEGORIA>.txt
     storage/logs/<guildId>/<AAAA-MM-GG>/<CATEGORIA>.jsonl
   ═══════════════════════════════════════════════════════════════════════ */

export interface FileSinkEvent {
  guildId: string;
  type: LogEventType;
  category: LogCategory;
  createdAt: Date;
  actorId?: string | null;
  actorTag?: string | null;
  targetId?: string | null;
  targetTag?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  severity?: number;
  automated?: boolean;
  summary?: string | null;
  payload?: Record<string, unknown>;
}

interface OpenFile {
  stream: WriteStream;
  buffer: string[];
  day: string;
}

const files = new Map<string, OpenFile>();
let flushTimer: NodeJS.Timeout | null = null;

function storageRoot(): string {
  return process.env.STORAGE_DIR ?? './storage';
}

/** Data locale in formato AAAA-MM-GG: è la chiave della rotazione. */
function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

function timestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

function getFile(filePath: string, day: string): OpenFile {
  const existing = files.get(filePath);
  if (existing && existing.day === day) return existing;

  // Rotazione: lo stream del giorno precedente viene svuotato e chiuso.
  if (existing) {
    flushOne(filePath, existing);
    existing.stream.end();
    files.delete(filePath);
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  const entry: OpenFile = {
    stream: createWriteStream(filePath, { flags: 'a', encoding: 'utf8' }),
    buffer: [],
    day,
  };
  entry.stream.on('error', (error) => log.error({ err: error, filePath }, 'scrittura su file fallita'));
  files.set(filePath, entry);
  return entry;
}

/**
 * Riga leggibile a occhio e con `grep`.
 *
 * Il formato è a colonne fisse all'inizio (data, tipo, gravità) proprio perché
 * la ricerca più comune su un file di testo è `grep SECURITY_ | grep 2026-08`.
 */
function formatText(event: FileSinkEvent, includeContent: boolean): string {
  const parts = [
    `[${timestamp(event.createdAt)}]`,
    event.type,
    `sev=${event.severity ?? 0}`,
    event.automated ? 'auto' : 'manuale',
  ];

  if (event.actorId) {
    parts.push(`autore=${event.actorTag ? `${event.actorTag}(${event.actorId})` : event.actorId}`);
  }
  if (event.targetId) {
    parts.push(
      `oggetto=${event.targetTag ? `${event.targetTag}(${event.targetId})` : event.targetId}`,
    );
  }
  if (event.channelId) parts.push(`canale=${event.channelId}`);
  if (event.messageId) parts.push(`msg=${event.messageId}`);

  let line = parts.join(' ');

  if (includeContent && event.summary) {
    // Gli a capo del riepilogo diventano `⏎`: una riga per evento è ciò che
    // rende il file utilizzabile con gli strumenti a riga di comando.
    line += ` :: ${event.summary.replace(/\r?\n/g, ' ⏎ ')}`;
  }
  return line;
}

function formatJson(event: FileSinkEvent, includeContent: boolean): string {
  return JSON.stringify({
    ts: event.createdAt.toISOString(),
    type: event.type,
    category: event.category,
    severity: event.severity ?? 0,
    automated: event.automated ?? false,
    actorId: event.actorId ?? null,
    actorTag: event.actorTag ?? null,
    targetId: event.targetId ?? null,
    targetTag: event.targetTag ?? null,
    channelId: event.channelId ?? null,
    messageId: event.messageId ?? null,
    summary: includeContent ? (event.summary ?? null) : null,
    payload: includeContent ? (event.payload ?? {}) : undefined,
  });
}

export function writeToFile(event: FileSinkEvent, settings: FileSinkConfig): void {
  if (!settings.enabled) return;

  const day = dayKey(event.createdAt);
  const base = path.join(storageRoot(), 'logs', event.guildId, day);
  const name = settings.splitByCategory ? event.category : 'tutti';

  if (settings.format === 'TXT' || settings.format === 'BOTH') {
    const file = getFile(path.join(base, `${name}.txt`), day);
    file.buffer.push(formatText(event, settings.includeContent));
  }
  if (settings.format === 'JSONL' || settings.format === 'BOTH') {
    const file = getFile(path.join(base, `${name}.jsonl`), day);
    file.buffer.push(formatJson(event, settings.includeContent));
  }

  scheduleFlush(settings.flushIntervalMs);
}

function scheduleFlush(intervalMs: number): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAll();
  }, intervalMs);
  // Il timer non deve tenere vivo il processo: allo spegnimento si svuota
  // comunque tutto esplicitamente.
  flushTimer.unref?.();
}

function flushOne(filePath: string, file: OpenFile): void {
  if (file.buffer.length === 0) return;
  const chunk = `${file.buffer.join('\n')}\n`;
  file.buffer.length = 0;
  file.stream.write(chunk, (error) => {
    if (error) log.error({ err: error, filePath }, 'flush fallito');
  });
}

export function flushAll(): void {
  for (const [filePath, file] of files) flushOne(filePath, file);
}

/** Svuota e chiude tutto: da chiamare allo spegnimento. */
export async function closeFileSink(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushAll();

  await Promise.all(
    [...files.values()].map(
      (file) =>
        new Promise<void>((resolve) => {
          file.stream.end(() => resolve());
        }),
    ),
  );
  files.clear();
}

/**
 * Pulizia dei file scaduti.
 *
 * Con `retentionDays = 0` non cancella nulla, ed è il caso normale quando lo
 * spazio non è il vincolo: conservare tutto è il motivo per cui si scrive su
 * disco invece di lasciare tutto nel database.
 */
export async function pruneLogFiles(guildId: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  const base = path.join(storageRoot(), 'logs', guildId);
  const cutoff = Date.now() - retentionDays * 86_400_000;

  let removed = 0;
  const entries = await readdir(base).catch(() => [] as string[]);

  for (const entry of entries) {
    // Il nome della cartella è la data: si evita di leggere i metadati del
    // filesystem per migliaia di directory.
    const parsed = Date.parse(entry);
    if (Number.isNaN(parsed)) continue;
    if (parsed >= cutoff) continue;

    const full = path.join(base, entry);
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) continue;

    await rm(full, { recursive: true, force: true }).catch(() => undefined);
    removed++;
  }

  if (removed > 0) log.info({ guildId, removed }, 'cartelle di log scadute rimosse');
  return removed;
}

/** Dimensione occupata dai log di un server, per il pannello. */
export async function logDirectorySize(guildId: string): Promise<{ bytes: number; days: number }> {
  const base = path.join(storageRoot(), 'logs', guildId);
  const days = await readdir(base).catch(() => [] as string[]);

  let bytes = 0;
  for (const day of days) {
    const dayPath = path.join(base, day);
    const entries = await readdir(dayPath).catch(() => [] as string[]);
    for (const entry of entries) {
      const info = await stat(path.join(dayPath, entry)).catch(() => null);
      if (info?.isFile()) bytes += info.size;
    }
  }
  return { bytes, days: days.length };
}

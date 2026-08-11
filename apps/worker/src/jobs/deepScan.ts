import type { Job } from 'bullmq';
import { getPrisma } from '@angel/db';
import { GuildConfigSchema } from '@angel/shared';
import {
  clickFixFindings,
  computePhash,
  decodeQrCodes,
  extractUrls,
  findImpersonationInText,
  isDiscordRemoteAuth,
  runOcr,
  type Finding,
} from '@angel/scanner';
import { normalize } from '@angel/shared';
import { childLogger } from '../logger.js';
import { deleteMessage, recordWorkerEvent, sendMessage } from '../discord.js';

const log = childLogger('deepScan');

interface DeepScanPayload {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  text: string;
  images: { filename: string; data: string }[];
}

/**
 * Analisi differita delle immagini.
 *
 * Il bot ha già fatto i controlli veloci — QR, hash, link nel testo — e ha
 * lasciato passare il messaggio. Qui si esegue l'OCR, che costa da mezzo
 * secondo a due secondi per immagine e che sul percorso del gateway
 * rallenterebbe tutto.
 *
 * Se il verdetto è negativo il messaggio viene eliminato a posteriori: qualche
 * secondo di esposizione in cambio di un bot che non accumula ritardo. È il
 * compromesso giusto, perché il grosso delle campagne scam vive per ore, non
 * per secondi.
 */
export async function deepScanProcessor(job: Job<DeepScanPayload>): Promise<void> {
  const { guildId, channelId, messageId, authorId, text, images } = job.data;
  if (images.length === 0) return;

  const prisma = getPrisma();
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return;

  const parsed = GuildConfigSchema.safeParse(guild.config);
  if (!parsed.success) return;
  const config = parsed.data;
  if (!config.scanner.enabled || !config.scanner.image.enabled) return;

  const findings: Finding[] = [];
  let campaignHash: string | undefined;

  for (const image of images) {
    const buffer = Buffer.from(image.data, 'base64');

    // Il QR viene riprovato qui: il tentativo veloce del bot può fallire su
    // immagini piccole o a basso contrasto, mentre qui si può insistere.
    const payloads = await decodeQrCodes(buffer);
    for (const payload of payloads) {
      if (isDiscordRemoteAuth(payload)) {
        findings.push({
          code: 'QR_REMOTE_AUTH',
          detail:
            'QR di login Discord (Remote Auth): chi lo inquadra consegna il token del proprio account.',
          score: 100,
          meta: { payload },
        });
      }
      const urls = extractUrls(payload, 'QR');
      if (urls.length > 0) {
        findings.push({
          code: 'QR_MALICIOUS_URL',
          detail: `QR contenente un link: ${urls.map((url) => url.host).join(', ')}`,
          score: 30,
          meta: { hosts: urls.map((url) => url.host) },
        });
      }
    }

    if (!config.scanner.image.ocr) continue;

    const ocr = await runOcr(buffer, { languages: config.scanner.image.ocrLanguages });
    if (!ocr || ocr.confidence < config.scanner.image.ocrMinConfidence) continue;
    if (!ocr.text.trim()) continue;

    const ocrUrls = extractUrls(ocr.text, 'OCR');
    if (ocrUrls.length > 0) {
      findings.push({
        code: 'OCR_URL',
        detail: `Link scritto dentro l'immagine: ${ocrUrls.map((url) => url.host).join(', ')}`,
        score: 35,
        meta: { hosts: ocrUrls.map((url) => url.host) },
      });
    }

    findings.push(...clickFixFindings(ocr.text, 'OCR', config.scanner.clickfix.patterns));

    const impersonation = findImpersonationInText(ocr.text);
    if (impersonation.length > 0) {
      findings.push({
        code: 'OCR_IMPERSONATION',
        detail: `Contenuto contraffatto: ${impersonation.map((entry) => entry.detail).join('; ')}`,
        score: 60,
      });
    }

    const haystack = normalize(`${ocr.text}\n${text}`);
    const phrases = config.scanner.scamPhrases.filter((phrase) => haystack.includes(normalize(phrase)));
    if (phrases.length > 0) {
      findings.push({
        code: 'OCR_SCAM_PHRASE',
        detail: `Frasi delle campagne scam nel testo dell'immagine: ${phrases.join(', ')}`,
        score: Math.min(70, 25 * phrases.length),
        meta: { phrases },
      });
    }

    if (findings.length > 0 && !campaignHash) {
      campaignHash = await computePhash(buffer);
    }
  }

  if (findings.length === 0) return;

  const score = Math.min(
    100,
    findings.reduce((total, finding) => total + finding.score, 0),
  );

  log.info({ guildId, messageId, score, findings: findings.length }, 'analisi differita positiva');

  /**
   * L'hash percettivo dell'immagine viene salvato come firma: la prossima
   * copia della stessa campagna sarà bloccata all'istante dal bot, senza
   * ripassare da qui. È così che le difese migliorano con l'uso.
   */
  if (campaignHash && score >= 60) {
    await prisma.threatSignature
      .upsert({
        where: { kind_value_guildId: { kind: 'IMAGE_PHASH', value: campaignHash, guildId } },
        create: {
          guildId,
          kind: 'IMAGE_PHASH',
          value: campaignHash,
          source: 'auto',
          severity: Math.min(90, score),
          description: findings.map((finding) => finding.code).join(', '),
        },
        update: { hitCount: { increment: 1 }, lastHitAt: new Date() },
      })
      .catch(() => undefined);
  }

  if (score < 50 || config.general.dryRun) {
    await recordWorkerEvent({
      guildId,
      type: 'SECURITY_SCAM_BLOCKED',
      actorId: authorId,
      channelId,
      messageId,
      severity: score,
      summary:
        `Analisi differita: punteggio ${score}/100` +
        (config.general.dryRun ? ' — modalità prova, nessuna azione' : ' — sotto la soglia di intervento'),
      payload: { findings },
    });
    return;
  }

  const deleted = await deleteMessage(
    channelId,
    messageId,
    'ANGEL: contenuto malevolo rilevato dall\'analisi approfondita',
  );

  const isRemoteAuth = findings.some((finding) => finding.code === 'QR_REMOTE_AUTH');

  await recordWorkerEvent({
    guildId,
    type: isRemoteAuth ? 'SECURITY_REMOTE_AUTH_QR' : 'SECURITY_SCAM_BLOCKED',
    actorId: authorId,
    channelId,
    messageId,
    severity: score,
    summary:
      `${isRemoteAuth ? '🚨 **QR DI FURTO ACCOUNT**' : '🛡️ Contenuto malevolo'} rilevato ` +
      `nell'analisi approfondita di un'immagine di <@${authorId}>\n` +
      findings.map((finding) => `• ${finding.detail}`).join('\n') +
      `\n\nMessaggio ${deleted ? 'eliminato' : 'NON eliminato (permessi mancanti)'}.`,
    payload: { findings, score, deleted },
  });

  // Sul QR di Remote Auth si avvisa anche il canale: chi lo ha già inquadrato
  // deve saperlo subito, perché il token è già stato consegnato.
  if (isRemoteAuth) {
    const alertChannel = config.general.alertChannelId ?? config.logging.defaultChannelId;
    if (alertChannel) {
      await sendMessage(alertChannel, {
        content: config.general.alertRoleId ? `<@&${config.general.alertRoleId}>` : undefined,
        embeds: [
          {
            title: '🚨 QR di login Discord bloccato',
            description:
              `Un'immagine inviata da <@${authorId}> in <#${channelId}> conteneva un codice QR di ` +
              'login Discord (Remote Auth).\n\n' +
              '**Chi lo ha inquadrato ha già consegnato l\'accesso al proprio account**: Discord ' +
              'trasmette il token a chi ha generato il codice, senza chiedere la password e senza ' +
              'mostrare avvisi.\n\n' +
              '**Cosa fare subito, se lo hai inquadrato:**\n' +
              '1. Cambia la password di Discord (chiude tutte le sessioni attive)\n' +
              '2. Attiva l\'autenticazione a due fattori\n' +
              '3. Revoca le app autorizzate sconosciute in Impostazioni → App autorizzate',
            color: 0xff0000,
          },
        ],
        allowed_mentions: config.general.alertRoleId
          ? { roles: [config.general.alertRoleId] }
          : { parse: [] },
      });
    }
  }
}

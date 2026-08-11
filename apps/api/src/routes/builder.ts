import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@angel/db';
import {
  CustomCommandSchema,
  FORBIDDEN_PERSONA_PATTERNS,
  PersonaSchema,
  type CustomCommand,
} from '@angel/shared';
import { requireGuild } from '../guard.js';
import { sendBotCommand } from '../redis.js';

/* ═══════════════════════════════════════════════════════════════════════
   BUILDER DI COMANDI E PERSONAS

   Qui il pannello salva le sequenze: "questa persona dice questo, tre secondi
   dopo quest'altra risponde, poi assegna un ruolo". Ogni salvataggio chiede al
   bot di ripubblicare i comandi slash del server, altrimenti la nuova
   definizione esisterebbe solo nel database.

   Il controllo sui nomi delle personas non è formalità: una persona chiamata
   "Discord Staff" con l'avatar giusto sarebbe uno strumento di truffa
   confezionato e distribuito dal pannello.
   ═══════════════════════════════════════════════════════════════════════ */

export async function builderRoutes(app: FastifyInstance): Promise<void> {
  /* ── Personas ──────────────────────────────────────────────────────── */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/personas',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      return prisma.persona.findMany({
        where: { guildId: context.guildId },
        orderBy: { name: 'asc' },
      });
    },
  );

  app.post<{ Params: { guildId: string }; Body: unknown }>(
    '/api/guilds/:guildId/personas',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const parsed = PersonaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'dati non validi', dettagli: parsed.error.issues });
      }

      const forbidden = FORBIDDEN_PERSONA_PATTERNS.find((pattern) => pattern.test(parsed.data.name));
      if (forbidden) {
        return reply.code(400).send({
          error:
            `Il nome "${parsed.data.name}" contiene un termine riservato. Una persona non può ` +
            'presentarsi come Discord, come staff o come supporto: sarebbe indistinguibile da una truffa.',
        });
      }

      const prisma = getPrisma();
      const created = await prisma.persona
        .create({
          data: {
            guildId: context.guildId,
            name: parsed.data.name,
            avatarUrl: parsed.data.avatarUrl,
            color: parsed.data.color,
            description: parsed.data.description,
            createdBy: context.user.id,
          },
        })
        .catch(() => null);

      if (!created) {
        return reply.code(409).send({ error: 'Esiste già una persona con questo nome.' });
      }
      return created;
    },
  );

  app.put<{ Params: { guildId: string; personaId: string }; Body: unknown }>(
    '/api/guilds/:guildId/personas/:personaId',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const parsed = PersonaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'dati non validi', dettagli: parsed.error.issues });
      }
      if (FORBIDDEN_PERSONA_PATTERNS.some((pattern) => pattern.test(parsed.data.name))) {
        return reply.code(400).send({ error: 'Nome non consentito: contiene un termine riservato.' });
      }

      const prisma = getPrisma();
      const persona = await prisma.persona.findUnique({ where: { id: request.params.personaId } });
      if (!persona || persona.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'persona non trovata' });
      }

      return prisma.persona.update({
        where: { id: persona.id },
        data: {
          name: parsed.data.name,
          avatarUrl: parsed.data.avatarUrl,
          color: parsed.data.color,
          description: parsed.data.description,
        },
      });
    },
  );

  app.delete<{ Params: { guildId: string; personaId: string } }>(
    '/api/guilds/:guildId/personas/:personaId',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const persona = await prisma.persona.findUnique({ where: { id: request.params.personaId } });
      if (!persona || persona.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'persona non trovata' });
      }

      // Una persona usata da un comando non si elimina in silenzio: il comando
      // resterebbe con un passo che punta al nulla.
      const commands = await prisma.customCommand.findMany({
        where: { guildId: context.guildId },
      });
      const used = commands.filter((command) =>
        JSON.stringify(command.steps).includes(persona.id),
      );
      if (used.length > 0) {
        return reply.code(409).send({
          error: 'Persona usata da comandi esistenti',
          comandi: used.map((command) => command.name),
        });
      }

      await prisma.persona.delete({ where: { id: persona.id } });
      return { ok: true };
    },
  );

  /* ── Comandi personalizzati ────────────────────────────────────────── */
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/commands',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const prisma = getPrisma();
      return prisma.customCommand.findMany({
        where: { guildId: context.guildId },
        orderBy: { name: 'asc' },
      });
    },
  );

  app.post<{ Params: { guildId: string }; Body: unknown }>(
    '/api/guilds/:guildId/commands',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const parsed = CustomCommandSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'comando non valido', dettagli: parsed.error.issues });
      }

      const validation = await validateSteps(context.guildId, parsed.data);
      if (validation) return reply.code(400).send({ error: validation });

      const prisma = getPrisma();
      const created = await prisma.customCommand
        .create({
          data: {
            guildId: context.guildId,
            name: parsed.data.name,
            description: parsed.data.description,
            enabled: parsed.data.enabled,
            allowedRoleIds: parsed.data.allowedRoleIds,
            deniedRoleIds: parsed.data.deniedRoleIds,
            allowedChannelIds: parsed.data.allowedChannelIds,
            args: parsed.data.args as unknown as object,
            steps: parsed.data.steps as unknown as object,
            cooldownSec: parsed.data.cooldownSec,
            guildCooldownSec: parsed.data.guildCooldownSec,
            ephemeralAck: parsed.data.ephemeralAck,
            createdBy: context.user.id,
          },
        })
        .catch(() => null);

      if (!created) {
        return reply.code(409).send({ error: 'Esiste già un comando con questo nome.' });
      }

      await sendBotCommand({ action: 'commands.reload', guildId: context.guildId });
      return created;
    },
  );

  app.put<{ Params: { guildId: string; commandId: string }; Body: unknown }>(
    '/api/guilds/:guildId/commands/:commandId',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const parsed = CustomCommandSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'comando non valido', dettagli: parsed.error.issues });
      }

      const validation = await validateSteps(context.guildId, parsed.data);
      if (validation) return reply.code(400).send({ error: validation });

      const prisma = getPrisma();
      const existing = await prisma.customCommand.findUnique({
        where: { id: request.params.commandId },
      });
      if (!existing || existing.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'comando non trovato' });
      }

      const updated = await prisma.customCommand.update({
        where: { id: existing.id },
        data: {
          name: parsed.data.name,
          description: parsed.data.description,
          enabled: parsed.data.enabled,
          allowedRoleIds: parsed.data.allowedRoleIds,
          deniedRoleIds: parsed.data.deniedRoleIds,
          allowedChannelIds: parsed.data.allowedChannelIds,
          args: parsed.data.args as unknown as object,
          steps: parsed.data.steps as unknown as object,
          cooldownSec: parsed.data.cooldownSec,
          guildCooldownSec: parsed.data.guildCooldownSec,
          ephemeralAck: parsed.data.ephemeralAck,
        },
      });

      await sendBotCommand({ action: 'commands.reload', guildId: context.guildId });
      return updated;
    },
  );

  app.delete<{ Params: { guildId: string; commandId: string } }>(
    '/api/guilds/:guildId/commands/:commandId',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const existing = await prisma.customCommand.findUnique({
        where: { id: request.params.commandId },
      });
      if (!existing || existing.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'comando non trovato' });
      }

      await prisma.customCommand.delete({ where: { id: existing.id } });
      await sendBotCommand({ action: 'commands.reload', guildId: context.guildId });
      return { ok: true };
    },
  );
}

/**
 * Controlli che lo schema Zod da solo non può fare: l'esistenza delle personas
 * citate e la coerenza dei riferimenti agli argomenti.
 */
async function validateSteps(guildId: string, command: CustomCommand): Promise<string | null> {
  const prisma = getPrisma();
  const personas = await prisma.persona.findMany({
    where: { guildId },
    select: { id: true },
  });
  const personaIds = new Set(personas.map((persona) => persona.id));
  const argNames = new Set(command.args.map((arg) => arg.name));

  for (const [index, step] of command.steps.entries()) {
    if (step.kind === 'PERSONA_MESSAGE' && !personaIds.has(step.personaId)) {
      return `Passo ${index + 1}: la persona indicata non esiste in questo server.`;
    }
    if (
      (step.kind === 'ADD_ROLE' || step.kind === 'REMOVE_ROLE' || step.kind === 'DM_USER') &&
      step.target === 'ARG_USER' &&
      !argNames.has(step.argName)
    ) {
      return `Passo ${index + 1}: l'argomento "${step.argName}" non è definito nel comando.`;
    }
    if (
      step.kind === 'CONDITION' &&
      (step.check === 'ARG_EQUALS' || step.check === 'ARG_CONTAINS') &&
      !argNames.has(step.argName)
    ) {
      return `Passo ${index + 1}: la condizione usa l'argomento "${step.argName}", che non esiste.`;
    }
  }

  // La somma delle attese non deve superare il ragionevole: una sequenza da
  // dieci minuti resterebbe appesa in memoria senza che nessuno se ne accorga.
  const totalWait = command.steps
    .filter((step): step is Extract<typeof step, { kind: 'WAIT' }> => step.kind === 'WAIT')
    .reduce((total, step) => total + step.seconds, 0);
  if (totalWait > 300) {
    return `Le pause del comando sommano ${totalWait}s: il massimo consentito è 300s.`;
  }

  return null;
}

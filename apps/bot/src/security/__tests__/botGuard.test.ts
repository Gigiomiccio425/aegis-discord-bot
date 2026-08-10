import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { scoreBotPermissions } from '../botGuard.js';

/**
 * Punteggio di rischio dei bot.
 *
 * Nel 2026 i bot di terze parti sono fra le prime cause di compromissione dei
 * server, e non per malafede dello sviluppatore: basta una dipendenza avvelenata
 * o il furto delle sue credenziali. Il punteggio serve a rendere visibile ciò
 * che si sta concedendo, prima che diventi un problema.
 */
describe('rischio dei permessi di un bot', () => {
  it('assegna il massimo ad Administrator', () => {
    const risk = scoreBotPermissions(new PermissionsBitField(PermissionFlagsBits.Administrator));
    expect(risk.score).toBe(100);
    expect(risk.flags).toContain('Administrator');
  });

  it('non segnala un bot con soli permessi di lettura e invio', () => {
    const risk = scoreBotPermissions(
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]),
    );
    expect(risk.score).toBe(0);
    expect(risk.flags).toHaveLength(0);
  });

  it('riconosce ManageWebhooks come rischio, non come permesso banale', () => {
    // Permette messaggi dall'aspetto ufficiale, ed è usato come canale di
    // esfiltrazione: non è un permesso di comodo.
    const risk = scoreBotPermissions(new PermissionsBitField(PermissionFlagsBits.ManageWebhooks));
    expect(risk.score).toBeGreaterThan(0);
    expect(risk.flags).toContain('ManageWebhooks');
  });

  it('riconosce ReadMessageHistory come rischio di raccolta dati', () => {
    const risk = scoreBotPermissions(
      new PermissionsBitField(PermissionFlagsBits.ReadMessageHistory),
    );
    expect(risk.flags).toContain('ReadMessageHistory');
  });

  it('cresce accumulando permessi pericolosi', () => {
    const singolo = scoreBotPermissions(new PermissionsBitField(PermissionFlagsBits.KickMembers));
    const multiplo = scoreBotPermissions(
      new PermissionsBitField([
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.ManageRoles,
      ]),
    );
    expect(multiplo.score).toBeGreaterThan(singolo.score);
  });

  it('non supera mai 100', () => {
    const risk = scoreBotPermissions(
      new PermissionsBitField([
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.BanMembers,
      ]),
    );
    expect(risk.score).toBeLessThanOrEqual(100);
  });

  it('spiega ogni permesso segnalato', () => {
    const risk = scoreBotPermissions(new PermissionsBitField(PermissionFlagsBits.ManageGuild));
    // Il punteggio da solo non aiuta chi deve decidere: serve il perché.
    expect(risk.details[0]).toMatch(/ManageGuild/);
    expect(risk.details[0]!.length).toBeGreaterThan(20);
  });
});

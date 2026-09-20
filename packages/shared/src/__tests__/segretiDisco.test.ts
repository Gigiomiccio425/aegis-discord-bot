import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — modulo JavaScript del contenitore, senza dichiarazioni.
import { assicuraSegreti, FILE_PASSWORD_DB } from '../../../../docker/segreti.mjs';

/* ═══════════════════════════════════════════════════════════════════════
   I SEGRETI SUL DISCO

   `segreti.ts` legge il formato; qui c'è la parte che tocca il disco, ed è
   quella che può far perdere dati per davvero. Tre cose devono valere, e
   nessuna delle tre dà errore quando smette di valere:

   • quello che si genera si genera **una volta sola**. Un `SESSION_SECRET`
     diverso a ogni avvio sloggia tutti; una `ENCRYPTION_KEY` diversa rende
     illeggibili i token cifrati nel database, e quelli non tornano;

   • quello che manca si dice, e si aspetta. Far partire il bot senza token
     significa un ciclo di riavvii che non porta da nessuna parte;

   • il file della versione precedente si legge lo stesso. Chi aggiorna non
     deve accorgersi che la cartella è cambiata.
   ═══════════════════════════════════════════════════════════════════════ */

const temporanee: string[] = [];

async function cartellaNuova(nome: string) {
  const percorso = await fs.mkdtemp(path.join(os.tmpdir(), `angel-${nome}-`));
  temporanee.push(percorso);
  return percorso;
}

afterEach(async () => {
  for (const percorso of temporanee.splice(0)) {
    await fs.rm(percorso, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Un ambiente finto: senza, si scriverebbe dentro `process.env`. */
const ambienteVuoto = (): Record<string, string | undefined> => ({});

describe('preparazione dei segreti', () => {
  it('genera quello che si può generare, e lo salva', async () => {
    const cartella = await cartellaNuova('genera');
    const ambiente = ambienteVuoto();

    const esito = await assicuraSegreti(cartella, ambiente);

    expect(esito.generati).toContain('SESSION_SECRET');
    expect(esito.generati).toContain('ENCRYPTION_KEY');
    expect(esito.generati).toContain(FILE_PASSWORD_DB);

    // 32 byte in esadecimale: la lunghezza che si aspetta chi le usa.
    expect(ambiente.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(ambiente.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);

    const scritto = await fs.readFile(path.join(cartella, 'segreti.env'), 'utf8');
    expect(scritto).toContain(`SESSION_SECRET=${ambiente.SESSION_SECRET}`);
  });

  /*
   * Il test che conta più di tutti.
   *
   * Rigenerare `ENCRYPTION_KEY` a ogni avvio non produce nessun errore: il
   * bot parte, e i token Twitch salvati prima semplicemente non si
   * decifrano più. Si scopre settimane dopo, quando qualcuno prova a usarli.
   */
  it('al secondo avvio ritrova gli stessi valori, non ne fa di nuovi', async () => {
    const cartella = await cartellaNuova('stabile');

    const primo = ambienteVuoto();
    await assicuraSegreti(cartella, primo);

    const secondo = ambienteVuoto();
    const esito = await assicuraSegreti(cartella, secondo);

    expect(esito.generati).toEqual([]);
    expect(secondo.SESSION_SECRET).toBe(primo.SESSION_SECRET);
    expect(secondo.ENCRYPTION_KEY).toBe(primo.ENCRYPTION_KEY);
    expect(secondo.DATABASE_URL).toBe(primo.DATABASE_URL);
  });

  it('compone DATABASE_URL dalla password che ha generato', async () => {
    const cartella = await cartellaNuova('url');
    const ambiente = ambienteVuoto();

    await assicuraSegreti(cartella, ambiente);

    const password = (await fs.readFile(path.join(cartella, FILE_PASSWORD_DB), 'utf8')).trim();
    const indirizzo = new URL(ambiente.DATABASE_URL!);

    expect(indirizzo.hostname).toBe('postgres');
    expect(indirizzo.username).toBe('angel');
    expect(decodeURIComponent(indirizzo.password)).toBe(password);
  });

  it('un DATABASE_URL già scritto vince su quello che comporrebbe', async () => {
    // È il caso di chi aggiorna: il database esiste già, con la sua
    // password. Comporne una nuova significherebbe non entrarci più.
    const cartella = await cartellaNuova('database-esistente');
    const suo = 'postgresql://angel:quella-vecchia@postgres:5432/angel?schema=public';
    await fs.writeFile(path.join(cartella, 'segreti.env'), `DATABASE_URL=${suo}\n`);

    const ambiente = ambienteVuoto();
    await assicuraSegreti(cartella, ambiente);

    expect(ambiente.DATABASE_URL).toBe(suo);
  });

  it('elenca quello che deve dare una persona, e non lo inventa', async () => {
    const cartella = await cartellaNuova('mancanti');
    const ambiente = ambienteVuoto();

    const esito = await assicuraSegreti(cartella, ambiente);

    expect(esito.mancanti).toContain('DISCORD_TOKEN');
    expect(esito.mancanti).toContain('PUBLIC_URL');
    // Generati, quindi non più mancanti: chiederli sarebbe solo un modo di
    // far sbagliare chi installa.
    expect(esito.mancanti).not.toContain('SESSION_SECRET');
    expect(esito.mancanti).not.toContain('ENCRYPTION_KEY');
  });

  it('con tutto compilato non manca niente', async () => {
    const cartella = await cartellaNuova('completo');
    await fs.writeFile(
      path.join(cartella, 'segreti.env'),
      [
        'DISCORD_TOKEN=un.token.finto',
        'DISCORD_CLIENT_ID=123',
        'DISCORD_CLIENT_SECRET=abc',
        'PUBLIC_URL=http://esempio:780',
        'OWNER_IDS=1',
        '',
      ].join('\n'),
    );

    const esito = await assicuraSegreti(cartella, ambienteVuoto());
    expect(esito.mancanti).toEqual([]);
  });

  /*
   * Fino alla 1.28.1 il file stava insieme ai dati. Se l'aggiornamento
   * smettesse di leggerlo, chi l'aveva compilato si ritroverebbe il bot
   * fermo e nessuna riga che spieghi dove sono finiti i suoi valori.
   */
  it('legge ancora il file della cartella di prima', async () => {
    const vecchia = await cartellaNuova('vecchia');
    const nuova = await cartellaNuova('nuova');
    await fs.writeFile(path.join(vecchia, 'segreti.env'), 'DISCORD_TOKEN=quello-di-prima\n');

    const ambiente: Record<string, string | undefined> = { STORAGE_DIR: vecchia };
    const esito = await assicuraSegreti(nuova, ambiente);

    expect(ambiente.DISCORD_TOKEN).toBe('quello-di-prima');
    expect(esito.letti).toContain('DISCORD_TOKEN');
    expect(esito.avvisi.join(' ')).toContain('mv ');
  });

  it('il file nuovo corregge quello vecchio', async () => {
    const vecchia = await cartellaNuova('vecchia-corretta');
    const nuova = await cartellaNuova('nuova-corretta');
    await fs.writeFile(path.join(vecchia, 'segreti.env'), 'DISCORD_TOKEN=scaduto\n');
    await fs.writeFile(path.join(nuova, 'segreti.env'), 'DISCORD_TOKEN=rigenerato\n');

    const ambiente: Record<string, string | undefined> = { STORAGE_DIR: vecchia };
    await assicuraSegreti(nuova, ambiente);

    expect(ambiente.DISCORD_TOKEN).toBe('rigenerato');
  });

  it('non scrive mai un valore negli avvisi', async () => {
    const cartella = await cartellaNuova('silenzio');
    const ambiente = ambienteVuoto();

    const esito = await assicuraSegreti(cartella, ambiente);
    const detto = [...esito.avvisi, ...esito.letti, ...esito.generati, ...esito.mancanti].join(' ');

    expect(detto).not.toContain(ambiente.SESSION_SECRET);
    expect(detto).not.toContain(ambiente.ENCRYPTION_KEY);
  });
});

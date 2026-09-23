import { defaultGuildConfig } from '@angel/shared';
import { describe, expect, it } from 'vitest';
import { motivoCopiaFerma } from '../backups.js';

/*
 * Il pulsante «Pubblica adesso» della copia leggera.
 *
 * Se la copia è spenta, il bot lo scrive solo nei log: è il caso normale del
 * giro notturno. Da un pulsante no — chi lo preme deve sapere perché nel
 * canale non è comparso niente. Questi casi sono la ragione per cui il
 * controllo sta nella rotta invece che solo nel bot.
 */

/** Una configurazione con la copia leggera come la si vuole. */
function conCopia(enabled: boolean, channelId: string | null) {
  const config = defaultGuildConfig();
  config.general.copiaLeggera = { ...config.general.copiaLeggera, enabled, channelId };
  return config;
}

describe('quando la copia leggera si può pubblicare', () => {
  it('spenta: lo dice, e dice dove accenderla', () => {
    expect(motivoCopiaFerma(conCopia(false, '123456789012345678'))).toMatch(/spenta.*Generale/);
  });

  it('accesa ma senza canale: dice che manca il canale', () => {
    expect(motivoCopiaFerma(conCopia(true, null))).toMatch(/canale/);
  });

  // La controprova: senza, una funzione che rifiuta sempre passerebbe.
  it('accesa e con il canale: si pubblica', () => {
    expect(motivoCopiaFerma(conCopia(true, '123456789012345678'))).toBeNull();
  });

  it('una configurazione che non si legge vale come spenta', () => {
    expect(motivoCopiaFerma({ general: 'non una configurazione' })).toMatch(/spenta/);
  });

  it('un server senza configurazione salvata: spenta, come parte', () => {
    expect(motivoCopiaFerma({})).toMatch(/spenta/);
  });
});

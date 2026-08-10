import { describe, expect, it } from 'vitest';
import { analyzeFile, DEFAULT_BLOCKED_EXTENSIONS, detectPolyglot, hasDoubleExtension } from '../files.js';

const options = {
  blockedExtensions: DEFAULT_BLOCKED_EXTENSIONS,
  verifyMagicBytes: true,
  blockDoubleExtension: true,
  detectPolyglot: true,
};

/** Intestazione PNG valida seguita da contenuto arbitrario. */
function pngHeader(tail: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), tail]);
}

/** Intestazione di un eseguibile Windows. */
function exeHeader(): Buffer {
  return Buffer.concat([Buffer.from('MZ'), Buffer.alloc(512, 0x00)]);
}

describe('estensione doppia', () => {
  it('riconosce foto.png.exe', () => {
    const result = hasDoubleExtension('foto.png.exe');
    expect(result).toEqual({ decoy: 'png', real: 'exe' });
  });

  it('riconosce fattura.pdf.scr', () => {
    expect(hasDoubleExtension('fattura.pdf.scr')?.real).toBe('scr');
  });

  it('non segnala un nome con punti legittimi', () => {
    // `tar` non è fra le estensioni-esca: un archivio compresso non è un
    // travestimento, mentre `foto.png.exe` lo è.
    expect(hasDoubleExtension('archivio.tar.gz')).toBeNull();
    expect(hasDoubleExtension('immagine.png')).toBeNull();
    expect(hasDoubleExtension('note.v2.txt')).toBeNull();
  });
});

describe('analisi degli allegati', () => {
  it('blocca un eseguibile dichiarato tale', async () => {
    const { findings } = await analyzeFile('setup.exe', exeHeader(), options);
    expect(findings.some((finding) => finding.code === 'FILE_BLOCKED_EXTENSION')).toBe(true);
  });

  it('smaschera un eseguibile rinominato in .png', async () => {
    const { findings } = await analyzeFile('gattino.png', exeHeader(), options);
    const mismatch = findings.find((finding) => finding.code === 'FILE_MAGIC_MISMATCH');
    expect(mismatch).toBeDefined();
    expect(mismatch!.score).toBeGreaterThanOrEqual(90);
  });

  it('assegna il punteggio massimo a un\'estensione doppia pericolosa', async () => {
    const { findings } = await analyzeFile('foto.png.exe', exeHeader(), options);
    const double = findings.find((finding) => finding.code === 'FILE_DOUBLE_EXTENSION');
    expect(double?.score).toBeGreaterThanOrEqual(90);
  });

  it('lascia passare un PNG autentico', async () => {
    const png = pngHeader(Buffer.alloc(1024, 0x42));
    const { findings } = await analyzeFile('immagine.png', png, options);
    expect(findings).toHaveLength(0);
  });

  it('calcola l\'hash del contenuto', async () => {
    const { analysis } = await analyzeFile('immagine.png', pngHeader(), options);
    expect(analysis.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('file polyglot', () => {
  it('riconosce un PNG con un archivio ZIP in coda', () => {
    const zipEnd = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
    const polyglot = pngHeader(Buffer.concat([Buffer.alloc(2048, 0x11), zipEnd]));
    expect(detectPolyglot(polyglot)?.detail).toContain('ZIP');
  });

  it('riconosce un PNG con la firma di un eseguibile all\'interno', () => {
    const payload = Buffer.concat([
      Buffer.alloc(1024, 0x33),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
      Buffer.alloc(256, 0x00),
    ]);
    expect(detectPolyglot(pngHeader(payload))).not.toBeNull();
  });

  it('non segnala un PNG pulito', () => {
    expect(detectPolyglot(pngHeader(Buffer.alloc(4096, 0x55)))).toBeNull();
  });
});

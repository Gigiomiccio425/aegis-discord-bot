import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/* ═══════════════════════════════════════════════════════════════════════
   I COLLEGAMENTI FRA LE PAGINE PORTANO ANCORA DA QUALCHE PARTE?

   Un collegamento rotto nella documentazione non rompe niente. Non fallisce
   nessuna build, non compare in nessun log: si scopre quando qualcuno ci
   clicca, cioè nel momento in cui sta già cercando aiuto — e trova un 404.

   Succede sempre per lo stesso motivo: una pagina viene spostata, o spezzata
   in più pagine, e i collegamenti restano scritti come prima. È esattamente
   quello che è successo spezzando un README di 1459 righe in quindici file:
   un link scritto dalla radice (`docs/pannello.md`), letto da dentro `docs/`,
   punta a `docs/docs/pannello.md`.

   Il controllo è testuale e senza rete: i collegamenti esterni non si
   verificano, perché un test che fallisce quando un sito altrui è giù è un
   test che qualcuno disattiva.
   ═══════════════════════════════════════════════════════════════════════ */

const qui = path.dirname(fileURLToPath(import.meta.url));
const RADICE = path.resolve(qui, '../../../..');

/** Ogni pagina Markdown che finisce su GitHub, con il percorso relativo. */
function pagine(): string[] {
  const trovate = readdirSync(RADICE).filter((nome) => nome.endsWith('.md'));

  const cartellaDocs = path.join(RADICE, 'docs');
  if (existsSync(cartellaDocs)) {
    for (const nome of readdirSync(cartellaDocs)) {
      if (nome.endsWith('.md')) trovate.push(`docs/${nome}`);
    }
  }

  return trovate;
}

/** I titoli di una pagina, ridotti alla forma che GitHub usa per le àncore. */
function ancore(testo: string): Set<string> {
  const dentroBlocco = (indice: number) =>
    (testo.slice(0, indice).match(/^```/gm) ?? []).length % 2 === 1;

  const trovate = new Set<string>();
  for (const titolo of testo.matchAll(/^#{1,6} +(.+?) *$/gm)) {
    if (dentroBlocco(titolo.index!)) continue;
    trovate.add(
      titolo[1]!
        .toLowerCase()
        .replace(/`/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_]/g, '')
        .replace(/[^\p{L}\p{N} -]/gu, '')
        .trim()
        .replace(/ /g, '-'),
    );
  }
  return trovate;
}

const contenuto = new Map(pagine().map((p) => [p, readFileSync(path.join(RADICE, p), 'utf8')]));

/** I collegamenti interni: niente http, niente mailto, niente àncore sole. */
function collegamenti(testo: string): { grezzo: string; file: string; ancora: string }[] {
  return [...testo.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((trovato) => trovato[1]!)
    .filter((href) => !/^(https?:|mailto:|#)/.test(href))
    .map((href) => {
      const [file, ancora] = href.split('#');
      return { grezzo: href, file: file!, ancora: ancora ?? '' };
    });
}

describe('collegamenti nella documentazione', () => {
  // La controprova: senza, un errore di lettura non troverebbe nessuna pagina
  // e ogni controllo qui sotto passerebbe su un insieme vuoto.
  it('le pagine ci sono', () => {
    expect(contenuto.has('README.md')).toBe(true);
    expect([...contenuto.keys()].filter((p) => p.startsWith('docs/')).length).toBeGreaterThan(5);
  });

  it('ogni collegamento porta a un file che esiste', () => {
    const rotti: string[] = [];

    for (const [pagina, testo] of contenuto) {
      const cartella = path.dirname(path.join(RADICE, pagina));
      for (const { grezzo, file } of collegamenti(testo)) {
        if (!file) continue;
        const bersaglio = path.resolve(cartella, decodeURIComponent(file));
        if (!existsSync(bersaglio)) rotti.push(`${pagina} → ${grezzo}`);
      }
    }

    expect(rotti, 'collegamenti a file inesistenti').toEqual([]);
  });

  /*
   * Un'àncora sbagliata è peggio di un file mancante: GitHub apre comunque la
   * pagina, in cima, e chi legge crede di essere nel punto giusto.
   */
  it('ogni àncora esiste nella pagina che indica', () => {
    const rotte: string[] = [];

    for (const [pagina, testo] of contenuto) {
      const cartella = path.dirname(path.join(RADICE, pagina));
      for (const { grezzo, file, ancora } of collegamenti(testo)) {
        if (!ancora || !file.endsWith('.md')) continue;

        const bersaglio = path.resolve(cartella, decodeURIComponent(file));
        if (!existsSync(bersaglio)) continue; // già segnalato dall'altro test
        if (!ancore(readFileSync(bersaglio, 'utf8')).has(ancora)) {
          rotte.push(`${pagina} → ${grezzo}`);
        }
      }
    }

    expect(rotte, 'àncore che non esistono nella pagina indicata').toEqual([]);
  });

  /*
   * Le àncore interne alla stessa pagina: è la forma che si rompe più spesso,
   * perché un titolo si riscrive senza pensare a chi lo indicava.
   */
  it('gli indici in cima alle pagine non indicano sezioni sparite', () => {
    const rotte: string[] = [];

    for (const [pagina, testo] of contenuto) {
      const presenti = ancore(testo);
      for (const trovato of testo.matchAll(/\[[^\]]*\]\(#([^)\s]+)\)/g)) {
        if (!presenti.has(trovato[1]!)) rotte.push(`${pagina} → #${trovato[1]}`);
      }
    }

    expect(rotte, 'àncore interne a una pagina che non esistono').toEqual([]);
  });

  /*
   * Lo split di un file lascia questa traccia: due separatori di fila, dove
   * finiva una parte e ne cominciava un'altra. Non rompe niente, ma è il
   * segno visibile che la pagina è stata tagliata e non riletta.
   */
  it('non restano separatori doppi dallo split', () => {
    const sporche = [...contenuto]
      .filter(([, testo]) => /\n---\s*\n\s*\n---\s*\n/.test(testo))
      .map(([pagina]) => pagina);

    expect(sporche, 'separatori doppi rimasti').toEqual([]);
  });

  it('i file di servizio che GitHub cerca ci sono tutti', () => {
    for (const nome of ['LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md']) {
      expect(existsSync(path.join(RADICE, nome)), nome).toBe(true);
    }
  });
});

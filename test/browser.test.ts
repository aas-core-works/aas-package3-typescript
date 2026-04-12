import { describe, expect, test } from 'vitest';
import { NewPackaging } from '../src';

describe('Browser compatibility', () => {
  test('supports in-memory creation and zip output without Node APIs', async () => {
    const packaging = NewPackaging();
    const pkg = await packaging.CreateInStream(memoryStream());

    const spec = await pkg.PutPart(
      new URL('https://package.local/aasx/browser.aas.xml'),
      'application/xml',
      new TextEncoder().encode('<aas/>')
    );
    await pkg.MakeSpec(spec);

    const pdf = await pkg.PutPart(
      new URL('https://package.local/aasx-suppl/documentation.pdf'),
      'application/pdf',
      new Uint8Array([0x25, 0x50, 0x44, 0x46])
    );
    await pkg.RelateSupplementaryToSpec(pdf, spec);

    const specs = await pkg.Specs();
    expect(specs).toHaveLength(1);

    const relationships = await pkg.SupplementaryRelationships();
    expect(relationships).toHaveLength(1);
    expect(relationships[0].Supplementary.URI.pathname).toBe('/aasx-suppl/documentation.pdf');

    const bytes = await pkg.Flush();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });
});

function memoryStream(): {
  readAll: () => Uint8Array;
  writeAll: (data: Uint8Array) => void;
} {
  let bytes = new Uint8Array();
  return {
    readAll: () => bytes,
    writeAll: (data: Uint8Array) => {
      bytes = data.slice();
    }
  };
}

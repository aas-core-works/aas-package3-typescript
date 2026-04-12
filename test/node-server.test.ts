import { describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NewPackaging } from '../src';

describe('Node server environment', () => {
  test('creates, flushes, reopens and mutates package on filesystem path APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aasx-node-'));
    const filePath = join(dir, 'sample.aasx');

    try {
      const packaging = NewPackaging();
      const writePkg = await packaging.Create(filePath);

      const spec = await writePkg.PutPart(
        new URL('https://package.local/aasx/spec.aas.xml'),
        'application/xml',
        new TextEncoder().encode('<aas/>')
      );
      await writePkg.MakeSpec(spec);
      await writePkg.Flush();
      await writePkg.Close();

      const readPkg = await packaging.OpenRead(filePath);
      const specs = await readPkg.Specs();
      expect(specs).toHaveLength(1);
      expect(specs[0].URI.pathname).toBe('/aasx/spec.aas.xml');
      await readPkg.Close();

      const rwPkg = await packaging.OpenReadWrite(filePath);
      const thumb = await rwPkg.PutPart(
        new URL('https://package.local/thumbnail.png'),
        'image/png',
        new Uint8Array([1, 2, 3, 4])
      );
      await rwPkg.SetThumbnail(thumb);
      await rwPkg.Flush();
      await rwPkg.Close();

      const reopened = await packaging.OpenRead(filePath);
      const thumbnail = await reopened.Thumbnail();
      expect(thumbnail?.URI.pathname).toBe('/thumbnail.png');
      await reopened.Close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

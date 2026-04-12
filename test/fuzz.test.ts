import { describe, expect, test } from 'vitest';
import { NewPackaging } from '../src';

describe('Fuzz-like randomized operations', () => {
  test('randomized round-trips stay readable for many small packages', async () => {
    const packaging = NewPackaging();

    for (let i = 0; i < 40; i += 1) {
      const pkg = await packaging.CreateInStream(memoryStream());
      const partCount = 1 + Math.floor(Math.random() * 6);

      for (let j = 0; j < partCount; j += 1) {
        const uri = new URL(`https://package.local/aasx/fuzz-${i}-${j}.txt`);
        const bytes = randomBytes(8 + Math.floor(Math.random() * 64));
        const part = await pkg.PutPart(uri, 'text/plain', bytes);

        if (j % 2 === 0) {
          await pkg.MakeSpec(part);
        }
      }

      const out = await pkg.Flush();
      const reopened = await packaging.OpenReadFromBytes(out);
      const specs = await reopened.Specs();
      expect(specs.length).toBeGreaterThan(0);
    }
  });

  test('opening random bytes never crashes process (throws controlled errors)', async () => {
    const packaging = NewPackaging();

    for (let i = 0; i < 60; i += 1) {
      const input = randomBytes(Math.floor(Math.random() * 256));
      try {
        await packaging.OpenReadFromBytes(input);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

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

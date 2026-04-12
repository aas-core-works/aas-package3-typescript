import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import {
  ErrInvalidFormat,
  ErrNoOriginPart,
  NewPackaging,
  RelationTypeAasxOrigin,
  RelationTypeAasxSpec,
  RelationTypeAasxSupplementary,
  RelationTypeThumbnail,
  Require
} from '../src';

describe('Packaging', () => {
  test('creates empty package with origin and no specs', async () => {
    const packaging = NewPackaging();
    const pkg = await packaging.CreateInStream(memoryStream());

    const specs = await pkg.Specs();
    expect(specs).toHaveLength(0);

    const thumbnail = await pkg.Thumbnail();
    expect(thumbnail).toBeNull();
  });

  test('writes parts, relates spec and supplementary, round-trips bytes', async () => {
    const packaging = NewPackaging();
    const pkg = await packaging.CreateInStream(memoryStream());

    const specUri = new URL('https://package.local/aasx/spec.aas.xml');
    const supplUri = new URL('https://package.local/aasx/doc.pdf');
    const thumbUri = new URL('https://package.local/aasx/thumb.png');

    const spec = await pkg.PutPart(specUri, 'application/xml', new TextEncoder().encode('<aas/>'));
    const suppl = await pkg.PutPart(supplUri, 'application/pdf', new Uint8Array([1, 2, 3]));
    const thumb = await pkg.PutPart(thumbUri, 'image/png', new Uint8Array([9, 8, 7]));

    await pkg.MakeSpec(spec);
    await pkg.RelateSupplementaryToSpec(suppl, spec);
    await pkg.SetThumbnail(thumb);

    const bytes = await pkg.Flush();

    const reopened = await packaging.OpenReadFromBytes(bytes);
    const specs = await reopened.Specs();
    expect(specs).toHaveLength(1);
    expect(specs[0].URI.pathname).toBe('/aasx/spec.aas.xml');

    const rels = await reopened.SupplementaryRelationships();
    expect(rels).toHaveLength(1);
    expect(rels[0].Spec.URI.pathname).toBe('/aasx/spec.aas.xml');
    expect(rels[0].Supplementary.URI.pathname).toBe('/aasx/doc.pdf');

    const thumbnail = await reopened.Thumbnail();
    expect(thumbnail?.URI.pathname).toBe('/aasx/thumb.png');
  });

  test('deleting part removes dangling relationships in strict mode', async () => {
    const packaging = NewPackaging();
    const pkg = await packaging.CreateInStream(memoryStream());

    const spec = await pkg.PutPart(
      new URL('https://package.local/aasx/spec.aas.xml'),
      'application/xml',
      new TextEncoder().encode('<aas/>')
    );
    const supplementary = await pkg.PutPart(
      new URL('https://package.local/aasx/doc.pdf'),
      'application/pdf',
      new Uint8Array([1])
    );

    await pkg.MakeSpec(spec);
    await pkg.RelateSupplementaryToSpec(supplementary, spec);

    await pkg.DeletePart(spec);

    const bytes = await pkg.Flush();
    const reopened = await packaging.OpenReadFromBytes(bytes);

    const specs = await reopened.Specs();
    expect(specs).toHaveLength(0);

    const supplementaryRels = await reopened.SupplementaryRelationships();
    expect(supplementaryRels).toHaveLength(0);
  });

  test('relationship constants are preserved', () => {
    expect(RelationTypeAasxSpec).toContain('aas-spec');
    expect(RelationTypeAasxSupplementary).toContain('aas-suppl');
    expect(RelationTypeThumbnail).toContain('thumbnail');
  });

  test('Require throws in debug mode', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = true;
    expect(() => Require(false, 'test')).toThrow('precondition violation');
    globalThis.__AASX_DEBUG_CONTRACTS__ = undefined;
  });

  test('returns invalid format error for malformed bytes', async () => {
    const packaging = NewPackaging();
    await expect(packaging.OpenReadFromBytes(new TextEncoder().encode('not a zip'))).rejects.toThrow(ErrInvalidFormat);
  });

  test('returns no origin error for empty OPC zip', async () => {
    const packaging = NewPackaging();
    await expect(packaging.OpenReadFromBytes(zipSync({}))).rejects.toThrow(ErrNoOriginPart);
  });

  test('opens package with deprecated aasx relationship host for origin/spec/supplementary', async () => {
    const packaging = NewPackaging();
    const pkg = await packaging.CreateInStream(memoryStream());

    const spec = await pkg.PutPart(
      new URL('https://package.local/aasx/spec.aas.xml'),
      'application/xml',
      new TextEncoder().encode('<aas/>')
    );
    const supplementary = await pkg.PutPart(
      new URL('https://package.local/aasx/doc.pdf'),
      'application/pdf',
      new Uint8Array([1, 2, 3])
    );

    await pkg.MakeSpec(spec);
    await pkg.RelateSupplementaryToSpec(supplementary, spec);

    const bytes = await pkg.Flush();
    const deprecatedHostBytes = rewriteAasxRelationshipHost(bytes, DeprecatedAasxRelationshipsPrefix);

    const reopened = await packaging.OpenReadFromBytes(deprecatedHostBytes);
    const specs = await reopened.Specs();
    expect(specs).toHaveLength(1);
    expect(await reopened.IsSpec(specs[0])).toBe(true);

    const supplementaryRels = await reopened.SupplementaryRelationships();
    expect(supplementaryRels).toHaveLength(1);
    expect(supplementaryRels[0].Spec.URI.pathname).toBe('/aasx/spec.aas.xml');
    expect(supplementaryRels[0].Supplementary.URI.pathname).toBe('/aasx/doc.pdf');
  });

  test('writes preferred relationship host after opening deprecated host package', async () => {
    const packaging = NewPackaging();
    const pkg = await packaging.CreateInStream(memoryStream());

    const spec = await pkg.PutPart(
      new URL('https://package.local/aasx/spec.aas.xml'),
      'application/xml',
      new TextEncoder().encode('<aas/>')
    );
    await pkg.MakeSpec(spec);

    const initialBytes = await pkg.Flush();
    const deprecatedHostBytes = rewriteAasxRelationshipHost(initialBytes, DeprecatedAasxRelationshipsPrefix);

    const reopened = await packaging.OpenReadWriteFromBytes(deprecatedHostBytes);
    const roundTripBytes = await reopened.Flush();

    const relsXmls = getRelationshipXmlFiles(roundTripBytes);
    expect(relsXmls.length).toBeGreaterThan(0);
    for (const xml of relsXmls) {
      expect(xml).not.toContain(DeprecatedAasxRelationshipsPrefix);
    }
    expect(relsXmls.join('\n')).toContain(RelationTypeAasxOrigin);
    expect(relsXmls.join('\n')).toContain(RelationTypeAasxSpec);
    expect(relsXmls.join('\n')).not.toContain(RelationTypeAasxSupplementary);
  });

  test('round-trip serialization keeps package-local relationships internal and external relationships external', async () => {
    const packaging = NewPackaging();
    const pkg = await packaging.CreateInStream(memoryStream());

    const spec = await pkg.PutPart(
      new URL('https://package.local/aasx/spec.aas.xml'),
      'application/xml',
      new TextEncoder().encode('<aas/>')
    );
    const supplementary = await pkg.PutPart(
      new URL('https://package.local/aasx/doc.pdf'),
      'application/pdf',
      new Uint8Array([1, 2, 3])
    );

    await pkg.MakeSpec(spec);
    await pkg.RelateSupplementaryToSpec(supplementary, spec);

    const initialBytes = await pkg.Flush();
    const bytesWithExternalRel = addExternalRootRelationship(
      initialBytes,
      'Rext0001',
      'http://example.com/relationships/external-ref',
      'https://example.com/external-resource'
    );

    const reopened = await packaging.OpenReadWriteFromBytes(bytesWithExternalRel);
    const roundTripBytes = await reopened.Flush();
    const rels = getRelationshipXmlFileMap(roundTripBytes);

    const rootRels = rels['_rels/.rels'];
    expect(rootRels).toBeTruthy();
    const originRel = findRelationshipTag(rootRels, RelationTypeAasxOrigin);
    expect(originRel).toBeTruthy();
    expect(originRel).toContain('Target="/aasx/aasx-origin"');
    expect(originRel).not.toContain('TargetMode="External"');

    const supplementaryRels = rels['aasx/_rels/spec.aas.xml.rels'];
    expect(supplementaryRels).toBeTruthy();
    const supplementaryRel = findRelationshipTag(supplementaryRels, RelationTypeAasxSupplementary);
    expect(supplementaryRel).toBeTruthy();
    expect(supplementaryRel).toContain('Target="/aasx/doc.pdf"');
    expect(supplementaryRel).not.toContain('TargetMode="External"');

    const externalRel = findRelationshipTag(rootRels, 'http://example.com/relationships/external-ref');
    expect(externalRel).toBeTruthy();
    expect(externalRel).toContain('Target="https://example.com/external-resource"');
    expect(externalRel).toContain('TargetMode="External"');
  });

  test('groups specs by content type and sorts by URI path', async () => {
    const packaging = NewPackaging();
    const pkg = await packaging.CreateInStream(memoryStream());

    const a = await pkg.PutPart(new URL('https://package.local/aasx/some-company/data.json'), 'text/json', new TextEncoder().encode('{}'));
    const b = await pkg.PutPart(new URL('https://package.local/aasx/some-company/data1.json'), 'text/json', new TextEncoder().encode('{"x":1}'));
    const c = await pkg.PutPart(new URL('https://package.local/aasx/some-company/data.xml'), 'text/xml', new TextEncoder().encode('<a/>'));

    await pkg.MakeSpec(a);
    await pkg.MakeSpec(b);
    await pkg.MakeSpec(c);

    const grouped = await pkg.SpecsByContentType();
    expect(Object.keys(grouped).sort()).toEqual(['text/json', 'text/xml']);
    expect(grouped['text/json'].map((part) => part.URI.pathname)).toEqual([
      '/aasx/some-company/data.json',
      '/aasx/some-company/data1.json'
    ]);
    expect(grouped['text/xml'].map((part) => part.URI.pathname)).toEqual(['/aasx/some-company/data.xml']);
  });

  test('can include copied TestResources fixture files as parts', async () => {
    const packaging = NewPackaging();
    const pkg = await packaging.CreateInStream(memoryStream());

    const fixturePath = join(
      process.cwd(),
      'TestResources',
      'TestPackageRead',
      '01_Festo',
      'wwwcompanycomidsaas9350_1162_7091_7335.aas.xml'
    );
    const fixtureBytes = new Uint8Array(await readFile(fixturePath));

    const spec = await pkg.PutPart(
      new URL('https://package.local/aasx/fixture/01_Festo.aas.xml'),
      'application/xml',
      fixtureBytes
    );
    await pkg.MakeSpec(spec);

    const out = await pkg.Flush();
    const files = unzipSync(out);
    expect(files['aasx/fixture/01_Festo.aas.xml']).toBeTruthy();
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

const PreferredAasxRelationshipsPrefix = 'http://admin-shell.io/aasx/relationships/';
const DeprecatedAasxRelationshipsPrefix = 'http://www.admin-shell.io/aasx/relationships/';

function rewriteAasxRelationshipHost(bytes: Uint8Array, nextPrefix: string): Uint8Array {
  const files = unzipSync(bytes);
  const rewritten: Record<string, Uint8Array> = {};

  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('.rels')) {
      const xml = new TextDecoder().decode(content);
      rewritten[name] = new TextEncoder().encode(
        xml
          .split(PreferredAasxRelationshipsPrefix)
          .join(nextPrefix)
          .split(DeprecatedAasxRelationshipsPrefix)
          .join(nextPrefix)
      );
      continue;
    }
    rewritten[name] = content;
  }

  return zipSync(rewritten, { level: 0 });
}

function getRelationshipXmlFiles(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes);
  const relEntries = Object.entries(files).filter(([name]) => name.endsWith('.rels'));
  return relEntries.map(([, content]) => new TextDecoder().decode(content));
}

function getRelationshipXmlFileMap(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  const rels: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith('.rels')) {
      continue;
    }
    rels[name] = new TextDecoder().decode(content);
  }
  return rels;
}

function addExternalRootRelationship(
  bytes: Uint8Array,
  id: string,
  relType: string,
  target: string
): Uint8Array {
  const files = unzipSync(bytes);
  const rootPath = '_rels/.rels';
  const rootRels = new TextDecoder().decode(files[rootPath]);
  const externalRelationship = `  <Relationship Id="${id}" Type="${relType}" Target="${target}" TargetMode="External"/>\n`;

  files[rootPath] = new TextEncoder().encode(rootRels.replace('</Relationships>', `${externalRelationship}</Relationships>`));
  return zipSync(files, { level: 0 });
}

function findRelationshipTag(xml: string, relType: string): string | null {
  const escapedType = relType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<Relationship\\b[^>]*\\bType="${escapedType}"[^>]*/>`));
  return match ? match[0] : null;
}

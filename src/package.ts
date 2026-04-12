import { unzipSync, zipSync } from 'fflate';
import { parseXmlString, serializeXml } from 'xmlsax-typescript';
import { Ensure, Require } from './dbc';

export const RelationTypeAasxOrigin = 'http://admin-shell.io/aasx/relationships/aasx-origin';
export const RelationTypeAasxSpec = 'http://admin-shell.io/aasx/relationships/aas-spec';
export const RelationTypeAasxSupplementary = 'http://admin-shell.io/aasx/relationships/aas-suppl';
export const RelationTypeThumbnail = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail';

const AasxRelationshipsPrefix = 'http://admin-shell.io/aasx/relationships/';

const OpcRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OpcContentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';

export const ErrNoOriginPart = 'no origin part found';
export const ErrPartNotFound = 'part not found';
export const ErrInvalidFormat = 'invalid package format';

interface Relationship {
  id: string;
  relType: string;
  target: string;
  targetMode?: string;
}

interface XmlNodeLike {
  name: string;
  attributes?: Record<string, string>;
  children?: Array<string | XmlNodeLike>;
}

interface PackageSink {
  write(data: Uint8Array): Promise<void>;
}

export interface ReadSeeker {
  readAll(): Uint8Array | Promise<Uint8Array>;
}

export interface ReadWriteSeeker extends ReadSeeker {
  writeAll(data: Uint8Array): void | Promise<void>;
}

class FileSink implements PackageSink {
  constructor(private readonly path: string) {}

  async write(data: Uint8Array): Promise<void> {
    const fs = await import('node:fs/promises');
    await fs.writeFile(this.path, data);
  }
}

class StreamSink implements PackageSink {
  constructor(private readonly stream: ReadWriteSeeker) {}

  async write(data: Uint8Array): Promise<void> {
    await this.stream.writeAll(data);
  }
}

class PackageBase {
  public readonly parts = new Map<string, Part>();
  public readonly relationships = new Map<string, Relationship[]>();
  public originURI = '';
  public nextRelID = 1;

  constructor(
    public readonly path: string,
    public readWrite: boolean,
    public readonly sink: PackageSink | null
  ) {}

  addRelationship(sourcePath: string, targetPath: string, relType: string): string {
    const id = `R${this.nextRelID.toString(16).padStart(8, '0')}`;
    this.nextRelID += 1;
    return this.addRelationshipWithID(sourcePath, targetPath, relType, id);
  }

  addRelationshipWithID(
    sourcePath: string,
    targetPath: string,
    relType: string,
    id: string,
    targetModeHint?: string
  ): string {
    const normalizedSource = normalizePathForMap(sourcePath);
    const existing = this.relationships.get(normalizedSource) ?? [];
    const normalizedTarget = targetPath.replace(/\\/g, '/');
    existing.push({
      id,
      relType: canonicalizeRelationshipType(relType),
      target: normalizedTarget,
      targetMode: determineRelationshipTargetMode(normalizedTarget, targetModeHint)
    });
    this.relationships.set(normalizedSource, existing);
    return id;
  }

  removeRelationship(sourcePath: string, targetPath: string, relType: string): void {
    const normalizedSource = normalizePathForMap(sourcePath);
    const normalizedTarget = normalizePathForMap(targetPath);
    const old = this.relationships.get(normalizedSource) ?? [];
    this.relationships.set(
      normalizedSource,
      old.filter(
        (rel) =>
          !(normalizePathForMap(rel.target) === normalizedTarget && relationshipTypeEquals(rel.relType, relType))
      )
    );
  }

  removeAllRelationshipsWithSourceOrTarget(uriPath: string): void {
    const normalizedPath = normalizePathForMap(uriPath);
    this.relationships.delete(normalizedPath);

    for (const [source, rels] of this.relationships.entries()) {
      const filtered = rels.filter((rel) => normalizePathForMap(rel.target) !== normalizedPath);
      if (filtered.length === 0) {
        this.relationships.delete(source);
      } else {
        this.relationships.set(source, filtered);
      }
    }
  }

  hasRelationship(sourcePath: string, targetPath: string, relType: string): boolean {
    const normalizedSource = normalizePathForMap(sourcePath);
    const normalizedTarget = normalizePathForMap(targetPath);
    return (this.relationships.get(normalizedSource) ?? []).some(
      (rel) => relationshipTypeEquals(rel.relType, relType) && normalizePathForMap(rel.target) === normalizedTarget
    );
  }

  getRelationshipsByType(sourcePath: string, relType: string): Relationship[] {
    const normalizedSource = normalizePathForMap(sourcePath);
    return (this.relationships.get(normalizedSource) ?? []).filter((rel) => relationshipTypeEquals(rel.relType, relType));
  }
}

export class Part {
  constructor(
    public readonly URI: URL,
    public ContentType: string,
    private content: Uint8Array,
    public readonly pkg: PackageBase
  ) {}

  Stream(): ReadableStream<Uint8Array> {
    const bytes = this.ReadAllBytes();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
  }

  ReadAllBytes(): Uint8Array {
    return this.content.slice();
  }

  ReadAllText(): string {
    return new TextDecoder().decode(this.content);
  }

  setContent(content: Uint8Array): void {
    this.content = content;
  }
}

export interface SupplementaryRelationship {
  Spec: Part;
  Supplementary: Part;
}

export class Packaging {
  Create = async (path: string): Promise<PackageReadWrite> => {
    const pkg = new PackageBase(path, true, new FileSink(path));
    initializeNewPackage(pkg);

    const result = new PackageReadWrite(path, pkg);
    const specs = await result.Specs();
    Ensure(specs.length === 0, 'Specs must be empty in a new package.');

    return result;
  };

  CreateInStream = async (stream: ReadWriteSeeker): Promise<PackageReadWrite> => {
    const pkg = new PackageBase('', true, new StreamSink(stream));
    initializeNewPackage(pkg);
    return new PackageReadWrite('', pkg);
  };

  OpenRead = async (path: string): Promise<PackageRead> => {
    const fs = await import('node:fs/promises');
    const bytes = await fs.readFile(path);
    const pkg = openFromBytes(new Uint8Array(bytes), path, false, null);
    return new PackageRead(path, pkg);
  };

  OpenReadFromStream = async (stream: ReadSeeker): Promise<PackageRead> => {
    const bytes = await stream.readAll();
    const pkg = openFromBytes(bytes, '', false, null);
    return new PackageRead('', pkg);
  };

  OpenReadWrite = async (path: string): Promise<PackageReadWrite> => {
    const fs = await import('node:fs/promises');
    const bytes = await fs.readFile(path);
    const pkg = openFromBytes(new Uint8Array(bytes), path, true, new FileSink(path));
    return new PackageReadWrite(path, pkg);
  };

  OpenReadWriteFromStream = async (stream: ReadWriteSeeker): Promise<PackageReadWrite> => {
    const bytes = await stream.readAll();
    const pkg = openFromBytes(bytes, '', true, new StreamSink(stream));
    return new PackageReadWrite('', pkg);
  };

  OpenReadFromBytes = async (bytes: Uint8Array): Promise<PackageRead> => {
    const pkg = openFromBytes(bytes, '', false, null);
    return new PackageRead('', pkg);
  };

  OpenReadWriteFromBytes = async (bytes: Uint8Array): Promise<PackageReadWrite> => {
    const pkg = openFromBytes(bytes, '', true, null);
    return new PackageReadWrite('', pkg);
  };
}

export function NewPackaging(): Packaging {
  return new Packaging();
}

export class PackageRead {
  constructor(
    public readonly Path: string,
    protected readonly base: PackageBase
  ) {}

  Close(): void {
    return;
  }

  async Specs(): Promise<Part[]> {
    const result: Part[] = [];
    const rels = this.base.getRelationshipsByType(this.base.originURI, RelationTypeAasxSpec);

    for (const rel of rels) {
      const target = normalizePathForMap(rel.target);
      const part = this.base.parts.get(target);
      if (part) {
        result.push(part);
      }
    }

    return result;
  }

  async SpecsByContentType(): Promise<Record<string, Part[]>> {
    const specs = await this.Specs();
    const grouped: Record<string, Part[]> = {};

    for (const spec of specs) {
      grouped[spec.ContentType] ??= [];
      grouped[spec.ContentType].push(spec);
    }

    for (const contentType of Object.keys(grouped)) {
      grouped[contentType].sort((left, right) => pathFromUri(left.URI).localeCompare(pathFromUri(right.URI)));
    }

    return grouped;
  }

  async IsSpec(part: Part): Promise<boolean> {
    return this.base.hasRelationship(this.base.originURI, pathFromUri(part.URI), RelationTypeAasxSpec);
  }

  async SupplementariesFor(spec: Part): Promise<Part[]> {
    const result: Part[] = [];
    const rels = this.base.getRelationshipsByType(pathFromUri(spec.URI), RelationTypeAasxSupplementary);

    for (const rel of rels) {
      const target = normalizePathForMap(rel.target);
      const part = this.base.parts.get(target);
      if (!part) {
        throw new Error(`supplementary part ${rel.target} not found`);
      }
      result.push(part);
    }

    return result;
  }

  async SupplementaryRelationships(): Promise<SupplementaryRelationship[]> {
    const specs = await this.Specs();
    const result: SupplementaryRelationship[] = [];

    for (const spec of specs) {
      const supplementaries = await this.SupplementariesFor(spec);
      for (const supplementary of supplementaries) {
        result.push({
          Spec: spec,
          Supplementary: supplementary
        });
      }
    }

    return result;
  }

  async FindPart(uri: URL): Promise<Part | null> {
    return this.base.parts.get(normalizeURI(uri)) ?? null;
  }

  async MustPart(uri: URL): Promise<Part> {
    const part = await this.FindPart(uri);
    if (!part) {
      throw new Error(`${ErrPartNotFound}: ${pathFromUri(uri)}`);
    }
    return part;
  }

  async Thumbnail(): Promise<Part | null> {
    const rels = this.base.getRelationshipsByType('', RelationTypeThumbnail);
    if (rels.length === 0) {
      return null;
    }

    const target = normalizePathForMap(rels[0].target);
    const part = this.base.parts.get(target);
    if (!part) {
      throw new Error(`thumbnail relationship exists but part not found: ${rels[0].target}`);
    }
    return part;
  }
}

export class PackageReadWrite extends PackageRead {
  async PutPart(uri: URL, contentType: string, content: Uint8Array): Promise<Part> {
    const normalized = normalizeURI(uri);
    const bytes = content.slice();

    let part = this.base.parts.get(normalized);
    if (part) {
      part.ContentType = contentType;
      part.setContent(bytes);
    } else {
      part = new Part(uri, contentType, bytes, this.base);
      this.base.parts.set(normalized, part);
    }

    Ensure(this.base.parts.has(normalized), 'The part should be included in the package.');
    return part;
  }

  async PutPartFromStream(uri: URL, contentType: string, stream: ReadableStream<Uint8Array>): Promise<Part> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    return this.PutPart(uri, contentType, merged);
  }

  async DeletePart(part: Part): Promise<void> {
    const normalized = normalizeURI(part.URI);
    this.base.parts.delete(normalized);
    this.base.removeAllRelationshipsWithSourceOrTarget(pathFromUri(part.URI));
    Ensure(!this.base.parts.has(normalized), 'The part should not exist in the package anymore.');
  }

  async MakeSpec(part: Part): Promise<void> {
    if (this.base.hasRelationship(this.base.originURI, pathFromUri(part.URI), RelationTypeAasxSpec)) {
      return;
    }

    this.base.addRelationship(this.base.originURI, pathFromUri(part.URI), RelationTypeAasxSpec);
  }

  async UnmakeSpec(part: Part): Promise<void> {
    const isSpec = this.base.hasRelationship(this.base.originURI, pathFromUri(part.URI), RelationTypeAasxSpec);
    Require(isSpec, 'The part fulfills the spec property.');

    this.base.removeRelationship(this.base.originURI, pathFromUri(part.URI), RelationTypeAasxSpec);
    this.base.relationships.delete(normalizeURI(part.URI));
  }

  async RelateSupplementaryToSpec(supplementary: Part, spec: Part): Promise<void> {
    const isSpec = this.base.hasRelationship(this.base.originURI, pathFromUri(spec.URI), RelationTypeAasxSpec);
    Require(isSpec, 'The part fulfills the spec property.');

    if (this.base.hasRelationship(pathFromUri(spec.URI), pathFromUri(supplementary.URI), RelationTypeAasxSupplementary)) {
      return;
    }

    this.base.addRelationship(pathFromUri(spec.URI), pathFromUri(supplementary.URI), RelationTypeAasxSupplementary);
  }

  async UnrelateSupplementaryFromSpec(supplementary: Part, spec: Part): Promise<void> {
    const isSpec = this.base.hasRelationship(this.base.originURI, pathFromUri(spec.URI), RelationTypeAasxSpec);
    Require(isSpec, 'The part fulfills the spec property.');

    this.base.removeRelationship(pathFromUri(spec.URI), pathFromUri(supplementary.URI), RelationTypeAasxSupplementary);
  }

  async SetThumbnail(part: Part): Promise<void> {
    const rels = this.base.getRelationshipsByType('', RelationTypeThumbnail);
    for (const rel of rels) {
      this.base.removeRelationship('', rel.target, RelationTypeThumbnail);
    }

    this.base.addRelationship('', pathFromUri(part.URI), RelationTypeThumbnail);
  }

  async UnsetThumbnail(): Promise<void> {
    const rels = this.base.getRelationshipsByType('', RelationTypeThumbnail);
    for (const rel of rels) {
      this.base.removeRelationship('', rel.target, RelationTypeThumbnail);
    }
  }

  async Flush(): Promise<Uint8Array> {
    const bytes = this.writeToBytes();
    if (this.base.sink) {
      await this.base.sink.write(bytes);
    }
    return bytes;
  }

  private writeToBytes(): Uint8Array {
    const files: Record<string, Uint8Array> = {};

    const contentTypesXml = buildContentTypesXml(this.base.parts);
    files['[Content_Types].xml'] = encodeUtf8(contentTypesXml);

    for (const [sourcePath, rels] of this.base.relationships.entries()) {
      if (rels.length === 0) {
        continue;
      }

      const relsPath = getRelsPath(sourcePath);
      const relsXml = buildRelationshipsXml(rels);
      files[trimLeadingSlash(relsPath)] = encodeUtf8(relsXml);
    }

    for (const part of this.base.parts.values()) {
      files[trimLeadingSlash(pathFromUri(part.URI))] = part.ReadAllBytes();
    }

    return zipSync(files, { level: 0 });
  }
}

function initializeNewPackage(pkg: PackageBase): void {
  const originUri = asPackageUrl('/aasx/aasx-origin');
  const origin = new Part(originUri, 'text/plain', encodeUtf8('Intentionally empty.'), pkg);
  pkg.parts.set(normalizeURI(originUri), origin);
  pkg.originURI = normalizeURI(originUri);
  pkg.addRelationship('', pathFromUri(originUri), RelationTypeAasxOrigin);
}

function openFromBytes(bytes: Uint8Array, path: string, readWrite: boolean, sink: PackageSink | null): PackageBase {
  try {
    const entries = unzipSync(bytes);
    const pkg = new PackageBase(path, readWrite, sink);

    const contentTypePath = '[Content_Types].xml';
    const contentTypesMap = new Map<string, string>();
    const defaultTypes = new Map<string, string>();

    if (entries[contentTypePath]) {
      const parsed = parseContentTypesXml(decodeUtf8(entries[contentTypePath]));
      for (const item of parsed.defaults) {
        defaultTypes.set(item.extension.toLowerCase(), item.contentType);
      }
      for (const item of parsed.overrides) {
        contentTypesMap.set(normalizePathForMap(item.partName), item.contentType);
      }
    }

    for (const name of Object.keys(entries)) {
      if (name.includes('_rels/') && name.endsWith('.rels')) {
        const sourcePath = getSourcePathFromRelsPath(name);
        const rels = parseRelationshipsXml(decodeUtf8(entries[name]));

        for (const rel of rels) {
          const targetPath = resolveRelativeURI(sourcePath, rel.target);
          pkg.addRelationshipWithID(sourcePath, targetPath, rel.relType, rel.id, rel.targetMode);

          if (relationshipTypeEquals(rel.relType, RelationTypeAasxOrigin) && sourcePath === '') {
            pkg.originURI = normalizePathForMap(targetPath);
          }
        }
      }
    }

    if (!pkg.originURI) {
      throw new Error(ErrNoOriginPart);
    }

    for (const name of Object.keys(entries)) {
      if (name === contentTypePath || name.includes('_rels/') || name.endsWith('/')) {
        continue;
      }

      const partPath = ensureLeadingSlash(name);
      const normalized = normalizePathForMap(partPath);
      let contentType = contentTypesMap.get(normalized) ?? '';
      if (!contentType) {
        const ext = extName(name).replace('.', '').toLowerCase();
        contentType = defaultTypes.get(ext) ?? 'application/octet-stream';
      }

      const uri = asPackageUrl(partPath);
      pkg.parts.set(normalized, new Part(uri, contentType, entries[name], pkg));
    }

    return pkg;
  } catch (error) {
    if (error instanceof Error && error.message === ErrNoOriginPart) {
      throw error;
    }
    throw new Error(`${ErrInvalidFormat}: ${(error as Error).message}`);
  }
}

function canonicalizeRelationshipType(relType: string): string {
  const trimmed = relType.trim();
  const match = /^https?:\/\/(?:www\.)?admin-shell\.io\/aasx\/relationships\/(.+)$/i.exec(trimmed);
  if (match) {
    return `${AasxRelationshipsPrefix}${match[1]}`;
  }
  return trimmed;
}

function relationshipTypeEquals(left: string, right: string): boolean {
  return canonicalizeRelationshipType(left) === canonicalizeRelationshipType(right);
}

function parseRelationshipsXml(xml: string): Relationship[] {
  const root = parseXmlString(xml) as XmlNodeLike;
  if (root.name !== 'Relationships') {
    return [];
  }

  const relationships: Relationship[] = [];
  for (const child of root.children ?? []) {
    if (typeof child === 'string' || child.name !== 'Relationship') {
      continue;
    }

    const attributes = child.attributes ?? {};
    const id = attributes.Id;
    const relType = attributes.Type;
    const target = attributes.Target;
    if (!id || !relType || !target) {
      continue;
    }

    relationships.push({
      id,
      relType,
      target,
      targetMode: attributes.TargetMode
    });
  }

  return relationships;
}

function parseContentTypesXml(xml: string): {
  defaults: Array<{ extension: string; contentType: string }>;
  overrides: Array<{ partName: string; contentType: string }>;
} {
  const root = parseXmlString(xml) as XmlNodeLike;
  if (root.name !== 'Types') {
    return { defaults: [], overrides: [] };
  }

  const defaults: Array<{ extension: string; contentType: string }> = [];
  const overrides: Array<{ partName: string; contentType: string }> = [];

  for (const child of root.children ?? []) {
    if (typeof child === 'string') {
      continue;
    }

    const attributes = child.attributes ?? {};
    if (child.name === 'Default') {
      const extension = attributes.Extension;
      const contentType = attributes.ContentType;
      if (extension && contentType) {
        defaults.push({ extension, contentType });
      }
      continue;
    }

    if (child.name === 'Override') {
      const partName = attributes.PartName;
      const contentType = attributes.ContentType;
      if (partName && contentType) {
        overrides.push({ partName, contentType });
      }
    }
  }

  return {
    defaults,
    overrides
  };
}

function buildRelationshipsXml(relationships: Relationship[]): string {
  const xml = serializeXml({
    name: 'Relationships',
    attributes: {
      xmlns: OpcRelationshipNamespace
    },
    children: relationships.map((rel) => ({
      name: 'Relationship',
      attributes: {
        Id: rel.id,
        Type: rel.relType,
        Target: rel.target,
        ...(determineRelationshipTargetMode(rel.target, rel.targetMode) === 'External' ? { TargetMode: 'External' } : {})
      },
      children: []
    }))
  }, {
    pretty: true,
    xmlDeclaration: true
  });

  return `${xml}\n`;
}

function buildContentTypesXml(parts: Map<string, Part>): string {
  const extMap = new Map<string, string>();
  const overrides = new Map<string, string>();

  for (const part of parts.values()) {
    const path = pathFromUri(part.URI);
    const ext = extName(path).replace('.', '').toLowerCase();

    if (!ext) {
      overrides.set(path, part.ContentType);
      continue;
    }

    const existing = extMap.get(ext);
    if (existing && existing !== part.ContentType) {
      overrides.set(path, part.ContentType);
      continue;
    }

    if (!existing) {
      extMap.set(ext, part.ContentType);
    }
  }

  const defaults = [
    {
      Extension: 'rels',
      ContentType: 'application/vnd.openxmlformats-package.relationships+xml'
    },
    ...Array.from(extMap.entries())
      .map(([extension, contentType]) => ({ Extension: extension, ContentType: contentType }))
      .sort((left, right) => left.Extension.localeCompare(right.Extension))
  ];

  const overrideEntries = Array.from(overrides.entries())
    .map(([partName, contentType]) => ({
      PartName: partName,
      ContentType: contentType
    }))
    .sort((left, right) => left.PartName.localeCompare(right.PartName));

  const xml = serializeXml({
    name: 'Types',
    attributes: {
      xmlns: OpcContentTypesNamespace
    },
    children: [
      ...defaults.map((item) => ({
        name: 'Default',
        attributes: {
          Extension: item.Extension,
          ContentType: item.ContentType
        },
        children: []
      })),
      ...overrideEntries.map((item) => ({
        name: 'Override',
        attributes: {
          PartName: item.PartName,
          ContentType: item.ContentType
        },
        children: []
      }))
    ]
  }, {
    pretty: true,
    xmlDeclaration: true
  });

  return `${xml}\n`;
}

function normalizeURI(uri: URL | null): string {
  if (!uri) {
    return '';
  }
  const value = pathFromUri(uri);
  return normalizePathForMap(value.startsWith('/') ? value : `/${value}`);
}

function pathFromUri(uri: URL): string {
  return uri.pathname || uri.toString();
}

function normalizePathForMap(path: string): string {
  if (!path) {
    return '';
  }
  const withPrefix = path.startsWith('/') ? path : `/${path}`;
  return normalizePath(withPrefix).toLowerCase();
}

function getSourcePathFromRelsPath(relsPath: string): string {
  const clean = trimLeadingSlash(relsPath);
  if (clean === '_rels/.rels') {
    return '';
  }

  const dir = dirName(clean).replace(/\/_rels$/, '').replace(/^_rels$/, '');
  const base = baseName(clean).replace(/\.rels$/, '');

  if (!dir || dir === '.') {
    return ensureLeadingSlash(base);
  }
  return ensureLeadingSlash(`${dir}/${base}`);
}

function getRelsPath(sourcePath: string): string {
  const normalized = normalizePathForMap(sourcePath);
  if (!normalized) {
    return '/_rels/.rels';
  }

  const dir = dirName(normalized);
  const base = baseName(normalized);

  if (!dir || dir === '/') {
    return `/_rels/${base}.rels`;
  }

  return `${dir}/_rels/${base}.rels`;
}

function resolveRelativeURI(sourcePath: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, '/');
  if (isAbsoluteExternalURI(normalizedTarget)) {
    return normalizedTarget;
  }

  if (normalizedTarget.startsWith('/')) {
    return normalizedTarget;
  }

  const sourceDirectory = !sourcePath ? '/' : dirName(sourcePath) || '/';
  return normalizePath(`${sourceDirectory}/${normalizedTarget}`);
}

function determineRelationshipTargetMode(target: string, targetModeHint?: string): 'Internal' | 'External' {
  const normalizedHint = targetModeHint?.trim().toLowerCase();
  if (normalizedHint === 'external' && isAbsoluteExternalURI(target)) {
    return 'External';
  }
  if (normalizedHint === 'internal' && !isAbsoluteExternalURI(target)) {
    return 'Internal';
  }

  return isAbsoluteExternalURI(target) ? 'External' : 'Internal';
}

function isAbsoluteExternalURI(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function normalizePath(input: string): string {
  const segments = input.split('/');
  const stack: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  return `/${stack.join('/')}`;
}

function dirName(path: string): string {
  const normalized = trimTrailingSlash(path);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return '/';
  }
  return normalized.slice(0, index);
}

function baseName(path: string): string {
  const normalized = trimTrailingSlash(path);
  const index = normalized.lastIndexOf('/');
  if (index < 0) {
    return normalized;
  }
  return normalized.slice(index + 1);
}

function extName(path: string): string {
  const base = baseName(path);
  const index = base.lastIndexOf('.');
  if (index <= 0) {
    return '';
  }
  return base.slice(index);
}

function trimTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1);
  }
  return path;
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function trimLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function asPackageUrl(path: string): URL {
  return new URL(`https://package.local${ensureLeadingSlash(path)}`);
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

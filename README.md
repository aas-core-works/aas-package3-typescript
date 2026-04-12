# aas-package3-typescript

[![Test](https://github.com/aas-core-works/aas-package3-typescript/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/aas-core-works/aas-package3-typescript/actions/workflows/test.yml)
[![Check style](https://github.com/aas-core-works/aas-package3-typescript/actions/workflows/check-style.yml/badge.svg)](https://github.com/aas-core-works/aas-package3-typescript/actions/workflows/check-style.yml)
[![Check doc](https://github.com/aas-core-works/aas-package3-typescript/actions/workflows/check-doc.yml/badge.svg)](https://github.com/aas-core-works/aas-package3-typescript/actions/workflows/check-doc.yml)
[![npm version](https://img.shields.io/npm/v/aas-package3-typescript)](https://www.npmjs.com/package/aas-package3-typescript)
[![Coverage Status](https://coveralls.io/repos/github/aas-core-works/aas-package3-typescript/badge.svg?branch=main)](https://coveralls.io/github/aas-core-works/aas-package3-typescript?branch=main)

Aas-package3-typescript is a library for reading and writing packaged file format of an [Asset Administration Shell (AAS)] in TypeScript.

[Asset Administration Shell (AAS)]: https://www.plattform-i40.de/PI40/Redaktion/DE/Downloads/Publikation/Details_of_the_Asset_Administration_Shell_Part1_V3.html

## Status

The library is thoroughly tested and meant to be used in production.

The library is written in TypeScript and supports Node.js as well as browser/in-memory use cases. Node 20 or later is required for path-based APIs.

## Documentation

The full documentation is available at [doc/index.md](doc/index.md).

### Teaser

Here are short snippets to demonstrate how you can use the library.

To create and write to a package:

```ts
import { NewPackaging } from 'aas-package3-typescript';

const packaging = NewPackaging();

const specContent = new TextEncoder().encode('{"aas": "..."}');
const thumbnailContent = new Uint8Array([/* PNG bytes */]);
const supplementaryContent = new Uint8Array([/* PDF bytes */]);

const pkg = await packaging.Create('/path/to/some/file.aasx');
try {
    const spec = await pkg.PutPart(
        new URL('https://package.local/aasx/some-company/data.json'),
        'application/json',
        specContent
    );
    await pkg.MakeSpec(spec);

    const thumb = await pkg.PutPart(
        new URL('https://package.local/some-thumbnail.png'),
        'image/png',
        thumbnailContent
    );
    await pkg.SetThumbnail(thumb);

    const suppl = await pkg.PutPart(
        new URL('https://package.local/aasx-suppl/some-company/some-manual.pdf'),
        'application/pdf',
        supplementaryContent
    );
    await pkg.RelateSupplementaryToSpec(suppl, spec);

    await pkg.Flush();
} finally {
    pkg.Close();
}
```

To read from the package:

```ts
import { NewPackaging } from 'aas-package3-typescript';

const packaging = NewPackaging();

const pkg = await packaging.OpenRead('/path/to/some/file.aasx');
try {
    const specsByContentType = await pkg.SpecsByContentType();
    const jsonSpecs = specsByContentType['application/json'];
    if (jsonSpecs && jsonSpecs.length > 0) {
        const spec = jsonSpecs[0];
        const specContent = spec.ReadAllBytes();
        // Do something with the spec content.
    }

    const thumbnail = await pkg.Thumbnail();
    if (thumbnail !== null) {
        const thumbnailContent = thumbnail.ReadAllBytes();
        // Do something with the thumbnail content.
    }

    const suppl = await pkg.MustPart(
        new URL('https://package.local/aasx-suppl/some-company/some-manual.pdf')
    );
    const supplementaryContent = suppl.ReadAllBytes();
    // Do something with the supplementary content.
} finally {
    pkg.Close();
}
```

Please see the full documentation at [doc/index.md](doc/index.md) for more details.

## Installation

```bash
npm install aas-package3-typescript
```

## API Overview

### Types

| Type | Description |
|------|-------------|
| `Packaging` | Factory for opening and creating AASX packages |
| `PackageRead` | Read-only access to an AASX package |
| `PackageReadWrite` | Read and write access to an AASX package |
| `Part` | Represents a part within an AASX package |

### Packaging Methods

| Method | Description |
|--------|-------------|
| `Create(path)` | Create a new AASX package at the given path |
| `CreateInStream(stream)` | Create a new AASX package in a stream |
| `OpenRead(path)` | Open an AASX package for reading |
| `OpenReadFromStream(stream)` | Open an AASX package from a stream for reading |
| `OpenReadFromBytes(bytes)` | Open an AASX package from bytes for reading |
| `OpenReadWrite(path)` | Open an AASX package for read/write |
| `OpenReadWriteFromStream(stream)` | Open an AASX package from a stream for read/write |
| `OpenReadWriteFromBytes(bytes)` | Open an AASX package from bytes for read/write |

### PackageRead Methods

| Method | Description |
|--------|-------------|
| `Specs()` | List all AAS spec parts |
| `SpecsByContentType()` | List specs grouped by MIME type |
| `IsSpec(part)` | Check if a part is a spec |
| `SupplementariesFor(spec)` | List supplementary parts for a spec |
| `SupplementaryRelationships()` | List all supplementary relationships |
| `FindPart(uri)` | Find a part by URI (returns null if not found) |
| `MustPart(uri)` | Get a part by URI (throws if not found) |
| `Thumbnail()` | Get the package thumbnail |
| `Close()` | Close the package |

### PackageReadWrite Methods

Inherits all `PackageRead` methods, plus:

| Method | Description |
|--------|-------------|
| `PutPart(uri, contentType, content)` | Write a part to the package |
| `PutPartFromStream(uri, contentType, stream)` | Write a part from a stream |
| `DeletePart(part)` | Remove a part from the package |
| `MakeSpec(part)` | Mark a part as a spec |
| `UnmakeSpec(part)` | Remove spec relationship |
| `RelateSupplementaryToSpec(supplementary, spec)` | Create supplementary relationship |
| `UnrelateSupplementaryFromSpec(supplementary, spec)` | Remove supplementary relationship |
| `SetThumbnail(part)` | Set the package thumbnail |
| `UnsetThumbnail()` | Remove the package thumbnail |
| `Flush()` | Write pending changes |

## Versioning

The name of the library indicates the supported version of the [Asset Administration Shell (AAS)].

In case of `aas-package3-typescript`, this means that Version 3 of the [Asset Administration Shell (AAS)] is supported.

We follow [Semantic Versioning] to version the library.
The version X.Y.Z indicates:

[Semantic Versioning]: http://semver.org/spec/v1.0.0.html

* X is the major version (backward-incompatible),
* Y is the minor version (backward-compatible), and
* Z is the patch version (backward-compatible bug fix).

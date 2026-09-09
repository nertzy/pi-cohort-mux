# pi-cohort prerelease pin: temporary immutable Git commit dependency

## Status

Active — pin will be replaced once the SPI lands in a published npm release.

## Decision

`pi-cohort-mux` pins `pi-cohort` at an exact immutable Git commit on the
`nertzy/pi-cohort` fork rather than a semver range or the published npm version:

```jsonc
{
  "dependencies": {
    "pi-cohort": "git+https://github.com/nertzy/pi-cohort.git#84eb447af4ee2c2c1fbda97ca6e14ee1aa35d5a9"
  }
}
```

Full commit SHA: `84eb447af4ee2c2c1fbda97ca6e14ee1aa35d5a9`  
Branch: `mux-execution-core`  
Upstream PR: https://github.com/jjuraszek/pi-cohort/pull/15

## Why the pin is necessary

The published `pi-cohort@6.0.1` on the npm registry does not include the
execution-backend SPI (`/execution-backend`, `/execution-backend-testkit` export
subpaths, `registry.ts`, `reload.ts`, `testkit.ts`). Those exports were
introduced in the `mux-execution-core` branch and have not yet been merged or
released upstream.

A `>=6.0.1` semver range would resolve to the published package, which lacks the
required exports and would break all tests at import time. A local tarball
dependency (e.g. `file:/tmp/pi-cohort-*.tgz`) would be non-reproducible across
machines and sessions.

Pinning the exact commit on the public `nertzy/pi-cohort` fork gives:
- **Reproducibility**: the same commit SHA always resolves to the same code.
- **Immutability**: a commit SHA on a public GitHub fork cannot be force-pushed
  without creating a new SHA.
- **No local path or tarball**: the dependency is resolvable from any machine
  with HTTPS network access; no GitHub SSH credentials are required.
- **Private package preserved**: `pi-cohort-mux` remains `private: true`; the
  pin does not change the publish posture.

## Dependency classification

The tests import `jiti` directly (`import { createJiti } from "jiti"` in
`test/public-registry.test.mjs` and `test/execution-backend-public-conformance.test.mjs`).
Although `jiti` is also a transitive dependency of `pi-cohort`, relying on a
transitive dependency is fragile. `jiti` is declared explicitly as a
`devDependency` (`^2.7.0`).

`typebox` is used only internally by `pi-cohort`'s TypeScript sources and is
never imported directly in `pi-cohort-mux`. It arrives as a transitive
dependency and is intentionally **not** declared as a direct dependency here.

## Installation

```sh
npm ci --allow-git root
```

`--allow-git root` permits the root package's declared Git dependency under
npm 12 without allowing additional transitive Git dependencies. The lockfile
pins the HTTPS URL and commit; the install command supplies the permission.

## When to remove this pin

Replace this pin with a published semver range once:

1. The upstream PR #15 (`mux-execution-core`) is merged into `jjuraszek/pi-cohort`.
2. A new version is published to the npm registry that includes the
   `/execution-backend` and `/execution-backend-testkit` export subpaths.

At that point replace the entry with the appropriate semver lower bound
(e.g. `^6.1.0`) and delete this document.

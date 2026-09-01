# Quukk Single-Entry Resumable Beta Release Design

## Purpose

Quukk ClawMessenger must feel like one npm product to end users even though its native runtime is built for six operating-system and CPU combinations. Users install, upgrade, invoke, and remove only `quukk-clawmessenger`; the platform runtime packages remain public npm implementation details selected automatically by npm.

The release process must also be safe for maintainers. One protected GitHub Actions dispatch publishes the complete beta release set, and rerunning that dispatch after an interrupted or partially successful publication must resume safely.

## Package architecture

The package topology remains:

- `quukk-clawmessenger`: the only user-facing entry package and CLI.
- `@quukk/clawmessenger-runtime-win32-x64`
- `@quukk/clawmessenger-runtime-win32-arm64`
- `@quukk/clawmessenger-runtime-darwin-x64`
- `@quukk/clawmessenger-runtime-darwin-arm64`
- `@quukk/clawmessenger-runtime-linux-x64`
- `@quukk/clawmessenger-runtime-linux-arm64`

The entry package declares the six runtime packages as exact-version `optionalDependencies`. Each runtime package declares its npm `os` and `cpu` constraints. npm therefore installs only the compatible runtime while the application verifies package version, manifest version, binary name, and SHA-256 before execution.

The six runtime packages must not be presented as separate installation choices in end-user documentation. The canonical beta installation command is:

```bash
npm install --global quukk-clawmessenger@beta
```

## Why the binaries remain split

The verified `0.1.0-beta.3` artifacts total 38.72 MiB compressed, while one platform runtime is approximately 5.97–6.81 MiB and the entry package is 0.33 MiB. Combining every binary into one tarball would make every installation download binaries for five unusable targets. A postinstall downloader would keep one registry entry but introduce a second network origin, proxy and offline failures, and a more security-sensitive installation script.

Platform packages therefore remain the smallest and most reliable delivery mechanism. Their multiplicity is a maintainer concern, not part of the user interface.

## Release workflow

The existing protected `workflow_dispatch` remains the only publication entry point. Ordinary pushes and pull requests build and verify artifacts but cannot publish.

One dispatch performs these stages:

1. Run runtime contracts and entry-package tests.
2. Build and attest the entry tarball and all six runtime tarballs.
3. Validate that the seven tarballs have the exact expected names and one shared semantic version, and that the entry tarball pins all six runtime packages to that exact version.
4. Query npm for each exact `name@version`.
5. For a missing package, mark it for publication.
6. For an existing package, compare the registry tarball digest with the locally built tarball. Skip it only when the content is identical; fail closed on any mismatch or ambiguous registry response.
7. Publish missing runtime packages first.
8. Recheck all six runtime packages and publish the entry package last.
9. If the entry package already exists, require all six matching runtimes to exist; otherwise fail because the public release set is inconsistent.

The workflow uses the protected `npm-runtime-prerelease` environment, serializes releases with the existing concurrency group, and exposes npm credentials only to the publish job. GitHub Actions publication retains npm provenance. The required granular token is stored only as the environment secret `NPM_TOKEN`; it is never copied into the repository, logs, or local npm configuration.

## Safe retry behavior

npm versions are immutable, so a seven-package release cannot be a truly atomic registry transaction. Safe retry is the practical substitute.

A retry after interruption handles these states:

- Nothing published: publish six runtimes, then the entry.
- Some runtimes published with matching digests: skip those, publish the missing runtimes, verify all six, then publish the entry.
- All runtimes published but entry missing: verify the runtimes, then publish the entry.
- All seven packages published with matching digests: report a no-op success.
- Any existing package has different content: fail before further publication.
- Entry exists while a runtime is missing or mismatched: fail and report the inconsistent release set.
- npm cannot prove whether a version exists: fail closed.

## User-facing documentation

The entry README is the canonical npm documentation. It describes only installation and use of `quukk-clawmessenger`, with one short troubleshooting note explaining that the matching native runtime is installed automatically. Runtime package READMEs remain minimal implementation metadata and point users back to the entry package.

## Testing

Workflow contract tests execute the release-state classifier against hand-written registry fixtures and verify observable outputs: publish, skip, complete no-op, and fail-closed states. YAML workflow tests verify that publication remains protected, credentials remain publish-job-only, runtimes precede the entry, and the registry is rechecked before the entry publish.

Package tests continue to cover platform selection, exact version matching, manifest validation, and binary hashing. Final verification includes the focused tests, YAML parsing, tarball audits, a clean-profile installation from the published beta tag on this Windows x64 machine, CLI setup/start, runtime resolution, and uninstall cleanup.

## Out of scope

- Combining all native binaries into the entry tarball.
- Downloading runtime binaries from GitHub Releases during postinstall.
- Renaming the existing packages or changing the supported platform matrix.
- Making the npm registry transaction atomic, which npm does not support across packages.

# Daemon Identity First-Start Design

## Problem

The public `quukk-clawmessenger@0.1.0-beta.2` package installs and resolves its bundled runtime, but a clean profile cannot start the CLI service. `createProductionCliRuntime().runForeground()` reaches `DaemonIdentityStore.claim()`, which attempts an exclusive write to `<home>/.quukk-clawmessenger/run/daemon.pid` before the `run` directory exists and reports `identity_write_failed`.

## Approved scope

- Initialize the expected identity-file parent directory during the first claim.
- Preserve exclusive `daemon.pid` creation and existing conflict, recovery, durability, and cleanup behavior.
- Validate that the directory is a real directory rather than a symbolic link, and retain restrictive Unix permissions.
- Add a real-filesystem regression test for a completely missing parent directory before changing production code.
- Publish the immutable correction as `0.1.0-beta.3` for the entry package and all six platform runtime packages.
- Verify the public release through an anonymous clean install and the real `start`, `status`, `doctor`, `logs`, and `stop` lifecycle.

## Non-goals

- Refactoring the daemon identity state machine.
- Changing the CLI protocol, service HTTP API, runtime manifest contract, or package topology.
- Automating npm credential rotation.

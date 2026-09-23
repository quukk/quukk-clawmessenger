# Quukk ClawMessenger

Quukk ClawMessenger connects local OpenCode, OpenClaw, Codex, and Hermes agents to
ClawMessenger. Install one npm package, review the agents detected on this computer, and choose
which agents to connect. Each selected runtime receives its own RongCloud identity, worker,
session store, and failure boundary.

**Built on [Multica](https://github.com/multica-ai/multica).** This is a community derivative;
the local interface retains the Multica product name, logo, copyright, and attribution alongside
the Quukk ClawMessenger label. Fork source:
[quukk/quukk-clawmessenger](https://github.com/quukk/quukk-clawmessenger).

## Install and set up

Requirements:

- Node.js 22.13 or newer.
- A supported Windows, macOS, or Linux desktop build listed below.
- At least one supported agent CLI installed and authenticated.
- A compatible ClawMessenger server deployment; Hermes has additional server prerequisites.

Install globally, then open the local setup page:

```bash
npm install -g quukk-clawmessenger@beta
quukk-clawmessenger setup
```

This is the only package users install. npm automatically selects the matching signed native
runtime for the current operating system and CPU; do not install the scoped runtime packages
directly.

For a terminal-only host, CI, or an environment where a browser must not open:

```bash
quukk-clawmessenger setup --no-open
```

A headless Linux server has no usable `xdg-open`, so a plain `setup` fails with
`browser_open_failed`. The local page is not required for pairing: print a one-time code in the
terminal instead. `pair` takes no required arguments — it reuses the configuration saved by
`setup` or the bundled default server; pass options only to override them.

```bash
# After `setup` (or with the bundled default server): no arguments needed
quukk-clawmessenger pair

# First use without `setup`, or to override the server/directories
quukk-clawmessenger pair \
  --server-url "https://YOUR-SERVER.example/YOUR-SERVICE-PREFIX" \
  --workdir "$HOME/AI-Workspace" \
  --authorized-work-root "$HOME/AI-Workspace"
```

```text
quukk-clawmessenger: pair waiting
pairing_code=ABCDEF23
expires_at=2026-09-18T12:00:00.000Z
server=https://YOUR-SERVER.example/YOUR-SERVICE-PREFIX
Enter the code in ClawMessenger under Remote devices > Add device.
```

`pair` starts the local service when it is not already running, never opens a browser, and never
prints the local page address. Re-running it keeps a live session instead of invalidating the code
you already printed; pass `--new` to discard a live session and start a fresh one. `pair --json`
emits a single machine-readable object, and `quukk-clawmessenger status --json` reports binding
progress. With no supported agent platform detected, `pair` fails with `pairing_no_candidates`
(exit code 2); run `quukk-clawmessenger rescan` first.

If you must use the local setup page, forward its port instead. The page listens only on
`127.0.0.1`, the port is chosen at random on every start, and the launch ticket lives 30 seconds, so
use this order:

**Step 1:** make sure the service is running (`pair` or `setup --no-open` starts it), then read
`service.port` from `quukk-clawmessenger doctor --json`.

**Step 2:** on a device with a browser, forward that port. The local port must match the server
port, because the service only accepts `Host: 127.0.0.1:<port>`:

```bash
ssh -L <port>:127.0.0.1:<port> <user>@<linux-host>
```

**Step 3:** on the server, place a temporary `xdg-open` wrapper so the URL can be captured, then run
`setup` again. Pass no configuration option on the second run, or it fails with
`already_running_with_overrides`:

```bash
mkdir -p "$HOME/bin"
cat > "$HOME/bin/xdg-open" <<'EOF'
#!/bin/sh
echo "$1" > "$HOME/setup-url.txt"
EOF
chmod +x "$HOME/bin/xdg-open"

PATH="$HOME/bin:$PATH" quukk-clawmessenger setup
cat "$HOME/setup-url.txt"
```

**Step 4:** open the printed `http://127.0.0.1:<port>/setup#ticket=...` URL on the browser device
within 30 seconds. The launch ticket is short-lived, and the port and the ticket must both be used
unchanged.

Delete `$HOME/bin/xdg-open` and `$HOME/setup-url.txt` afterwards. The Linux autostart entry is an
XDG `.desktop` file under `$XDG_CONFIG_HOME/autostart/` and does nothing without a desktop session;
run `quukk-clawmessenger start --foreground --no-open` under a supervisor such as `systemd` instead.

The npm `postinstall` hook only launches setup for a global install in an interactive desktop
session. It does not register an agent, wait for input, or download an executable. CI, local
installs, non-desktop sessions, and `QUUKK_CLAWMESSENGER_NO_OPEN=1` receive only a setup hint.
Run `setup` explicitly whenever lifecycle scripts are disabled.

Before upgrading a beta installation, stop the authenticated old daemon so the package manager
does not reuse or try to replace a running Bridge binary:

```bash
quukk-clawmessenger stop
npm install -g quukk-clawmessenger@beta
quukk-clawmessenger setup
```

The local service listens only on `127.0.0.1`. Registration starts only after the user reviews
the detected runtimes and explicitly submits a selection.

## Cloud registration and data disclosure

Before a selected runtime can be registered, setup shows the configured service URL and requires
a separate confirmation. Registration sends that service a hostname-derived node label, a
network-interface MAC address when available (or a stable install-derived fallback), the selected
provider and capability flags, and a runtime-scoped enrollment proof. Each enabled runtime then
uses its own RongCloud connection; its ClawMessenger chat and task messages traverse that cloud IM
service.

This beta has no self-service remote identity deletion. Removing a local binding or uninstalling
the npm package does not delete its server or RongCloud identity. Before enabling a hosted service,
obtain its operator contact, privacy terms, retention policy, and deletion process. Publication of
the default hosted service remains blocked until those items and the data-processing review are
complete.

## Agent login prerequisites

Quukk ClawMessenger does not install, upgrade, or sign in to any agent CLI. Complete the
provider's own installation and authentication flow first, then run `rescan`:

| Provider | Local prerequisite |
| --- | --- |
| OpenCode | `opencode` is runnable and its model/provider credentials are configured. |
| OpenClaw | `openclaw` is runnable and its gateway/model authentication is configured. |
| Codex | `codex` is runnable and signed in with the intended OpenAI account or API environment. |
| Hermes | `hermes` is runnable and its selected model provider is authenticated. |

Detection reports whether a CLI is runnable; it does not prove that every model credential is
valid. A clear authentication failure from the first task changes that runtime to `needs_auth`.
Sign in with the provider's CLI, then rescan.

OpenClaw chat streaming requires a running, token-authenticated local Gateway using
protocol 4 (verified with OpenClaw 2026.9.2). Configure the intended Gateway through
OpenClaw's normal setup and run `openclaw gateway run`; the bridge does not start it
or change its authentication. The adapter connects only to a numeric loopback address,
reads the existing token in memory, and requests `operator.read`/`operator.write`.
Do not include tokens in prompts, command examples, or diagnostics.

Existing CLI session UUIDs are resolved through the Gateway and resumed without
resetting history; new conversations receive isolated session keys. The selected
OpenClaw agent retains its configured model, tools, permissions and workspace.
Stopping targets the exact run ID and checks that run's active-state removal before
reporting cancellation. A failed confirmation is reported as `stop_unconfirmed`,
with partial text and the session retained for recovery.

This streaming adapter accepts plain JSON local token configuration (including
`OPENCLAW_CONFIG_PATH`, local port overrides, and an explicit loopback
`OPENCLAW_GATEWAY_URL` with its explicit environment token). Remote Gateways,
JSON5/includes, named profiles, SecretRef/interpolated credentials, TLS/password
authentication, custom launch prefixes, per-session MCP, service tiers and explicit
local CLI mode fail before prompt submission. Custom arguments support `--agent`
and `--thinking`; configure other settings through OpenClaw. Non-streaming callers
retain the existing CLI adapter.

## CLI reference

| Command | Purpose |
| --- | --- |
| `quukk-clawmessenger setup` | Start the local service and open the setup page. |
| `quukk-clawmessenger pair` | Print a one-time pairing code; add `--new` to restart a live session. |
| `quukk-clawmessenger start` | Start the local service; add `--foreground` to keep it attached. |
| `quukk-clawmessenger stop` | Gracefully stop verified workers and the local service. |
| `quukk-clawmessenger status` | Show whether the verified local service is ready. |
| `quukk-clawmessenger logs` | Read bounded local logs; supports `--lines 1..1000` and `--follow`. |
| `quukk-clawmessenger doctor` | Show redacted local diagnostics; use `--json` for automation. |
| `quukk-clawmessenger rescan` | Re-run local detection for all four providers. |

`setup` and `start` accept `--no-open`, `--server-url`, `--workdir`, repeated
`--authorized-work-root`, four provider-specific `--*-path` overrides, and `--log-level`.
`status`, `doctor`, and `rescan` accept `--json`. Run `quukk-clawmessenger --help` for the exact
validated option syntax.

## Headless permission policy

Quukk's local authorization boundary is deny-by-default:

- `authorizedWorkRoots` starts empty. A remote task is rejected until a real local directory is
  explicitly authorized and the default work directory is inside an authorized root.
- v1 advertises `approval_events: false`. A CardKit permission action is parsed for compatibility
  but cannot grant permission or resume a paused provider approval.
- Quukk does not turn a chat message into arbitrary shell execution. Only the documented message
  and device-control allowlists are accepted.

The four provider adapters run headlessly and may apply their own non-interactive policy. Review
the selected CLI's configuration before connecting it. If a provider requires an interactive
approval that its headless adapter cannot safely resolve, the operation is denied or fails; the
ClawMessenger client is not treated as an approval authority.

## Configuration and local data

Quukk keeps its data separate from Multica and the legacy single-provider bridges:

| Data | Unix/macOS | Windows |
| --- | --- | --- |
| Root | `$HOME/.quukk-clawmessenger/` | `%USERPROFILE%\.quukk-clawmessenger\` |
| Settings | `config.json` | `config.json` |
| Protected credentials | `credentials.json` | `credentials.json` |
| Runtime bindings | `state.json` | `state.json` |
| Sessions | `sessions.json` | `sessions.json` |
| Redacted log | `logs/bridge.log` | `logs\bridge.log` |
| Process identity | `run/bridge.pid`, `run/daemon.pid` | `run\bridge.pid`, `run\daemon.pid` |
| RongCloud SDK state | `rongcloud/<runtimeId>/` | `rongcloud\<runtimeId>\` |

Configuration precedence is CLI options, then `QUUKK_CLAWMESSENGER_*` environment variables,
then `config.json`, then built-in defaults. The built-in server URL follows the release channel: a
version with a prerelease suffix (such as `1.2.3-beta.1`) defaults to the test environment
`https://newsradar.dreamdt.cn/im-test`, while a plain version (such as `1.2.3`) defaults to
`https://newsradar.dreamdt.cn/im`. A `config.json` that still stores the other channel's default is
read as the running channel's default; any other explicit server URL is kept unchanged.
`config.json` never stores RongCloud tokens or the per-install Bridge secret.

## Legacy migration in this beta

The beta CLI and setup page do not automatically inspect or import an older OpenCode
ClawMessenger installation. Enter the non-secret server, work-directory, authorized-root, and
provider-path settings again in Quukk setup, then select and register each runtime to obtain its
new isolated identity.

Legacy files are never moved, changed, or deleted. Do not copy legacy node IDs, MAC-derived
identities, AppKey/AppSecret values, passwords, tokens, bindings, sessions, or logs into Quukk
configuration. Automated, explicitly confirmed migration remains disabled until it has a complete
authenticated setup UI path.

## Diagnostics and recovery

- Start with `quukk-clawmessenger status --json` and `quukk-clawmessenger doctor --json`.
- Use `quukk-clawmessenger logs --lines 100`; logs and diagnostics redact credentials, tickets,
  prompts, environment variables, and provider paths.
- `probe_failed` is a bounded detection failure, not proof that a CLI is absent. Fix the CLI or
  path override and run `rescan`.
- Registration and worker failures are isolated per runtime. Re-register only the affected row.
- A config/state recovery warning is fail-closed. Preserve the files before changing anything,
  then follow the diagnostic code rather than copying credentials into ordinary config.

## Uninstall

Stop the verified service before removing the package:

```bash
quukk-clawmessenger stop
npm uninstall -g quukk-clawmessenger
```

Uninstall does not silently delete `~/.quukk-clawmessenger` (or the Windows equivalent). That
directory contains local identity and session data. Remove it manually only when permanent local
identity/session loss is intended. Remote RongCloud identities are not implicitly deleted by
uninstalling the local package.

## Supported platforms

| Operating system | x64 | arm64 | Notes |
| --- | --- | --- | --- |
| Windows | Supported | Supported | Native platform package; user ACL protects local credentials. |
| macOS | Supported | Supported | Native platform package. |
| Linux (glibc) | Supported | Supported | Desktop auto-open requires `DISPLAY` or `WAYLAND_DISPLAY`. |

Unsupported OS/architecture pairs fail with a repair message. The package never falls back to an
unverified postinstall download.

## Server prerequisite for Hermes and production use

Deploy the matching ClawMessenger server changes before enabling this client. The server must:

- accept `hermes` as its own node type;
- enforce strict, single-node enrollment proof ownership and shared-edge rate limits;
- retire anonymous token routes and redact public responses, errors, and logs;
- enforce node/owner authorization on OM, SaaS, configuration, and download routes; and
- have an approved rotation or revocation disposition for any credential exposed by an older
  deployment.

Compatibility enrollment mode is only a migration window and must be off before npm publication.
The local package cannot make an incompatible or undeployed server safe.

## Packaging checks for maintainers

From a source checkout, copy the exact four root legal files into the entry package and the exact
root `LICENSE`, `NOTICE`, `MODIFICATIONS.md`, and `GO_THIRD_PARTY_NOTICES.md` into each
binary-only platform staging package. Build the Node package and Bridge UI, generate
`npm pack --dry-run --json` output, then pass that report and package directory to
`scripts/audit-tarball.mjs`. Each platform package also requires its generated `SOURCE.md` and a
manifest containing the exact linked Go module list. The audit rejects missing legal/module/UI/
worker/manifest files, unexpected files, source maps, symlinks, traversal, credential-like
literals, and developer-specific absolute paths. It reports only fixed error codes.

Publishing remains a separate protected action. Do not publish until the server, six-platform
matrix, clean-install smoke tests, npm ownership/2FA, and legal review gates all pass.

## License and attribution

This derivative is distributed under the complete [Multica License](LICENSE), including its
additional conditions. The package also carries the unchanged Multica [NOTICE](NOTICE), the fork
[modification record](MODIFICATIONS.md), and [third-party notices](THIRD_PARTY_NOTICES.md).
Platform runtime packages additionally carry the checksum-traced Go dependency notices in
`GO_THIRD_PARTY_NOTICES.md`.

The Multica License restricts hosted service use for third parties and commercial embedding or
distribution unless the producer grants the required commercial license. A branding waiver is a
separate grant. This project does not claim either grant. Review the complete license and obtain
independent legal advice for the intended use.

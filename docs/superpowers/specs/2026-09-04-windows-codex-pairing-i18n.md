# Windows Codex Discovery, Pairing Diagnostics, and Bridge Localization

## Goal

Make the packaged local bridge discover the executable Codex agent installed by the ChatGPT Windows client, explain pairing failures accurately, and present the complete local bridge UI in Simplified Chinese by default with a persistent English switch.

## Approved behavior

- Detect only an executable Codex agent. Never execute the ChatGPT GUI as an agent runtime.
- On Windows, search `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe` after explicit configuration and PATH lookup fail. Preserve the existing macOS bundle and Linux/PATH discovery behavior.
- Probe any discovered executable before advertising it as ready.
- Keep TLS certificate verification enabled.
- Preserve normal dual-stack networking. When the server cannot be reached because an advertised IPv6 route stalls, retry the pairing request through an IPv4-only transport.
- Report actionable causes separately: local session, unsupported server pairing API, server unavailable, and malformed response.
- The pairing v2 endpoint remains mandatory because the product requires both an eight-character pairing code and a QR code. Do not silently downgrade to the legacy endpoint.
- Default the local bridge UI to Simplified Chinese. Let the user switch to English and persist the explicit selection in local storage.
- Translate every visible bridge page and component so the interface never mixes languages.
- Preserve Windows, macOS, and Linux support and existing security boundaries.

## Known deployment finding

On 2026-09-04, both `/im/api/ai/pairing/v2/sessions` and `/im-test/api/ai/pairing/v2/sessions` returned HTTP 404 with `接口不存在`. The repository contains the v2 route, so the test deployment must be refreshed before a real end-to-end pairing session can succeed.

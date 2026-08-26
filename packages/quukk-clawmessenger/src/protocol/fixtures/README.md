# Task 8 protocol fixture provenance

All fixtures in this directory are offline protocol data. They contain no credentials, live SDK output, or OpenCode source. OpenCode behavior was observed for compatibility only; no OpenCode fixture, test, comment, text, or implementation was copied.

## `rongcloud-content-shapes.json`

- Source repository: https://github.com/quukk/codex-clawmessenger
- Pinned commit: `3f3a2e4d6a8cb143a0088350aed2e1b4d1675473`
- `src/rongcloud/client.ts`: Git blob SHA-1 `591f4e7f74525d84c5af0e71edabef27ff1e7319`; source SHA-256 `538eaf5e88ff6ba866232a53066f45d7910832457d102082e4271d2ad853d201`
- `test/rongcloud-client.test.mjs`: Git blob SHA-1 `73b04c27303e438cb53d6b957f711357885b91e7`; source SHA-256 `e755f8b6885c8da1263e73fb78de72b689308458aca1b92623140a690c2db3ae`
- Local fixture SHA-256: `8f87544663c8112e5b6ed225c4f4337f0261476e0a04ab1033bc9dba716ec002`
- Adaptation: manually reduced to provider-neutral plain/object/JSON/one-layer content shapes, numeric conversation type, bounded attachments, and detached allowlisted `rawContent`. Identifiers and prose are new.

## `discussion-v1.valid.json` and `discussion-v1.invalid.json`

- Source repository: https://github.com/quukk/clawmessenger
- Pinned commit: `a50f2393213f6f1c42da139491d2fe20937e7c7a`
- `src/discussion/protocol.ts`: Git blob SHA-1 `d4e372a50b94d376e3332ed831cc4974920ee6da`; source SHA-256 `8ec8e0be917a083ece90b62c1977d751465bccd947b007d437e37ff031fa6d78`
- `src/discussion/turn-decider.ts`: Git blob SHA-1 `a53b72ba9507a746ec5da65cae5bad2c97a565ec`; source SHA-256 `05bb0b95a4be2162d9610b712dd6a96189798018e84528203e34105f50276f46`
- Local fixture SHA-256: valid `44eede3e8a4fb7c3242eb576894e9a5d9f47759c4ca13dd435aba820466a668b`; invalid `ef21a53e312c61e0c8e17d314f7b6529f7f5911cd8a4621cf7549c130e6656d7`
- Adaptation: manually constructed deterministic IDs and timestamps; split positive and strict exact-key/boundary negatives; excluded coordinator state, timers, random IDs, and transport behavior.

## `discussion-v2.shared.json`

- Primary source repository: https://github.com/quukk/codex-clawmessenger
- Pinned commit: `3f3a2e4d6a8cb143a0088350aed2e1b4d1675473`
- `test/fixtures/discussion_v2_messages.json`: Git blob SHA-1 `9ccf1f404fbf9e3a3fcc29f08316043832cd0d93`; source SHA-256 `96950ede1c5522d085d63d702ef76ea2161f2c91507cde2e371875785f5dfc4d`
- `src/core/discussion-v2.ts`: Git blob SHA-1 `b0cfa84461544f84a2634dda7d2dc8886919785c`; source SHA-256 `92e0e55b5605b4a6d1e3fba3fe0648556609ee7f92b435dd5f524f24ea2835db`
- Cross-check source repository: https://github.com/quukk/clawmessenger at commit `a50f2393213f6f1c42da139491d2fe20937e7c7a`
- `src/discussion/v2-protocol.ts`: Git blob SHA-1 `3170542dc9a681470252f897a6ff95399d3dca75`; source SHA-256 `67d1ca5139d293ac7f61ac55f4c07020ea829269a37d7947667d0209b63c935f`
- Local fixture SHA-256: `a4f167f87f5f18c75c9dc474376d905fa3a8a5e647406b48ca4945d4ff23a0fc`
- Adaptation: manually rewritten identifiers, English text, and ordering; retained exact camelCase input names and current strict unions. Legacy finish payloads containing full artifact content were intentionally omitted in favor of the current reference-only finish contract.

## `discussion-wire-cross-runtime.json`

- Source repository: https://github.com/quukk/codex-clawmessenger
- Pinned commit: `3f3a2e4d6a8cb143a0088350aed2e1b4d1675473`
- Source path: `test/fixtures/discussion_wire_cross_runtime.json`
- Git blob SHA-1: `79155a50592f113496ae9b5da16c18d2405d581f`
- Source and local fixture SHA-256: `710b46e02c5797dee61bd8387edc5e59c5c30b41e76687e802b19532f0cfe027`
- Adaptation: none; copied byte-for-byte under MIT to preserve deterministic cross-runtime Base64 and SHA-256 evidence.

## `cardkit-wire.json`

- Source repository: https://github.com/quukk/clawmessenger
- Pinned commit: `a50f2393213f6f1c42da139491d2fe20937e7c7a`
- `src/cardkit/schema.ts`: Git blob SHA-1 `33900f70684573574c1cbbd9434af1e77565fe8b`; source SHA-256 `517c43105b64d4adccbc142cb21fbba54e0e9528fc95104d7c7b49961e4a1575`
- `src/cardkit/builders.ts`: Git blob SHA-1 `d9580ab789c5f398a099079bdcd03dd5039d2c03`; source SHA-256 `0eb41205338685276e9151a98c9139060c6af5538f41c1b6ec80fc28ef254a87`
- `src/cardkit/templates.ts`: Git blob SHA-1 `ea6d26761cd4b5f1a94eb5fcc8e58ea6d7b5b1e5`; source SHA-256 `151aa52f927cb0cf424be44731808c227cccd83c2c0679e6a18fffb99da2eb95`
- Local fixture SHA-256: `7f5a1c477456ab31ed94338cc180c2e4874b86a0d5fb61d493ab691118aee0ba`
- Adaptation: manually composed exact `card_message`, `card_update`, `card_action`, and nested `command_result` envelopes with explicit IDs/timestamps. Permission completion is hardened to fixed code 501, reference card ID preservation, and no allow/deny buttons. No upstream action-router code was used.

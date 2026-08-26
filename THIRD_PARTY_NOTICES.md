# Third-Party Notices

## Multica

This fork retains the complete upstream Multica `LICENSE` and `NOTICE` without modification. Multica source and licensing material: https://github.com/multica-ai/multica

## Codex ClawMessenger

This product includes adaptations from Codex ClawMessenger, pinned to commit `3f3a2e4d6a8cb143a0088350aed2e1b4d1675473`.

Source repository: https://github.com/quukk/codex-clawmessenger
Source package: https://www.npmjs.com/package/@quukk/codex-clawmessenger

Adapted local files include the provider-neutral message contracts, discussion v2 contracts, discussion wire codec, CardKit schema/builders/validator, and the byte-for-byte discussion wire fixture. Exact per-file and fixture provenance is recorded in source headers and `packages/quukk-clawmessenger/src/protocol/fixtures/README.md`.

MIT License

Copyright (c) 2026 Quukk

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## OpenClaw ClawMessenger

This product includes adaptations from OpenClaw ClawMessenger, pinned to commit `a50f2393213f6f1c42da139491d2fe20937e7c7a`.

Source repository: https://github.com/quukk/clawmessenger
Source package: https://www.npmjs.com/package/claw_messenger

Adapted local files include discussion v1/v2 contracts, the discussion wire codec, CardKit schema/builders/validator/marker/templates, and manually adapted fixtures. `src/cardkit/action-router.ts` is a new provider-neutral implementation based only on the public MIT CardAction schema and this project's contract; no upstream action-router implementation was copied. Exact mappings are recorded in source headers and the fixture provenance README.

MIT License

Copyright (c) 2024 quukk

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## RongCloud JavaScript SDK

This product includes `@rongcloud/imlib-next` version `5.36.6` and its exact peer `@rongcloud/engine` version `5.36.6`.

- Source packages: https://www.npmjs.com/package/@rongcloud/imlib-next and https://www.npmjs.com/package/@rongcloud/engine
- RongCloud documentation: https://docs.rongcloud.io/
- `@rongcloud/imlib-next@5.36.6` integrity: `sha512-pxDUC5CXhFLMrWLhhq3Hj1L+lHTmuBeGiVycV5yFVmh4Y/9N0SQ2GO7bXw5UZN4OdUpKRJa8jFHeLvD/ZnFt5w==`
- `@rongcloud/engine@5.36.6` integrity: `sha512-iG78XP6zFx1Olygw3xtmtYJ8h2uNH51Sqxs+6Ir07nH49pZH2nsQ762kPYsgWs7iDMTde+WBQqNc1scfj7xTJg==`

The npm registry metadata for both packages declares `LGPL 2.1`, while the `LICENSE` file embedded in each tarball contains the identical permission notice reproduced verbatim below. This discrepancy is unresolved. It must be reviewed at the Task 14 legal gate and is not represented here as a resolved licensing conclusion.

Copyright (c) 2016 RongCloud.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { forwardRef } from 'react';
import { describe, expect, it } from 'vitest';

import { resolveQrCodeComponent } from './qr-code-component';

const Component = forwardRef<SVGSVGElement>(() => null);

describe('resolveQrCodeComponent', () => {
  it('unwraps the CommonJS namespace emitted by react-qr-code in production builds', () => {
    expect(
      resolveQrCodeComponent({
        __esModule: true,
        default: { QRCode: Component, default: Component },
        QRCode: Component,
      }),
    ).toBe(Component);
  });

  it('accepts a directly imported component', () => {
    expect(resolveQrCodeComponent(Component)).toBe(Component);
  });
});

import type { ElementType } from 'react';
import type { QRCodeProps } from 'react-qr-code';

type ModuleRecord = {
  default?: unknown;
  QRCode?: unknown;
};

export function resolveQrCodeComponent(moduleValue: unknown): ElementType<QRCodeProps> {
  const moduleRecord = moduleValue as ModuleRecord;
  const defaultRecord = moduleRecord.default as ModuleRecord | undefined;
  return (moduleRecord.QRCode ??
    defaultRecord?.QRCode ??
    moduleRecord.default ??
    moduleValue) as ElementType<QRCodeProps>;
}

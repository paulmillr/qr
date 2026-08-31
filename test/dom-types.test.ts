// Compile-time-only checks: no runtime tests. `npx tsc` (lint) verifies these
// option shapes typecheck; the file is intentionally absent from test/index.ts.
import type { QRCanvasOpts } from '../src/dom.ts';

const textDecoderWithEci: Partial<QRCanvasOpts> = {
  textDecoder: (bytes, eci) => new TextDecoder().decode(bytes) + (eci?.toString() || ''),
};
const textDecoderWithoutEci: Partial<QRCanvasOpts> = {
  textDecoder: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
};

void textDecoderWithEci;
void textDecoderWithoutEci;

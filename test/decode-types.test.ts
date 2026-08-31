// Compile-time-only checks: no runtime tests. `npx tsc` (lint) verifies these
// option shapes typecheck; the file is intentionally absent from test/index.ts.
import type { DecodeOpts } from '../src/decode.ts';

const textDecoderWithEci: DecodeOpts = {
  textDecoder: (bytes, eci) => new TextDecoder().decode(bytes) + (eci?.toString() || ''),
};
const textDecoderWithoutEci: DecodeOpts = {
  textDecoder: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
};

void textDecoderWithEci;
void textDecoderWithoutEci;

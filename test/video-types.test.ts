// Compile-time-only checks: no runtime tests. `npx tsc` (lint) verifies the
// video encoders are callable without an options argument; the file is
// intentionally absent from test/index.ts.
import { encodeVideoFrames, encodeVideoQR } from '../src/video.ts';

encodeVideoFrames(Uint8Array.of(1)).return();
encodeVideoQR(Uint8Array.of(1), 'raw').return();

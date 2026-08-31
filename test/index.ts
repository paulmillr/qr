import { it } from '@paulmillr/jsbt/test.js';

// Should be first to catch obvious things
import './decode-async.test.ts';
import './decode-batch.test.ts';
import './decode.test.ts';
import './dom.test.ts';
import './encode.test.ts';
import './encrypted.test.ts';

import './gif.test.ts';
import './imgcoder/imgcoder.test.ts';
// import './jpg.test.ts';
import './png.test.ts';
import './polyfill.test.ts';
import './qr.test.ts';
import './utils.test.ts';
import './video.test.ts';

it.run();

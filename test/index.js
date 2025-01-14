import { should } from 'micro-should';

// Should be first to catch obvious things
import './bitmap.test.js';
import './utils.test.js';
import './encode.test.js';
import './decode.test.js';
import './qr.test.js';

should.run();

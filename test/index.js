import { should } from 'micro-should';

// Should be first to catch obvious things
import './bitmap.test.js';
import './decode.test.js';
import './encode.test.js';
import './qr.test.js';
import './dom.test.js';
import './utils.test.js';

should.run();

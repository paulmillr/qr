import { should } from 'micro-should';

// Should be first to catch obvious things
import './bitmap.test.ts';
import './decode.test.ts';
import './dom.test.ts';
import './encode.test.ts';
import './qr.test.ts';
import './utils.test.ts';

should.run();

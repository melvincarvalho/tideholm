// Old Wrack's brain. Identical to classic for now: its own file so that
// Old Wrack's tactics can change without touching any other bot. Override
// only what makes Old Wrack different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'old-wrack';
export const { decide } = makeBrain();

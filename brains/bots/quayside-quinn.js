// Quayside Quinn's brain. Identical to classic for now: its own file so that
// Quayside Quinn's tactics can change without touching any other bot. Override
// only what makes Quayside Quinn different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'quayside-quinn';
export const { decide } = makeBrain();

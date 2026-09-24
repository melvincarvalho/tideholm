// Kelpie's brain. Identical to classic for now: its own file so that
// Kelpie's tactics can change without touching any other bot. Override
// only what makes Kelpie different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'kelpie';
export const { decide } = makeBrain();

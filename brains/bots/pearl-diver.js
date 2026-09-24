// Pearl Diver's brain. Identical to classic for now: its own file so that
// Pearl Diver's tactics can change without touching any other bot. Override
// only what makes Pearl Diver different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'pearl-diver';
export const { decide } = makeBrain();

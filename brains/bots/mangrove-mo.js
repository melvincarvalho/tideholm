// Mangrove Mo's brain. Identical to classic for now: its own file so that
// Mangrove Mo's tactics can change without touching any other bot. Override
// only what makes Mangrove Mo different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'mangrove-mo';
export const { decide } = makeBrain();

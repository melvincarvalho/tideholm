// Osprey's brain. Identical to classic for now: its own file so that
// Osprey's tactics can change without touching any other bot. Override
// only what makes Osprey different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'osprey';
export const { decide } = makeBrain();

// Coral Kate's brain. Identical to classic for now: its own file so that
// Coral Kate's tactics can change without touching any other bot. Override
// only what makes Coral Kate different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'coral-kate';
export const { decide } = makeBrain();

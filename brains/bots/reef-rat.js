// Reef Rat's brain. Identical to classic for now: its own file so that
// Reef Rat's tactics can change without touching any other bot. Override
// only what makes Reef Rat different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'reef-rat';
export const { decide } = makeBrain();

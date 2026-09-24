// Rockpool Rosa's brain. Identical to classic for now: its own file so that
// Rockpool Rosa's tactics can change without touching any other bot. Override
// only what makes Rockpool Rosa different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'rockpool-rosa';
export const { decide } = makeBrain();

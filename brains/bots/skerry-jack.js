// Skerry Jack's brain. Identical to classic for now: its own file so that
// Skerry Jack's tactics can change without touching any other bot. Override
// only what makes Skerry Jack different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'skerry-jack';
export const { decide } = makeBrain();

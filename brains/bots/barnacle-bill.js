// Barnacle Bill's brain. Identical to classic for now: its own file so that
// Barnacle Bill's tactics can change without touching any other bot. Override
// only what makes Barnacle Bill different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'barnacle-bill';
export const { decide } = makeBrain();

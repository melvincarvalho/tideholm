// Tide Turner's brain. Identical to classic for now: its own file so that
// Tide Turner's tactics can change without touching any other bot. Override
// only what makes Tide Turner different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'tide-turner';
export const { decide } = makeBrain();

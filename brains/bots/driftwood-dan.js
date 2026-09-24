// Driftwood Dan's brain. Identical to classic for now: its own file so that
// Driftwood Dan's tactics can change without touching any other bot. Override
// only what makes Driftwood Dan different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'driftwood-dan';
export const { decide } = makeBrain();

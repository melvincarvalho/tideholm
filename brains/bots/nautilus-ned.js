// Nautilus Ned's brain. Identical to classic for now: its own file so that
// Nautilus Ned's tactics can change without touching any other bot. Override
// only what makes Nautilus Ned different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'nautilus-ned';
export const { decide } = makeBrain();

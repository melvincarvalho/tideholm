// Lagoon Lena's brain. Identical to classic for now: its own file so that
// Lagoon Lena's tactics can change without touching any other bot. Override
// only what makes Lagoon Lena different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'lagoon-lena';
export const { decide } = makeBrain();

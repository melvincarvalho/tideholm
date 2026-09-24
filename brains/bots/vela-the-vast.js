// Vela the Vast's brain. Identical to classic for now: its own file so that
// Vela the Vast's tactics can change without touching any other bot. Override
// only what makes Vela the Vast different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'vela-the-vast';
export const { decide } = makeBrain();

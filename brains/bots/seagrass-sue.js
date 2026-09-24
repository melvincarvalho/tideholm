// Seagrass Sue's brain. Identical to classic for now: its own file so that
// Seagrass Sue's tactics can change without touching any other bot. Override
// only what makes Seagrass Sue different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'seagrass-sue';
export const { decide } = makeBrain();

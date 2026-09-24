// Gull Cry's brain. Identical to classic for now: its own file so that
// Gull Cry's tactics can change without touching any other bot. Override
// only what makes Gull Cry different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'gull-cry';
export const { decide } = makeBrain();

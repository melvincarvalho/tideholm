// Wavebreaker's brain. Identical to classic for now: its own file so that
// Wavebreaker's tactics can change without touching any other bot. Override
// only what makes Wavebreaker different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'wavebreaker';
export const { decide } = makeBrain();

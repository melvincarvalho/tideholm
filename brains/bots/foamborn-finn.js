// Foamborn Finn's brain. Identical to classic for now: its own file so that
// Foamborn Finn's tactics can change without touching any other bot. Override
// only what makes Foamborn Finn different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'foamborn-finn';
export const { decide } = makeBrain();

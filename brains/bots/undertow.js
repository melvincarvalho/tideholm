// Undertow's brain. Identical to classic for now: its own file so that
// Undertow's tactics can change without touching any other bot. Override
// only what makes Undertow different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'undertow';
export const { decide } = makeBrain();

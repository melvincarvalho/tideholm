// Saltmarsh Sam's brain. Identical to classic for now: its own file so that
// Saltmarsh Sam's tactics can change without touching any other bot. Override
// only what makes Saltmarsh Sam different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'saltmarsh-sam';
export const { decide } = makeBrain();

// Puffin Pete's brain. Identical to classic for now: its own file so that
// Puffin Pete's tactics can change without touching any other bot. Override
// only what makes Puffin Pete different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'puffin-pete';
export const { decide } = makeBrain();

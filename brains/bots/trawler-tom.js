// Trawler Tom's brain. Identical to classic for now: its own file so that
// Trawler Tom's tactics can change without touching any other bot. Override
// only what makes Trawler Tom different, e.g. makeBrain({ homeFront: … }).
import { makeBrain } from '../lib/instincts.js';

export const name = 'trawler-tom';
export const { decide } = makeBrain();

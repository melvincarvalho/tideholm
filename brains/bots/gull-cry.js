// Gull Cry's brain. Identical to classic: its own file so that Gull Cry's
// tactics can change without touching any other bot. She was the first to
// dig in when farmed (2026-09-27); the same day every bot learned it, so it
// now lives in the classic instincts (brains/lib/instincts.js).
import { makeBrain } from '../lib/instincts.js';

export const name = 'gull-cry';
export const { decide } = makeBrain();

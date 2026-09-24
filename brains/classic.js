// The classic brain — the instincts with nothing overridden. Every bot
// thinks with it unless its persona names another brain.
import { makeBrain } from './lib/instincts.js';

export * from './lib/instincts.js';
export const name = 'classic';
export const { decide } = makeBrain();

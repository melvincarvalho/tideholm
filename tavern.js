// VENDORED UNCHANGED from github.com/melvincarvalho/tavern @ 53b8b04 —
// the pure wager maths, lifted into the server exactly as its header
// intends ("what survives here can be lifted into a game engine
// unchanged"). Do not edit here; re-copy from the tavern repo.
// tavern — provably-fair wager maths for a game economy.
//
// Deliberately pure and dependency-free: no DOM, no globals, no clock, and no
// crypto. The caller supplies hashes as hex strings, because the hash function
// differs by host (WebCrypto in a browser, node:crypto on a server) and this
// module should not care. What survives here can be lifted into a game engine
// unchanged, the way tidepool's amm.js was.
//
// The fairness scheme is commit–reveal:
//
//   1. the house picks a secret seed, publishes commitment = H(seed)
//   2. the player bets, contributing their own nonce
//   3. the house reveals seed; everyone computes H(seed | nonce) and derives
//      the roll from it
//
// The player's nonce is what stops the house shopping for a favourable seed:
// the outcome is not determined until the player has contributed, and the
// house is already bound to the seed by the commitment.
//
// NOTE ON WHAT THIS MODULE CANNOT DO. Commit–reveal is only meaningful when
// the commitment is published by a party that cannot change it afterwards.
// Run entirely client-side, there is nobody to prove anything to — the page
// holds the seed. The client-side use of this file is (a) a playable demo and
// (b) INDEPENDENT VERIFICATION of a round somebody else settled. Escrow and
// real commitment need a server.

/** Basis points the house keeps. 200 = 2%. */
export const DEFAULT_EDGE_BPS = 200;

/** No single round may risk more than this fraction of the bankroll. */
export const DEFAULT_MAX_RISK_FRAC = 0.02;

/** Faces on the die. 100 keeps the arithmetic legible for players. */
export const SIDES = 100;

/** Finite and positive, or 0. The pool learned this the hard way: one NaN in
 *  a reserve poisons every later number and surfaces as a nonsense error. */
export function amount(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clampFrac(n, fallback) {
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

function edgeOf(opts) {
  const bps = opts && Number(opts.edgeBps);
  // A negative edge would pay out more than fair and drain the bank; an edge
  // at or above 10000 would make every bet pay nothing. Both are config
  // mistakes rather than choices, so fall back rather than obey.
  return Number.isFinite(bps) && bps >= 0 && bps < 10000 ? bps : DEFAULT_EDGE_BPS;
}

/**
 * Derive a roll of 1..sides from a hash, deterministically.
 *
 * Takes 13 hex characters — 52 bits, the most that fits exactly in a JS
 * number. Modulo bias at 100 sides is about 100 / 2^52, roughly 2e-14, which
 * is far below anything observable and well below the noise of the edge.
 *
 * Returns null rather than a wrong answer when the input is not a usable
 * hash: a silently-wrong roll is the worst possible failure here.
 */
export function rollFromHash(hex, sides = SIDES) {
  if (typeof hex !== 'string') return null;
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{13,}$/.test(clean)) return null;
  const n = Number.isFinite(sides) && sides >= 2 && sides <= 1e6 ? Math.floor(sides) : SIDES;
  return (parseInt(clean.slice(0, 13), 16) % n) + 1;
}

/**
 * Verify a revealed round. `computedHash` is H(seed | nonce), hashed by the
 * caller; `commitment` is H(seed), published before the bet.
 *
 * Constant-time comparison is deliberately NOT attempted — these are public
 * values after the reveal, and pretending otherwise would be security
 * theatre in a module with no secrets in it.
 */
export function verifyRound({ commitment, seedHash, computedHash, roll, sides = SIDES }) {
  const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/^0x/, '') : null);
  const c = norm(commitment);
  const s = norm(seedHash);
  const h = norm(computedHash);
  if (!c || !s || !h) return { ok: false, reason: 'missing' };
  if (c !== s) return { ok: false, reason: 'commitment' };   // seed does not match what was promised
  const expected = rollFromHash(h, sides);
  if (expected == null) return { ok: false, reason: 'hash' };
  if (roll != null && Math.floor(Number(roll)) !== expected) {
    return { ok: false, reason: 'roll', expected };
  }
  return { ok: true, roll: expected };
}

/**
 * Price a bet: "the roll will be strictly above `target`".
 *
 * target 1..sides-1, so there is always at least one winning face and at
 * least one losing face. chance = (sides - target) / sides.
 *
 * The fair multiplier is 1/chance; the house keeps `edgeBps` of it. Payout
 * INCLUDES the stake, so a returned multiplier of 2 means "stake 10, get 20".
 */
export function quote(target, stake, opts = {}) {
  const sides = Number.isFinite(opts.sides) && opts.sides >= 2 ? Math.floor(opts.sides) : SIDES;
  const t = Math.floor(Number(target));
  if (!Number.isFinite(t) || t < 1 || t > sides - 1) {
    return { error: 'target', min: 1, max: sides - 1 };
  }
  const s = amount(stake);
  if (s <= 0) return { error: 'stake' };
  const edgeBps = edgeOf(opts);
  const chance = (sides - t) / sides;
  const fair = 1 / chance;
  const multiplier = fair * (1 - edgeBps / 10000);
  return {
    target: t,
    stake: s,
    chance,
    fair,
    multiplier,
    payout: s * multiplier,
    // What the bank stands to lose if this wins — the number the risk limit
    // is about. Not the payout: the stake is already the bank's on a loss.
    risk: s * (multiplier - 1),
    edgeBps,
    sides,
  };
}

/**
 * Largest stake the bank will accept for this target.
 *
 * Caps the bank's EXPOSURE, not the stake, because a long-odds bet risks far
 * more per unit staked than an even-money one. Without this a single 99x bet
 * can empty a bankroll, which is the same failure the pool's max-out fraction
 * exists to prevent.
 */
export function maxStake(bankroll, target, opts = {}) {
  const q = quote(target, 1, opts);
  if (q.error) return 0;
  const bank = amount(bankroll);
  const frac = clampFrac(opts.maxRiskFrac, DEFAULT_MAX_RISK_FRAC);
  const perUnitRisk = q.multiplier - 1;
  if (!(perUnitRisk > 0)) return 0;
  return (bank * frac) / perUnitRisk;
}

/**
 * Settle a bet against a roll. Returns the new bankroll alongside the result,
 * so the caller never has to reapply the arithmetic itself — two copies of a
 * settlement rule is how the pool's preview and action drifted apart.
 */
export function settle({ bankroll, target, stake, roll, opts = {} }) {
  const q = quote(target, stake, opts);
  if (q.error) return { error: q.error };
  const bank = amount(bankroll);
  const r = Math.floor(Number(roll));
  if (!Number.isFinite(r) || r < 1 || r > q.sides) return { error: 'roll' };
  const limit = maxStake(bank, target, opts);
  if (q.stake > limit) return { error: 'maxStake', maxStake: limit };

  const win = r > q.target;
  // On a win the bank pays the profit; on a loss it keeps the stake. Writing
  // it as a delta keeps the two branches from disagreeing about the stake.
  const delta = win ? -(q.payout - q.stake) : q.stake;
  return {
    ok: true,
    win,
    roll: r,
    target: q.target,
    stake: q.stake,
    payout: win ? q.payout : 0,
    delta,
    bankroll: bank + delta,
    multiplier: q.multiplier,
    chance: q.chance,
    edgeBps: q.edgeBps,
  };
}

// ---------------------------------------------------------------- bankroll
//
// The bank is a liquidity pool wearing a different hat: providers deposit,
// receive shares, and the house edge accrues to them exactly as swap fees
// accrue to an AMM's providers. This is lifted from tidepool's share
// accounting, including the two lessons it cost: a first deposit must not be
// able to mint shares against nothing, and a burn must never grow the bank.

/** Shares minted for a deposit. First deposit sets the unit. */
export function bankrollAdd(bankroll, totalShares, deposit) {
  const bank = amount(bankroll);
  const total = amount(totalShares);
  const dep = amount(deposit);
  if (dep <= 0) return { error: 'deposit' };
  // An empty bank with shares outstanding, or shares with an empty bank, is a
  // broken state — minting into it would strand whoever is already in.
  if ((total > 0) !== (bank > 0)) return { error: 'brokenBank' };
  const minted = total > 0 ? (dep * total) / bank : dep;
  if (!(minted > 0) || !Number.isFinite(minted)) return { error: 'minted' };
  return { ok: true, minted, bankroll: bank + dep, totalShares: total + minted };
}

/** Value returned for burning shares. */
export function bankrollRemove(bankroll, totalShares, burn) {
  const bank = amount(bankroll);
  const total = amount(totalShares);
  const b = amount(burn);
  if (b <= 0) return { error: 'burn' };
  if (b > total) return { error: 'tooMany' };
  if (!(bank > 0) || !(total > 0)) return { error: 'brokenBank' };
  const out = (b * bank) / total;
  if (!(out > 0) || out > bank) return { error: 'out' };
  return { ok: true, out, bankroll: bank - out, totalShares: total - b };
}

/** What a holding is worth right now. */
export function shareValue(bankroll, totalShares, mine) {
  const bank = amount(bankroll);
  const total = amount(totalShares);
  const m = amount(mine);
  if (!(total > 0) || !(bank > 0) || m <= 0) return 0;
  return (Math.min(m, total) * bank) / total;
}

/** House edge expressed as expected return to the bank, per unit staked. */
export function expectedBankReturn(target, opts = {}) {
  const q = quote(target, 1, opts);
  if (q.error) return 0;
  // lose q.risk with probability `chance`, keep 1 with probability 1-chance
  return (1 - q.chance) * 1 - q.chance * q.risk;
}

// Tideholm — the resource pool's portable half (#58).
//
// A constant-product market maker, as the always-available counterparty an
// offer book cannot be. An order book needs someone to want the mirror of
// your trade at the same moment; with a handful of active players that never
// happens, and `world.offers` sat empty for a season to prove it.
//
// This file is the maths, the stored state, and the open/close lifecycle —
// everything that knows nothing about islands, harbours or travel. The game
// rules that put the pool IN the game (swap/deposit/withdraw with their
// harbour gating, capacity checks and shipping) live in game.js, which
// imports from here and re-exports, so nothing downstream changes.
//
// Deliberately dependency-free, like the engine it was cut from: no imports,
// no clock, no world. The resource names themselves are derived from the
// reserves object wherever possible, so the maths is not married to
// wood/stone/gold — only `newPool` needs a list, and takes one.
//
// Three resources share one pool, but a swap only ever touches the two
// reserves involved, so each pair behaves as its own curve:
//
//     k = R_in * R_out
//     out = R_out - k / (R_in + in_after_fee)
//
// Spot prices stay mutually consistent because (Rw/Rs)*(Rs/Rg)*(Rg/Rw) = 1,
// so there is no triangular arbitrage to harvest at spot, and fee plus
// slippage make any actual round trip a loss. Both are pinned in tests.js.
//
// Tuned against a week of the live season rather than the base production
// rates: gold is 17.3% of what the world produces but only 10.4% of what it
// is spent on, so it is worth *less* than wood, not more. See #46.
const POOL_FEE_BPS = 30;        // 0.30% of the input, kept by the pool
const POOL_MAX_OUT_FRAC = 0.30; // no single swap may take more than this share

const POOL_RESOURCES = ['wood', 'stone', 'gold'];

// A key counts only if the reserves object itself carries it. The prototype
// chain must not: `'toString' in reserves` is true for every object, and a
// quote against a prototype key would do arithmetic on a function — NaN into
// the pool, poisoning every quote after it.
const hasLeg = (reserves, r) => Object.hasOwn(reserves, r);

// Every one of these is reachable from an HTTP body, so each validates its
// own arguments rather than trusting the caller. Endpoints validate too —
// `sendTrade` already does — but these are the functions that must never
// print or destroy resources, so they have to be safe alone.

/** Finite and positive, or zero. The only amounts the pool will act on. */
function poolAmount(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function poolClamp(n, lo, hi, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

const poolNoQuote = () => ({
  out: 0, impact: 0, effPrice: Infinity, spotPrice: 0,
  capped: false, cappedBy: null, maxIn: 0, used: 0,
});

/** Spot price: how much `from` one unit of `to` costs, ignoring slippage. */
function poolSpot(reserves, from, to) {
  // Unknown keys are checked first: poolSpot('iron', 'iron') has no price to
  // report, and answering 1 would leak a bogus 1:1 rate for a resource the
  // pool does not hold. Validating against the reserves that actually exist
  // is the point: the pool defines what it holds, not a list somewhere else.
  if (!hasLeg(reserves, from) || !hasLeg(reserves, to)) return 0;
  if (from === to) return 1;
  return reserves[from] / reserves[to];
}

/**
 * Quote a swap without applying it.
 *
 * `opts.floor` is an absolute per-resource reserve floor. It exists because
 * the per-swap drain cap cannot protect a reserve on its own: the cap is
 * proportional, so a sustained one-way flow still empties it — 0.7^n reaches
 * zero, and against the real season it did so in about 10,500 trades. A floor
 * measured against the *seeded* amount holds where a percentage cannot.
 *
 * @returns {{out:number, impact:number, effPrice:number, spotPrice:number,
 *            capped:boolean, cappedBy:('cap'|'floor'|null), maxIn:number, used:number}}
 *   `impact` is the gap between the effective and spot price — the number
 *   that says the pool is too thin for the trade you asked for.
 */
function poolQuote(reserves, from, to, amountIn, opts = {}) {
  // Refuse anything that is not a real, distinct pair before touching the
  // arithmetic. `from === to` would have applySwap write the same reserve key
  // twice, discarding `used` and destroying what the trader paid; an unknown
  // key would write NaN into the pool and poison every quote after it.
  if (!hasLeg(reserves, from) || !hasLeg(reserves, to) || from === to) {
    return poolNoQuote();
  }
  // Options are season config, not constants, so clamp rather than trust: a
  // negative fee would pay traders to trade, and a negative cap makes `used`
  // negative, which is a resource printer once a caller deducts it.
  const feeBps = poolClamp(opts.feeBps, 0, 10000, POOL_FEE_BPS);
  const maxOutFrac = poolClamp(opts.maxOutFrac, 0, 1, POOL_MAX_OUT_FRAC);
  const floor = opts.floor;
  const spotPrice = poolSpot(reserves, from, to);

  // A negative or non-numeric input must never reach the arithmetic below.
  // Unclamped, `next[from] = reserves[from] + used` with a negative `used`
  // shrinks the reserve while a caller deducting `used` from the player
  // credits them instead — a resource printer.
  const wanted = poolAmount(amountIn);

  const byCap = reserves[to] * maxOutFrac;
  // A floor entry that is missing or non-numeric means "no floor on this leg",
  // not NaN. Without this, a partial floor object silently zeroes every quote
  // and blames the drain cap for it.
  const hasFloor = floor && Number.isFinite(floor[to]);
  const byFloor = hasFloor ? Math.max(0, reserves[to] - floor[to]) : Infinity;
  const maxOut = Math.min(byCap, byFloor);

  // Largest input whose output stays inside that ceiling, from
  // out = Rout * dxf / (Rin + dxf) solved for dxf, then undoing the fee.
  const f = 1 - feeBps / 10000;
  const headroom = reserves[to] - maxOut;
  const maxIn = f > 0 && headroom > 0 ? (maxOut * reserves[from]) / headroom / f : 0;

  const capped = wanted > maxIn;
  const used = capped ? maxIn : wanted;
  const dxf = used * f;
  const out = used > 0
    ? reserves[to] - (reserves[from] * reserves[to]) / (reserves[from] + dxf)
    : 0;
  const effPrice = out > 0 ? used / out : Infinity;

  return {
    out,
    impact: out > 0 ? effPrice / spotPrice - 1 : 0,
    effPrice,
    spotPrice,
    capped,
    cappedBy: !capped ? null : (byFloor < byCap ? 'floor' : 'cap'),
    maxIn,
    used,
  };
}

/** Apply a swap, returning new reserves. Does not mutate its argument. */
function poolApplySwap(reserves, from, to, amountIn, opts = {}) {
  const q = poolQuote(reserves, from, to, amountIn, opts);
  // A refused quote must not write anything at all. Assigning even a zero
  // would add the key: `next['iron'] = undefined - 0` is NaN, which poisons
  // the pool for every quote after it.
  if (q.used <= 0 && q.out <= 0) return { reserves: { ...reserves }, ...q };
  const next = { ...reserves };
  next[from] = reserves[from] + q.used;
  next[to] = reserves[to] - q.out;
  return { reserves: next, ...q };
}

/**
 * Add liquidity in proportion to the current reserves.
 * The first deposit into an empty pool defines the price, so it sets the
 * ratio; every later one must match it or it would be donating value.
 * @returns {{reserves, totalShares, minted, required}}
 */
function poolAddLiquidity(reserves, totalShares, desired) {
  const legs = Object.keys(reserves);
  if (totalShares <= 0) {
    // Every leg has to be present, or the pairs involving a missing one
    // cannot price at all. Refusing beats the old `|| 1` fallback, which
    // minted a share against nothing: reserves stayed at zero, so `scale`
    // was zero for every later deposit and the pool could never be revived.
    // And there must be at least two: the mint scale below is the geometric
    // mean of the first two legs, so a one-leg pool would mint sqrt(x *
    // undefined) — NaN into totalShares, poisoning every quote after it.
    if (legs.length < 2 || !legs.every((r) => Number.isFinite(desired[r]) && desired[r] > 0)) {
      return {
        reserves: { ...reserves },
        totalShares,
        minted: 0,
        required: Object.fromEntries(legs.map((r) => [r, 0])),
      };
    }
    // The mint scale is set by the first two legs. Any positive scale works —
    // shares are only ever meaningful as a fraction of totalShares — this one
    // is kept because it is what every live season has used.
    const minted = Math.sqrt(desired[legs[0]] * desired[legs[1]]);
    return {
      reserves: { ...desired },
      totalShares: minted,
      minted,
      required: { ...desired },
    };
  }
  // Scale to the tightest resource so nothing is left stranded. Amounts go
  // through poolAmount for the same reason as everywhere else: the global
  // isFinite() used here before would coerce, so a numeric string from a
  // request body was silently accepted while every other entry point rejected
  // one.
  let scale = Infinity;
  for (const r of legs) {
    if (reserves[r] > 0) scale = Math.min(scale, poolAmount(desired[r]) / reserves[r]);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 0;
  const required = {};
  const next = {};
  for (const r of legs) {
    required[r] = reserves[r] * scale;
    next[r] = reserves[r] + required[r];
  }
  const minted = totalShares * scale;
  return { reserves: next, totalShares: totalShares + minted, minted, required };
}

/** Burn shares for a proportional slice of every reserve. */
function poolRemoveLiquidity(reserves, totalShares, burn) {
  // Burning more than exists takes everything rather than driving the share
  // count negative. A negative burn would run the whole thing backwards —
  // `frac` goes negative, so reserves *grow* and the payout is negative —
  // and a NaN one turns every reserve into NaN, so both are refused.
  const burned = totalShares > 0 ? Math.min(poolAmount(burn), totalShares) : 0;
  const frac = totalShares > 0 ? burned / totalShares : 0;
  const out = {};
  const next = {};
  for (const r of Object.keys(reserves)) {
    out[r] = reserves[r] * frac;
    next[r] = reserves[r] - out[r];
  }
  return { reserves: next, totalShares: totalShares - burned, out };
}

/** What a share balance is currently worth, resource by resource. */
function poolShareValue(reserves, totalShares, shares) {
  // Same family as the guard in poolRemoveLiquidity: a negative or NaN share
  // count would value a position at less than nothing, and claiming more
  // shares than exist cannot be worth more than the whole pool.
  const frac = totalShares > 0 ? Math.min(1, poolAmount(shares) / totalShares) : 0;
  const out = {};
  for (const r of Object.keys(reserves)) out[r] = reserves[r] * frac;
  return out;
}

// ---- stored pool state
//
// The pool's parameters live in the world, not in env (#23). A season's
// economy is then reproducible from its archived world.json alone, and the
// pool can be opened on a running season without the env edit that a restart
// would need — the hazard that took the site down once already.
//
// A world always has a pool object and it always starts CLOSED: zero
// reserves, zero shares. Seeding is a deliberate act, never a side effect of
// creating or loading a world. That is the #36 scar — land respawn fired from
// inside migrateWorld, so a client-only release restarted the process and
// conjured 30 islands mid-season. Nothing here may conjure resources.
const POOL_FLOOR_FRAC = 0.25;

function newPool(resources = POOL_RESOURCES) {
  const zero = Object.fromEntries(resources.map((r) => [r, 0]));
  return {
    open: false,
    reserves: { ...zero },
    // The floor is measured against what was seeded, not against what is
    // left, which is the only reason it can hold at all.
    seeded: { ...zero },
    totalShares: 0,
    openedAt: null,
    feeBps: POOL_FEE_BPS,
    maxOutFrac: POOL_MAX_OUT_FRAC,
    floorFrac: POOL_FLOOR_FRAC,
  };
}

/** Turn stored pool config into the opts the pure functions above take. */
function poolOpts(pool) {
  const frac = poolClamp(pool && pool.floorFrac, 0, 1, 0);
  return {
    feeBps: pool ? pool.feeBps : POOL_FEE_BPS,
    maxOutFrac: pool ? pool.maxOutFrac : POOL_MAX_OUT_FRAC,
    floor: frac > 0 && pool
      ? Object.fromEntries(Object.keys(pool.seeded).map((r) => [r, poolAmount(pool.seeded[r]) * frac]))
      : undefined,
  };
}

// ---- opening and closing the pool
//
// Seeding is an admin act, deliberately: it mints resources into the world,
// and nothing that merely creates or loads a world may do that (#36). It is
// also what makes the floor meaningful, since the floor is measured against
// what was seeded.
//
// The seed stake belongs to nobody. Shares are minted against the initial
// reserves but held by no player, so `totalShares` minus the sum of every
// player's lpShares is permanent liquidity that cannot be withdrawn. That is
// the point of an admin seed: players deposit on top of a base that will not
// vanish when one of them cashes out.

function openPool(world, reserves, now) {
  const pool = world.pool;
  if (pool.open) return { error: 'err.poolAlreadyOpen' };

  // Already seeded and merely closed? Resume — never mint a second seed.
  // Reseeding would reset totalShares while players still held their
  // lpShares, so a holder of half the pool would suddenly claim many times
  // all of it: at 4000/3600/6800 with half the shares, reopening at 1/1/1
  // left one player claiming 189,737% of the pool. A season reset is how a
  // pool gets seeded afresh; reopening is only an off switch going back on.
  if (pool.totalShares > 0) {
    pool.open = true;
    return { ok: true, resumed: true, reserves: { ...pool.reserves }, totalShares: pool.totalShares };
  }

  const legs = Object.keys(pool.reserves);
  // A pool needs at least two legs to price anything, and the share mint
  // below multiplies the first two — one leg would put NaN in totalShares.
  // Unreachable through newPool, but this object comes off disk.
  if (legs.length < 2) return { error: 'err.badRequest' };
  const seed = {};
  for (const r of legs) {
    seed[r] = Math.floor(poolAmount(reserves && reserves[r]));
    // Every leg has to be present or the pairs involving a missing one cannot
    // price at all — the same rule poolAddLiquidity applies to a first deposit.
    if (seed[r] < 1) return { error: 'err.badRequest' };
  }
  pool.reserves = { ...seed };
  pool.seeded = { ...seed };
  pool.totalShares = Math.sqrt(seed[legs[0]] * seed[legs[1]]);
  pool.open = true;
  pool.openedAt = now;
  return { ok: true, reserves: { ...pool.reserves }, totalShares: pool.totalShares };
}

/**
 * Stop trading without destroying anything. An off switch for a live economic
 * feature is worth having before the feature is live: reserves, shares and
 * positions all survive, so reopening resumes where it left off.
 */
function closePool(world) {
  const pool = world.pool;
  if (!pool.open) return { error: 'err.poolClosed' };
  pool.open = false;
  return { ok: true };
}

export {
  POOL_FEE_BPS, POOL_MAX_OUT_FRAC, POOL_FLOOR_FRAC, POOL_RESOURCES,
  poolAmount, poolClamp,
  poolSpot, poolQuote, poolApplySwap,
  poolAddLiquidity, poolRemoveLiquidity, poolShareValue,
  newPool, poolOpts, openPool, closePool,
};

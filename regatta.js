// regatta.js — pure race maths for The Regatta.
//
// Same discipline as the tavern's tavern.js: no DOM, no clock, no network,
// no crypto. The caller supplies hashes as hex; everything here is a pure
// function of its arguments, so it runs identically in a browser, in node
// tests, in an offline verifier, or vendored into a game server that wants
// to re-check a claimed win (BUILDING-GAMES.md §5).
//
// The race: WEIGHTS partition a 10,000-point line into bands, one per boat.
// A roll is drawn from the deciding seed (sha256(blockHash|mark), computed
// by the caller) and the band it lands in names the winner. A bet on a boat
// pays weightSpace/weight, less the house edge. The race animation itself is
// derived from the same seed (raceTrace), so the replay a player watches IS
// the proof — same inputs, same waves, same finish, on any machine.

export const WEIGHT_SPACE = 10_000;
export const EDGE_BPS = 300; // 3% house edge, applied to the payout multiplier

// The field. Weights sum to WEIGHT_SPACE; order is part of the protocol
// (bands are carved in listed order), so treat this list as append-only.
export const BOATS = [
  { key: 'tern',      name: 'Arctic Tern',   weight: 3400 },
  { key: 'gull',      name: 'Laughing Gull', weight: 2600 },
  { key: 'heron',     name: 'Night Heron',   weight: 1900 },
  { key: 'petrel',    name: 'Storm Petrel',  weight: 1300 },
  { key: 'albatross', name: 'Albatross',     weight: 800 },
];

// ---------------------------------------------------------------- the roll

// A deterministic roll in [0, space) from a hex string. Mirrors the tavern's
// convention (BigInt over the full hash, mod the space) so a server that
// already verifies tavern rolls can verify regatta rolls the same way.
export function rollFromHash(hex, space = WEIGHT_SPACE) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  if (!clean.length) throw new Error('rollFromHash: empty hex');
  return Number(BigInt('0x' + clean) % BigInt(space));
}

// Which band the roll lands in. Bands are [start, start+weight) in BOATS
// order: roll 0..3399 → tern, 3400..5999 → gull, and so on.
export function winnerIndex(roll, boats = BOATS) {
  let start = 0;
  for (let i = 0; i < boats.length; i++) {
    if (roll < start + boats[i].weight) return i;
    start += boats[i].weight;
  }
  throw new Error('winnerIndex: roll outside weight space');
}

// ---------------------------------------------------------------- pricing

// Fair multiplier is space/weight; the edge shaves it. Payouts are floored
// to whole coins, and a bet must be able to win at least its stake back —
// quote() reports payout so callers can refuse degenerate stakes.
export function quote(boatIndex, stake, { boats = BOATS, edgeBps = EDGE_BPS } = {}) {
  const boat = boats[boatIndex];
  if (!boat) throw new Error('quote: no such boat');
  if (!Number.isInteger(stake) || stake <= 0) throw new Error('quote: stake must be a positive integer');
  const chance = boat.weight / WEIGHT_SPACE;
  const multiplier = (WEIGHT_SPACE / boat.weight) * (1 - edgeBps / 10_000);
  const payout = Math.floor(stake * multiplier);
  return { chance, multiplier, payout, risk: stake };
}

// Settle a race for one bet. `roll` decides the winner; the bet pays quote()'s
// payout if its boat won, nothing otherwise. delta is the net change to the
// bettor's purse (stake was already committed when the bet was placed).
export function settle({ boatIndex, stake, roll, boats = BOATS, edgeBps = EDGE_BPS }) {
  const winner = winnerIndex(roll, boats);
  const won = winner === boatIndex;
  const payout = won ? quote(boatIndex, stake, { boats, edgeBps }).payout : 0;
  return { won, winner, payout, delta: payout - stake };
}

// ---------------------------------------------------------------- verifying

// Re-derive a whole claimed race from first principles. seedHex must be
// sha256(blockHashHex + '|' + mark) computed by the caller (browser: WebCrypto;
// node: crypto). Returns what SHOULD have happened; the caller compares.
export function verifyRace({ seedHex, boatIndex, stake, boats = BOATS, edgeBps = EDGE_BPS }) {
  const roll = rollFromHash(seedHex);
  return { roll, ...settle({ boatIndex, stake, roll, boats, edgeBps }) };
}

// ---------------------------------------------------------------- the replay

// xorshift128 seeded from the race seed — deterministic, portable, no Math.random.
function prng(seedHex) {
  const clean = String(seedHex).replace(/[^0-9a-fA-F]/g, '').padEnd(32, '7');
  let a = parseInt(clean.slice(0, 8), 16) | 0;
  let b = parseInt(clean.slice(8, 16), 16) | 0;
  let c = parseInt(clean.slice(16, 24), 16) | 0;
  let d = parseInt(clean.slice(24, 32), 16) | 0;
  return function next() {
    const t = b << 9; let r = b * 5; r = ((r << 7) | (r >>> 25)) * 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return ((r >>> 0) / 4294967296);
  };
}

// The race replay: per-tick positions in [0,1] for every boat, ending with the
// decided winner first across the line. Everything — every gust, every stall —
// comes from the seed, so two honest replays of the same race are identical.
// Non-winners are scaled to finish strictly behind; near-misses happen when the
// runner-up's raw pace ran close, which keeps finishes dramatic but honest.
export function raceTrace(seedHex, winner, { boats = BOATS, ticks = 240 } = {}) {
  const rand = prng(seedHex);
  const n = boats.length;
  // Raw pace curves: a base speed plus gusts (short surges) and lulls.
  const paces = [];
  for (let i = 0; i < n; i++) {
    const base = 0.75 + rand() * 0.5;
    const gusts = [];
    const gustCount = 2 + Math.floor(rand() * 3);
    for (let g = 0; g < gustCount; g++) {
      gusts.push({ at: rand(), width: 0.06 + rand() * 0.1, force: (rand() - 0.35) * 1.6 });
    }
    paces.push({ base, gusts, wobble: 1 + Math.floor(rand() * 5) });
  }
  // Integrate progress.
  const raw = [];
  for (let i = 0; i < n; i++) {
    const p = paces[i];
    const row = new Float64Array(ticks + 1);
    let x = 0;
    for (let t = 1; t <= ticks; t++) {
      const u = t / ticks;
      let v = p.base;
      for (const g of p.gusts) {
        const d = (u - g.at) / g.width;
        v += g.force * Math.exp(-d * d);
      }
      v += 0.12 * Math.sin(u * Math.PI * 2 * p.wobble + i);
      x += Math.max(0.15, v);
      row[t] = x;
    }
    raw.push(row);
  }
  // Normalize: winner hits exactly 1.0 at the final tick; every other boat is
  // scaled to finish at 92–99.5% of the line, ordered by its raw finish so the
  // seed still decides second, third, and how close the photo finish looks.
  const finals = raw.map((row, i) => ({ i, x: row[ticks] }));
  const losers = finals.filter((f) => f.i !== winner).sort((a, b) => b.x - a.x);
  const scale = new Float64Array(n);
  scale[winner] = 1 / raw[winner][ticks];
  losers.forEach((f, rank) => {
    const target = 0.995 - rank * 0.028 - rand() * 0.015;
    scale[f.i] = target / raw[f.i][ticks];
  });
  const trace = [];
  for (let t = 0; t <= ticks; t++) {
    const frame = new Float64Array(n);
    for (let i = 0; i < n; i++) frame[i] = Math.min(1, raw[i][t] * scale[i]);
    trace.push(frame);
  }
  trace[ticks][winner] = 1; // exact, immune to float rounding in raw*1/raw
  return trace;
}

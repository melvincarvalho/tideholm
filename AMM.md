# The Tidepool — a constant-product AMM inside a game economy

This document describes the automated market maker in Tideholm in enough
detail to **reimplement it, port it, or extend it** — and, more importantly,
to avoid the specific mistakes that were made building it. Every bug listed
here was real and found in review or by mutation testing.

Written for a reader who has not seen the codebase. Tracking issue: #46.

---

## 1. What it is, in one paragraph

Three resources — wood, stone, gold — share one pool. Players swap between
them at a price set by a constant-product curve rather than a fixed table, and
may deposit resources to become liquidity providers, earning a share of the
0.30% fee. A swap ships its proceeds home from the player's harbour and takes
30 minutes to arrive. A per-swap drain cap and a reserve floor stop one trader
or one sustained flow from emptying a side.

The reason it exists: Tideholm already had a player-to-player offer book, and
it recorded **zero offers and zero trades across an entire season**. An order
book needs a counterparty who wants the mirror of your trade at the same
moment. With a handful of active players that never happens. A pool needs no
counterparty.

---

## 2. Layering — the part that matters for porting

The implementation is deliberately stratified. **Only layer 1 is portable
verbatim.** Everything above it encodes decisions specific to a game with
islands, harbours, storehouses and travel time.

| Layer | Contents | Portable? | Where |
|---|---|---|---|
| **1. Maths** | `poolSpot`, `poolQuote`, `poolApplySwap`, `poolAddLiquidity`, `poolRemoveLiquidity`, `poolShareValue` | **Yes, verbatim.** No I/O, no clock, no globals, no domain concepts | `game.js` |
| **2. Stored state** | `newPool`, `poolOpts`, the `world.pool` shape | Yes, with a different container | `game.js` |
| **3. Lifecycle** | `openPool`, `closePool` | Mostly — the "who may seed" rule is policy | `game.js` |
| **4. Domain rules** | `sendPoolSwap`, `planPoolDeposit`/`sendPoolDeposit`, `planPoolWithdraw`/`sendPoolWithdraw` | **No.** Harbour gating, travel time, storehouse limits, movement objects | `game.js` |
| **5. Transport** | `GET /api/pool`, `POST /api/pool/{swap,deposit,withdraw}`, `POST /api/admin/pool/{open,close}` | No | `app.js` |
| **6. Client** | Market-tab UI | No | `public/app.js` |

If you are porting this into another system, **take layer 1 and 2, read layer
3, and rewrite 4–6.** Layer 1 is about 200 lines and has no dependencies.

### The rule that keeps layer 1 clean

Layer 1 functions never read the clock, never mutate their arguments, and know
nothing about players, islands or requests. They take plain objects of numbers
and return plain objects of numbers. This is what let the maths be merged,
reviewed and tested *before anything could call it* — see §9.

---

## 3. The maths

Three resources share one pool, but **a swap only ever touches the two
reserves involved**, so each pair behaves as its own `x·y=k` curve:

```
k   = R_in · R_out
out = R_out − k / (R_in + in_after_fee)
```

The fee is taken off the input and **stays in the pool**, so it accrues to
liquidity providers rather than to a house account. That is what makes an LP
share appreciate.

### Why three resources in one pool is safe

Spot prices around the triangle multiply to 1:

```
(R_w/R_s) · (R_s/R_g) · (R_g/R_w) = 1
```

so there is no triangular arbitrage sitting in the price table. Fee plus
slippage make any actual round trip a loss. Both are asserted in tests —
`no triangular arbitrage at spot`, `a triangular round trip returns less than
it sent` — and the second is asserted **even at zero fee**, where only
slippage protects it.

### Reference: `poolQuote`

```js
poolQuote(reserves, from, to, amountIn, opts) -> {
  out,        // how much `to` comes back
  used,       // how much `from` was actually taken (< amountIn if clamped)
  impact,     // effPrice/spotPrice − 1: the number that says "pool too thin"
  effPrice,   // used/out
  spotPrice,  // reserves[from]/reserves[to]
  capped,     // was the order clamped?
  cappedBy,   // 'cap' | 'floor' | null — WHICH ceiling bit
  maxIn,      // largest input that stays inside the ceiling
}
```

`opts`: `{ feeBps = 30, maxOutFrac = 0.30, floor }`.

`maxIn` is derived by solving `out = R_out·dxf/(R_in + dxf)` for `dxf` at the
ceiling, then undoing the fee. Do not approximate this by iteration; the
closed form is exact and cheap.

---

## 4. The two protections, and why one of them does nothing on its own

### The per-swap drain cap (`maxOutFrac`, default 0.30)

No single swap may take more than 30% of the output reserve. This stops one
whale pricing every later trade against a broken pool.

**It cannot protect a reserve.** It is *proportional*, so a sustained one-way
flow still empties the side: `0.7ⁿ` reaches zero. Against a replay of a real
season it did so in roughly **10,500 trades**. This is pinned by a test named
`the cap alone does NOT stop a sustained drain`, kept deliberately so nobody
later mistakes the cap for protection.

### The reserve floor (`floorFrac`, default 0.25)

A reserve may not be sold below 25% of **what was seeded** — not 25% of what
is left. That distinction is the whole point: a percentage of the remainder is
just another proportional cap and decays to zero identically.

Measured against seeded amounts, the floor holds exactly. What it costs is
that a reserve can park on its floor and refuse to sell. That is not a
failure — it is the pool reporting honestly that the economy is lopsided, and
the UI says so.

Tested at both ends: 40 consecutive maximal drains leave the reserve **exactly
at the floor**, and without a floor the same 40 leave it at 0.0001% of seed.

---

## 5. Parameters, and how they were derived

**Do not copy these numbers into another economy.** Copy the method.

| Parameter | Value | Basis |
|---|---|---|
| `feeBps` | 30 (0.30%) | Uniswap's default; a prior, not a finding |
| `maxOutFrac` | 0.30 | Judgement — large enough to be usable, small enough to blunt a whale |
| `floorFrac` | 0.25 | The only remedy that worked; see §4 |
| `POOL_TRAVEL_MIN` | 30 min | Game feel |
| seed ratio | 1 : 0.92 : 1.60 | **Derived** — see below |

### Deriving the seed ratio

A resource's value is **demand ÷ supply**, where demand is the cost of every
building level and every unit standing in the world (all of it was paid for,
so it is revealed preference) and supply is current production per hour. The
fair price of gold in wood is `value(gold)/value(wood)`, and the seed reserves
are its **inverse**.

Run against the live season:

```
wood   demand 2,032,825   supply/h 46,023   value 44.2
stone  demand 1,977,270   supply/h 41,360   value 47.8
gold   demand   406,061   supply/h 14,755   value 27.5

1 gold  = 0.623 wood      1 stone = 1.082 wood
seed reserve ratio w:s:g = 1.00 : 0.92 : 1.60
```

The script is committed as `tune-against-season.mjs` in
[melvincarvalho/tidepool](https://github.com/melvincarvalho/tidepool), so the
numbers can be re-derived rather than trusted:

```sh
WORLD=path/to/world.json GAME=path/to/game.js node tune-against-season.mjs
```

### The counter-intuitive finding

**Gold is worth less than wood.** Base production rates are 40/40/18 per hour,
which suggests gold is scarce and should be dear. But buildings and units are
priced almost entirely in wood and stone, so gold is **14.4% of what the world
produces and only 9.2% of what it spends**. The vaults confirm it: gold sits at
1.55× wood.

Seeding at the base production ratio would have priced gold at 2.22 wood when
its real value is 0.62 — an error of 3.5×, in the direction that guarantees
the gold side is drained on day one.

**The transferable lesson: derive prices from demand ÷ supply, not from supply
alone.** Production rates are half the picture and the intuitive half is the
wrong one.

### A methodological warning

The tuning originally used two independent methods — the analytic one above,
and an empirical replay of a week of trading — and reported that they agreed
(0.586 vs 0.62). On a *second* world the empirical method **did not converge
at all**: a 7.5× spread depending on the starting ratio.

Worse, the script had a **hardcoded** empirical figure left over from the first
world, so it printed agreement regardless of input. Any cross-check that can
print a constant is not a cross-check. If you adopt this method, compute both
sides or state plainly that you have only one.

---

## 6. Domain integration (layer 4) — the Tideholm-specific decisions

These are the choices a different system would remake. Each is recorded with
its reasoning because the reasoning ports even when the decision does not.

**Swaps ship home; deposits do not.** A swap and a withdrawal deliver goods to
an island, so they create a `trade` movement and take 30 minutes. A deposit
delivers nothing to the player, so it settles instantly. The asymmetry is not
an oversight.

**Flat travel time, not distance-based.** The pool has no location on the map.
Distance pricing would hand coastal and central islands a permanent advantage —
a second balance problem, easy to add later and hard to remove.

**The pool moves at send time, not on arrival.** If the price only moved when
goods landed, a player could fire a dozen swaps at the same opening rate and
strip a reserve before any of them arrived. Pinned by a test that fires three
back-to-back swaps and asserts each gets a worse price *while all three are
still in flight*.

**Delivery reuses the existing `trade` movement type**, so integrating the pool
required **zero changes to `applyMovement`** — a 423-line function that is the
riskiest in the codebase. This was designed for, and verified mechanically
rather than by eye: no diff hunk falls inside its line range.

**Storehouse room is checked at arrival, not now** — counting production over
the crossing and any shipment already inbound that lands first. It cannot know
what the player sends afterwards, and arrival still clamps like every other
delivery, so it is a good guard rather than a guarantee. The comment in the
code says exactly that, because an earlier version claimed more than it
delivered.

**Seeding mints resources, so only an admin may do it.** Nothing that merely
creates or loads a world may mint — see §8.

**Reopening resumes; it never reseeds.** See §7 for why.

---

## 7. Failure modes — read this section before writing any of it

Every item here was a real defect. They cluster into three families.

### Family A: resource printers and destroyers (in pure maths)

Found in the first two review rounds, all in code that could not yet touch a
stockpile.

| Defect | Effect |
|---|---|
| negative `amountIn` | `next[from] = reserves[from] + used` **shrinks** the reserve; a caller deducting `used` **credits** the player |
| negative `maxOutFrac` | makes `used` negative — same printer |
| negative `burn` in `removeLiquidity` | `frac` goes negative, reserves **grow** from nothing, payout is negative |
| `from === to` | `applySwap` assigns the same reserve key twice; the `used` write is overwritten and the payment **vanishes** (14,400 → 13,957 units) |
| unknown resource key | writes `NaN` into the reserves and poisons every later quote |
| first deposit of `{0,0,0}` | `Math.sqrt(0) \|\| 1` minted a share against nothing; reserves stayed zero, so every later deposit scaled to zero and the pool was **permanently bricked** |
| reopening a closed pool | reseeded it — reserves overwritten and `totalShares` reset **while players still held `lpShares`**. A holder of half the pool came out claiming **189,737%** of it |

**The fix was one validation layer, not seven patches:** `poolAmount` (finite
and positive, else zero), `poolClamp` for option ranges, and a well-formed
refusal object. Options are **clamped rather than rejected** — a negative fee
becomes zero, because the invariant that matters is that it can never become a
bonus.

### Family B: seams between layers

This is the family to watch, because it survives every fix aimed at the layer
below.

The preview and the action were made to **share one pure function**
(`planPoolDeposit`) precisely so they could not disagree. They then disagreed
**four more times**, always about the *input* rather than the maths:

1. **Flooring.** The quote endpoint used the raw amount; the swap floored it.
   `1.9` was quoted as `1.9` and swapped as `1`, so `minOut` derived from the
   quote was unreachable and the swap failed with *"the price moved"* when
   nothing had moved.
2. **String coercion.** `GET` called `Number()`; `POST` did not. `poolAmount`
   deliberately refuses strings, so a holder was told they had no stake.
3. **Staleness.** Previews planned against the stored island; actions called
   `resolveIsland()` first. With 100 wood held and 2,932/h pending, the preview
   refused a deposit the action accepted.
4. **Validation.** Adding `Number()` without validating turned a malformed
   request into *"you have no stake"* — the coercion fix **created** the next
   misleading error.

> **Sharing a code path guarantees both sides agree about the maths. It
> guarantees nothing about the state each side feeds in.** Test the seam, not
> just the shared function.

The same shape recurs wherever a value enters the system from outside. The
pool clamps `feeBps` and `maxOutFrac` because an unvalidated negative fee pays
traders to trade; a later feature added a building-level cap read from an
environment variable and did **not** validate it, so `MAX_BUILDING_LEVEL=abc`
gave `NaN` and `target > NaN` silently disabled the cap entirely, while `0`
blocked every upgrade in the game. Same lesson, third occurrence: **validate at
every entry point, not at the one you happened to think of.**

### Family C: assertions that passed for the wrong reason

Eight, all in tests written by the same author as the code. Every one was
caught by mutation testing or review, none by reading:

- summing wood + stone + gold as a "value" — a swap trades few of a dear
  resource for many of a cheap one, so the unit count falls while the pool is
  worth more. The honest LP invariant is `√k` per share.
- a deposit test using equal amounts, so the tightest leg was also the last
  iterated and `min` was indistinguishable from `last`
- four dereferences before existence checks, each aborting the whole run with a
  `TypeError` instead of failing one assertion
- an `||` whose first clause short-circuited, concealing the reopen bug above
- a **shallow** snapshot (`{...pool}`) sharing its nested objects, so an
  in-place `reserves.wood = …` compared equal to itself
- a purity check that ran *after* the mutation it was meant to detect
- `arrive > Date.now()` read after the round trip, racing a 5-second travel
  floor
- "a shipment is in flight" matching *any* movement in a suite that reuses one
  world

**Method note:** a surviving mutant is only evidence once you have verified the
mutation actually applied. Twice a patch script asserted its way out *before
writing*, and the unmutated run was misread as a test gap. The harness now
confirms the patch landed before trusting the result.

---

## 8. State and lifecycle

```js
world.pool = {
  open: false,
  reserves:    { wood: 0, stone: 0, gold: 0 },
  seeded:      { wood: 0, stone: 0, gold: 0 },  // the floor measures against this
  totalShares: 0,
  openedAt:    null,
  feeBps: 30, maxOutFrac: 0.3, floorFrac: 0.25,
}
player.lpShares = 0
```

**Config lives in the world, not in env.** A season is then reproducible from
its archived `world.json` alone, and the pool can be opened on a running season
without an env edit — which on this deployment would require a restart flag
that has taken the site down before.

### A world always starts closed

Seeding is a deliberate act, never a side effect of creating or loading a
world. `createWorld` and `migrateWorld` do the **same** thing: produce a closed,
empty pool.

This is not fastidiousness. A previous feature (land respawn) fired from inside
`migrateWorld`, so a *client-only* release restarted the process and added 30
islands to a live season, moving the dominance threshold mid-game. Migration
backfills missing keys and nothing else — it cannot seed, reopen or reprice a
pool that exists. Asserted directly, and mutation-tested by making
`migrateWorld` seed the pool.

### The seed stake belongs to nobody

Opening mints `√(wood·stone)` shares held by **no player**. So
`totalShares − Σ player.lpShares` is permanent liquidity nobody can withdraw.
That is the point of an admin seed: players deposit on top of a base that does
not vanish when one of them cashes out.

Live values: `totalShares 9,591.66`, held by players `0`.

### Reopening resumes

Once seeded, `openPool` flips `open` back on and **does not touch reserves or
shares**. A season reset is how a pool gets seeded afresh. See Family A for
what the alternative did.

---

## 9. Build order — why it shipped in seven steps

The feature was merged in seven PRs, each independently reviewable and most of
them **unreachable in production when merged**:

| Step | What | Reachable? |
|---|---|---|
| 1 | pure maths | no — nothing called it |
| 2 | `world.pool` state, LP positions | no |
| 3 | `GET /api/pool`, read-only | read-only |
| 4 | Market-tab display | read-only |
| 5 | swap rules | no — no endpoint |
| 6 | admin open/close | admin only |
| 7a / 7b | swap endpoint; LP deposit/withdraw | **yes** |

**Across steps 1–6, review found sixteen defects — every one in code that
could not yet touch a player's stockpile.** Three resource printers, two
destroyers, a pool-poisoner, a permanently-bricking deposit, a reopen that
stranded LP positions, and assorted payload and seam bugs. Shipped as a single
"add a pool" PR, all of them would have gone live behind an endpoint.

Steps 7a and 7b — the reachable ones — added six more, all seams rather than
maths (§7, family B). **Twenty-two in review overall.** Two further defects
surfaced only once real players used it: loot printed at full float precision
(`107.20775939008854 wood`), and a capacity refusal that was arithmetically
correct but unexplainable from the screen. Neither was reachable by any test
that existed, which is the honest limit of this approach.

If you port this, port the build order too. It is the highest-leverage thing in
this document.

---

## 10. Test surface

**502 engine + 153 app checks**, of which **255 engine checks are
pool-specific**, split across five blocks:

| Block | Checks | Covers |
|---|---|---|
| `resource pool` | 87 | layer 1 maths and its guards |
| `pool state` | 25 | `world.pool`, migration, `poolOpts` |
| `pool opening` | 34 | seeding, closing, resuming |
| `pool liquidity` | 56 | deposit and withdraw |
| `pool swaps` | 53 | swapping and its refusals |

The tests are weighted toward **invariants over worked examples**, because a
market maker that can be round-tripped for profit is a resource printer and one
that can be drained to zero is a dead feature:

- a swap creates nothing; `k` never decreases
- there-and-back **and** triangular round trips both return less than they sent,
  and still lose at zero fee
- no triangular arbitrage at spot
- the cap alone does **not** stop a sustained drain; the floor does
- a deposit never moves any price, and takes exactly the wood leg asked for
- a deposit-then-withdraw round trip never returns more than it put in
- over-burning shares cannot drive the count negative
- conservation across the HTTP boundary, not only in the engine
- migration only ever **adds** keys, never rewrites one (deep-compared)
- both planners are pure — snapshot, plan, compare

Every guard is mutation-tested. Where a mutation survives, the test is
strengthened rather than the result recorded — two examples worth copying:

- *"deposit legs ignore the pool ratio"* survived because `poolAddLiquidity`
  scales to the tightest leg, so a wrong `desired` still comes out
  proportional, only smaller. The ratio assertion could not see it; the
  absolute wood leg had to be pinned.
- *"inbound shipments ignored"* survived on the withdraw path, and needed
  **three** cases — one that blocks, one arriving too late to count, one to
  another island. With only the first, deleting either filter still passed.

---

## 11. Porting checklist

To put this in another system:

1. **Copy layer 1 verbatim.** ~200 lines, no dependencies. Keep it pure.
2. **Decide the container for layer 2.** Whatever holds it, store the config
   with the state, not in the environment.
3. **Derive your seed ratio** by demand ÷ supply from your own economy. Do not
   copy 1 : 0.92 : 1.60. Do not use supply alone.
4. **Keep the floor.** The drain cap alone does not protect a reserve.
5. **Write layer 4 for your domain**, and decide explicitly: does a trade take
   time? does it need a location? what limits size? where does the output land
   if the recipient is full?
6. **Coerce and validate at the transport boundary**, once, in one place — and
   test the seam between preview and action, not just the shared function.
7. **Never let the client compute a price.** Have it ask, and send back a
   floor on what it will accept.
8. **Ship it unreachable first.** Steps 1, 2 and 5 above cost nothing to merge
   early and are where two thirds of the defects were found.

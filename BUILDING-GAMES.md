# Building games on the seal: an integration guide

*A pattern for games whose economy is owned by the player, not the server —
sealed to a nostr key, anchored to Bitcoin, and spendable across apps that never
talk to each other. This document is written so another agent can build a **new**
game (or a new venue) on the same stack. Everything here is live on testnet4;
none of it is aspirational.*

**The spec is [TRAIL.md](TRAIL.md).** This guide is the tour; the spec is the
law. Where they disagree, the spec wins — section references below point into it.

The reference implementations:

| repo | what it is | branch/host |
|---|---|---|
| [tideholm](https://github.com/melvincarvalho/tideholm) | the reference game (a browser strategy game) | `gh-pages`, served at `nostr.social/tideholm/` |
| [tidegate](https://github.com/melvincarvalho/tidegate) | the seal library (ESM, browser+node) | `gh-pages`, `melvincarvalho.github.io/tidegate/` |
| [tavern](https://github.com/tide-games/tavern) | provably-fair wager maths + the first venue | `gh-pages`, `tide-games.github.io/tavern/` |
| [regatta](https://github.com/tide-games/regatta) | the second seal-wired venue (a boat race) | `gh-pages`, `tide-games.github.io/regatta/` |
| [tide-games](https://tide-games.github.io/) | the fleet lobby (passes `?did=&seal=&return=` through to each boat) | `gh-pages` |
| [blocktrails](https://www.npmjs.com/package/blocktrails) | the chained-tweak Bitcoin anchoring crypto | npm `blocktrails@0.0.11` |

> **Everything is gh-pages / static where it can be.** Libraries are plain ESM
> imported from a URL; the only server is the game's own small HTTP process.
> No build step, no framework, no dependency beyond `@noble`/`@scure` crypto.

---

## 1. The core idea

A player has one **secp256k1 keypair**. Because nostr and Bitcoin taproot share
that curve, the *same key* is simultaneously:

- a **`did:nostr`** identity (the x-only pubkey),
- a **Bitcoin address** (the pubkey used directly as a P2TR witness program),
- a **signer** for balance moves and for Bitcoin transactions,
- a **NIP-98** HTTP authenticator.

The player's spendable balance is not a number in your database. It is a
**trail**: an append-only list of signed transitions

```
{ did, prev, delta, next, sig, pubkey }
```

where `sig` is BIP-340 Schnorr over `sha256("tidegate/1|<did>|<prev>|<delta>|<next>")`.
Your server *stores and mirrors* the trail; it cannot forge it. The player's real
balance is `trail[last].next`. Any app that can verify a Schnorr signature can
honor the same balance — which is what makes the economy cross-app.

Three properties fall out, and they are the whole point:

1. **Ownership** — the key holder, not the app, controls the balance.
2. **Portability** — many apps read/advance one trail under one identity.
3. **Auditability** — the trail can be anchored to Bitcoin and verified by
   strangers with no login.

---

## 2. The pieces you consume

### tidegate (the seal library) — `melvincarvalho.github.io/tidegate/`

Import what you need from the URL (browser) or npm (node). Exports:

| import | gives you |
|---|---|
| `tidegate` | `createTidegate`, `trailBackend`, `transitionBytes` — the core state machine |
| `tidegate/keys` | `keySigner()` — reads a 64-hex nostr key from `localStorage` (prompts once), returns `{ pubkey, sign }` |
| `tidegate/btc` | `taprootAddress(pubkeyHex, 'testnet'|'mainnet')` — the address a key controls |
| `tidegate/anchor` | `previewAnchor(did, trail)`, `anchor(did, trail)` — build/sign/broadcast a BlockTrails anchor in the browser; `previewSweep`/`sweep` — close a chain by spending its tip mark back to the base address ([TRAIL.md §7.4](TRAIL.md#74-chain-lifecycle-closed-retired-re-genesis-normative)). `anchor` also *detects* a swept chain (tip outspent) and re-geneses onto a fresh chain by itself — callers get `{ chain, regenesis }` back |
| `tidegate/nip98` | `nip98Fetch()` — a `fetch` that adds a NIP-98 auth header signed by the key |
| `tidegate/store` | `memStore`, `localStore` — where a trail lives |
| `tidegate/pod` | `podStore({ authFetch, base })` — a trail in a Solid pod (durable, cross-device; needs routing) |

The transition-signing convention is stable and small — you can reproduce it in
any language:

```js
import { transitionBytes } from 'tidegate';           // or inline the format
const t = { did, prev, delta, next: prev + delta };
t.sig = await signer.sign(transitionBytes(t));        // BIP-340 over sha256(bytes)
t.pubkey = signer.pubkey;                             // x-only, == did's hex
```

### tavern (provably-fair wagers) — `tide-games.github.io/tavern/`

`tavern.js` is **pure**: no DOM, no clock, no network, no crypto — the caller
supplies hashes as hex. It is designed to be **lifted into a server unchanged**
(the game vendors it verbatim). Public API:

- `rollFromHash(hex, sides=100)` → a roll `1..sides`, deterministic.
- `quote(target, stake, {edgeBps})` → `{ chance, multiplier, payout, risk }` for
  "roll strictly above `target`".
- `settle({ bankroll, target, stake, roll })` → the outcome + new bankroll.
- `maxStake`, `bankrollAdd/Remove`, `shareValue` — an LP-share house bankroll
  (providers deposit, the edge accrues to them — a market wearing a house's hat).
- `verifyRound({...})` → checks a commit–reveal round.

Two fairness modes ship on the page: classic **commit–reveal** (needs a trusted
committer) and **the Tide** (seed = the hash of the *next* Bitcoin block; nobody
holds it, so even a static page is fair). Prefer the Tide for trustless venues.

### blocktrails — the anchoring crypto

Used as a **library** (`blocktrails@0.0.11`, browser entry via esm.sh). The CLI's
built-in network host is dead; drive the library and do network I/O yourself via
`mempool.space/testnet4`. `tidegate/anchor` already does this — you rarely touch
blocktrails directly.

---

## 3. The three server endpoints a game exposes

A game that consumes the seal needs to serve exactly these (see
`tideholm/app.js` for the reference; the game keeps `pegged` = the mirrored
sealed balance on each player):

### `GET /api/tidegate/trail` — read the signed trail
Session-scoped. Returns `{ trail: [...] }`. The player and any app under the same
did read it to know the balance and history.

### `POST /api/tidegate/anchor` — record an on-chain commitment
The browser (via `tidegate/anchor`) signs and broadcasts a BlockTrails anchor,
then reports `{ commitment: { seq, txid, address, network, amount } }`. The
server stamps it onto the trail tip — seq-checked, once per tip. **The server
never sees key material**; anchoring is non-custodial.

### `POST /api/tidegate/sync` — redeem a courier slip
The one place *external* moves change the balance. Body: `{ transitions: [...] }`.
The server MUST:

1. **Verify every Schnorr signature** server-side (fail closed — no verifier, no
   sync). `@noble/curves` `schnorr.verify(sig, sha256(bytes), pubkey)`.
2. **Validate the chain**: starts at the current balance, `next === prev + delta`,
   never below zero, `pubkey` *is* the did, ≤ N moves per slip.
3. **Be idempotent**: skip any transition whose `sig` is already on the trail (a
   slip may be re-presented; a stale head must not poison a new tail).
4. **Gate positive deltas** — see §5. Money *entering* from outside must be
   provable, not merely signed.

Two public, CORS-open exports complete the set:

### `GET /api/tidegate/blocktrails/<pubkey>/blocktrails.json`
No session. Returns the trail's anchor stamps as a
[blocktrails.json](https://blocktrails.org/verify/) document, so **anyone** can
verify the marks against Bitcoin on a page you don't run. `pubkeyBase = "02"+npub`
(even-Y convention), `txo:` URIs carry `?amount=`. This is the demystifier: a
player's proof becomes one click of green checkmarks. Note it is a **projection
of the latest chain**, not the whole history — a swept-and-re-genesed trail
serves only the current epoch's marks, per
[TRAIL.md §7.5](TRAIL.md#75-the-public-projection-normative).

### `GET /api/tidegate/trail/<pubkey>/trail.json`
No session. The full signed trail itself — every transition with its signature,
plus anchor stamps. Where `blocktrails.json` lets a stranger verify the *marks*,
this lets a stranger verify the *money*: replay the chain, check every Schnorr
signature, recompute every balance. Serve both; they answer different questions.

---

## 4. The player's lifecycle (what to build UI for)

```
island/game gold ──▶ [your raid-safe store] ──peg in──▶ SEALED BALANCE (trail)
                                                          │
   the trail is the balance, keyed to the did:nostr key   │
                                                          ├─▶ VENUE stakes it (tavern, shop, …)
                                                          ├─▶ ANCHOR ⚓ notarizes it on Bitcoin
                                                          └─▶ peg out ──▶ back into the game
```

- **Peg in / out**: move game gold to/from the sealed balance. Each move is a
  signed transition (client signs, server records + mirrors `pegged`). Cap
  peg-out at what was pegged in, so no game gold is minted.
- **Fuel gauge**: derive the taproot address from the did (`btc.taprootAddress`)
  and show its testnet4 balance (from mempool.space). This is the fuel anchoring
  spends. Fetch lazily (on view-open + manual refresh), never in a poll loop.
- **Anchor ⚓**: two clicks — `previewAnchor` (keyless: shows what will be spent),
  then `anchor` (signs + broadcasts). A small float (~10k sat) rides the trail;
  change returns to the base address. Prior anchor states reconstruct from the
  trail's own stamps: **npub + trail ⇒ every address, forever** — no side file.
- **verify ↗**: link to `blocktrails.org/verify/?uri=<your blocktrails.json>`.
- **Chain lifecycle** ([TRAIL.md §7.4](TRAIL.md#74-chain-lifecycle-closed-retired-re-genesis-normative)):
  a chain **closes** when its tip mark is spent — deliberately via `sweep` (the
  float sails home to the base address), or by any wallet spend. Closure is
  **detected, not notified**: the next `anchor` call sees the outspent tip and
  starts chain `N+1` from the base address (*re-genesis*) with no coordination.
  Display `chain N · seq M` so a retired chain reads as history, not loss —
  the balance lives in the trail; only the notary chain rolls over. The whole
  lap (anchor → sweep → detect → re-genesis) is exercised live on testnet4.

---

## 5. The courier pattern — value between apps with no backchannel

This is how a **separate** venue (different origin, different repo, no shared
server) spends the same sealed gold. The tavern and the regatta are the two
live references; a shop, an auction house, another game would work identically.
The loop itself is normative in [TRAIL.md §6](TRAIL.md#6-the-courier-loop-normative),
and the server-side checks are its
[§6.1 seven-rung ladder](TRAIL.md#61-sync-validation--the-ladder-normative).

1. **Out** — the game links to the venue with a query string:
   `venue/?did=<did>&seal=<balance>&return=<game url>`.
2. **In the venue** — the player's purse is the sealed balance. Each stake/payout
   is a **signed transition** (same key, entered once per origin), accumulated
   into a **slip** — a chained segment in the venue's `localStorage`.
3. **Home** — the venue links back: `game/?tavern=<base64url slip>`. The player
   is the transport; no server-to-server call ever happens.
4. **Redeem** — the game reads the slip, posts it to `/api/tidegate/sync`, which
   verifies and applies it (§3).

The player is the courier; the mathematics is the trust. A new venue needs only:
read `?did=&seal=&return=`, sign transitions with the key, hand the slip back.

### The rule that keeps players honest (partly — read the caveat)

A signed transition proves *authorship*, not *entitlement*. So:

- **Negative deltas** (the player spends their own balance) — accept on signature
  alone. You can always burn what's yours.
- **Positive deltas** (money claimed *from* the game — a win, a refund) — a
  signature is **not enough**. The move must be **provable**. For a Tide bet the
  slip carries `{ height, mark, target, stake }`; the server fetches the deciding
  block, re-derives `roll = rollFromHash(sha256(blockHash|mark))` and the payout
  with `tavern.js`'s own maths, and refuses a wrong roll/payout. The ledger also
  enforces: the stake actually left the balance, and each bet credits once.

### The venue registry — how a new venue plugs in

Evidence is **venue-shaped**, and `bet.venue` names whose maths judges it
([TRAIL.md §3.2](TRAIL.md#32-bet-evidence-positive-deltas) — the normative
registry). Absent or `"tavern"` = Tide Dice (`{height, mark, target, stake}`,
deciding block `height+1`, win = roll > target). `"regatta"` = the boat race
(`{venue, height, mark, boat, stake}`, boat 0–4, deciding block `height`
itself, win = `winnerIndex(roll) === boat`, payout from the regatta's own
`quote`). An **unknown venue is refused outright**: no venue, no credit.

Adding your venue to a house is therefore three moves, all small:

1. **Keep your maths pure** — a no-DOM, no-network module (like `tavern.js` /
   `regatta.js`) that derives winner and payout from hex hashes alone.
2. **Stamp your evidence** — every positive delta in your slips carries
   `bet: { venue: '<yours>', height, mark, ...your fields }`, enough for a
   stranger to re-derive the win from the deciding block.
3. **Ask the house for a dispatch arm** — the house vendors your pure module
   verbatim and adds one `case` to its sync: re-derive, compare, refuse on any
   mismatch. The registry in TRAIL.md §3.2 is the source of truth for shapes.

> ⚠ **Known limitation (tideholm #154).** The current check verifies a win's
> *arithmetic*, not that the bet was committed *before its seed existed*. The
> player picks both the block height and the mark, so they can pick an
> already-mined block and brute-force a winning mark — a deterministic self-mint.
> The real fix requires the stake to be **witnessed on-trail before its deciding
> block is mined** (a server round-trip at bet time; stake and payout in
> separate slips; `stake.at < block.time`). Until then, treat positive-delta
> redemption as *bar-raised, not trustless* — fine for testnet with cooperating
> players, not for real value. **A new game must implement the §5 timestamp rule
> before it matters.**

---

## 6. Conventions and invariants (copy these exactly)

- **Signing**: BIP-340 Schnorr over `sha256("tidegate/1|did|prev|delta|next")`.
  The `pubkey` field is x-only and equals the did's 64-hex.
- **Even-Y base**: the anchor chain derives from `02||x` of the x-only pubkey;
  the privkey is parity-normalized to match. This is what makes the whole trail
  derivable and verifiable from the npub alone.
- **Anchor tip**: the state a mark commits to hashes the trail's *canonical*
  fields (`did, prev, delta, next, sig, pubkey, at`) — **exclude** operator
  stamps like `commitment`/`bet`, or anchoring invalidates its own tip.
- **The float**: an anchor from the base address carves a small float and returns
  change to base; tip-to-tip anchors forward the whole float. Amounts are
  irrelevant to the BlockTrails proof — only the spend chain matters.
- **Idempotency**: identify an applied move by its `sig` string (unique per
  signing). Re-presented slips must no-op, never double-apply.
- **Fail closed**: if the signature verifier or the chain reader is unavailable,
  **refuse** (500/502) — never apply on trust.
- **Rate/network discipline**: chain reads (fuel, block hashes) are cached and
  fired only on user actions, never from a poll loop. mempool.space is CORS-open
  for testnet4; block hashes are immutable (cache forever), tip height is not
  (cache ~30s).

---

## 7. A minimal new game, start to finish

1. **Identity** — let players link a `did:nostr` (paste the 64-hex pubkey). Key
   the player by the did. Provide a raid-/loss-safe store for in-game currency.
2. **Peg** — endpoints to move currency ↔ sealed balance, each a signed
   transition; mirror the balance server-side, cap withdrawals so you never mint.
3. **Serve the four endpoints** of §3 (`trail`, `anchor`, `sync`, the public
   `blocktrails.json`). Reuse tideholm's `game.js` `tidegate*` functions and
   `app.js` handlers almost verbatim.
4. **Client** — import `tidegate/keys`, `tidegate/btc`, `tidegate/anchor` from
   the gh-pages URL; wire peg buttons, a fuel gauge, an Anchor ⚓ button, and a
   verify ↗ link.
5. **A venue (optional)** — either add a courier link out to an existing venue,
   or build your own that reads `?did=&seal=&return=`, signs transitions, and
   hands a slip back. If it grants positive deltas, register its evidence shape
   (§5's venue registry / TRAIL.md §3.2) — and mind the timestamp caveat.
6. **Verify** — anchor once and open your `blocktrails.json` in
   `blocktrails.org/verify`. Green marks mean you did it right.

That is the whole surface. One keypair, one trail, one chain, a few static
libraries, and a small server that mirrors and verifies. No custodians.

---

## 8. Honest status

Testnet4 only. Trails currently live in browsers + the game server; the pod store
(durable, cross-device) is built but awaiting routing. Single-writer discipline
(one trail, concurrent apps) is not yet enforced. Positive-delta authorization is
bar-raised, not trustless (#154). A real house bankroll on-trail is designed
(`tavern.js` has the maths) but not wired. None of these block a **demo**; all of
them block **real value**. Build accordingly, and keep your claims as honest as
your code — when a boundary isn't airtight, say so in the boundary itself.

What *has* been exercised end-to-end on testnet4, by a real player in a browser:
peg-in, venue stakes at two origins (tavern and regatta, including a sealed
regatta bet redeemed through the venue dispatch), anchoring, third-party
verification, sweep, retirement detection, and re-genesis onto chain 2. The
full lap of [TRAIL.md](TRAIL.md) §5–§7 is lived code, not paper.

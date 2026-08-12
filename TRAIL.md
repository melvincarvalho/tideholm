# The Trail — sealed gold's signed, Bitcoin-anchored ledger

This document specifies the **Trail**: the per-player, identity-keyed ledger
that lets gold leave Tideholm's vault, be staked in other applications, and
come home — with every movement signed by the player's own key and the
history anchored to Bitcoin. It is written to the same standard as `AMM.md`:
enough detail to **reimplement, port, or attack it**, with every known
weakness named in-line rather than discovered later.

Terminology: the system has been called "the seal" / "sealed gold" in UI and
code (`pegged`, `?seal=`, `err.sealSync`). This spec uses **Trail** for the
ledger and keeps *sealed balance* for the number it tracks. Wire names are
unchanged — renaming a live protocol is churn, not clarity.

Tracking issues: #135 (phases), #140 (anchoring), #146 (courier), #149/#153
(provable wins), **#154 (the open trust boundary — see §8)**.

Status of each section: **[NORMATIVE]** — implemented and required;
**[CURRENT]** — implemented, may evolve; **[OPEN]** — specified intent,
not yet enforced.

---

## 1. One paragraph

A player's gold can move from their **vault** into a **sealed balance**
(peg-in), be carried into any fleet game as a query string, staked there
through transitions **signed in the player's own browser with their nostr
key**, carried home as a **slip**, and redeemed back — ultimately to the
vault (peg-out). The ledger of every movement is the **trail**: an
append-only chain of signed transitions whose tip is periodically **anchored
to Bitcoin** by key-tweaked taproot outputs, each anchor spending the
previous one. The server keeps the books; the player keeps the proof; Bitcoin
keeps the order.

## 2. Identity [NORMATIVE]

Everything is keyed to a `did:nostr:<x-only-pubkey-hex>` (64 lowercase hex
chars). The same secp256k1 key is:

- the **signer** of every transition (BIP340 Schnorr),
- the **base point** of the anchor chain (`pubkeyBase = 02||x`, the even-Y
  convention — the whole expected anchor sequence is derivable from the npub
  alone),
- the player's identity across every app in the fleet.

Only identity-keyed players can sync slips (`tidegateSync` refuses a player
with no `nostrDid`).

## 3. The transition [NORMATIVE]

The atomic ledger entry — one signed movement of sealed gold:

```json
{
  "did":    "did:nostr:<hex>",
  "prev":   1296,          // sealed balance before
  "delta":  -50,           // signed integer, never 0
  "next":   1246,          // must equal prev + delta, never negative
  "sig":    "<128 hex>",   // BIP340 Schnorr, see below
  "pubkey": "<64 hex>",    // x-only, must match the did
  "bet":    { ... }        // REQUIRED on positive deltas; see §3.2
}
```

### 3.1 Signing convention

The signature is BIP340 Schnorr over `sha256` of the canonical transition
bytes — a pipe-joined string, **protocol-versioned**:

```
tidegate/1|<did>|<prev>|<delta>|<next>
```

Everything else — `bet`, timestamps, commitments — rides **outside** the
signature. Deliberate: `bet` is not a claim, it is a pointer to public chain
data from which a verifier re-derives the outcome itself (§6.2); stamping it
into the signature would add nothing but coupling.

### 3.2 Bet evidence (positive deltas)

A positive delta is money claimed **from** a game, so a signature alone is
insufficient — the player signs their own transitions and could sign
themselves rich. Every positive delta must carry:

```json
"bet": { "height": 148067, "mark": "<≤64 chars>", "target": 49, "stake": 50 }
```

from which the house re-derives the deciding block hash, the roll, and the
payout, refusing anything that does not reproduce exactly (§6.2). Negative
deltas carry no evidence — they are money the player chose to stake; the
trust boundary for them is the player's choice of game (§8, T7).

**Venues.** `bet.venue` names which house maths re-derives the win: absent
or `"tavern"` = Tide Dice (`{height, mark, target, stake}`, deciding block
`height+1`, win = roll > target); `"regatta"` = the boat race
(`{venue, height, mark, boat, stake}`, boat 0–4, deciding block `height`
itself, win = `winnerIndex(roll) === boat`, payout from the regatta's own
`quote`). Both share the roll convention — `sha256(blockHash|mark)`, BigInt
mod space — and both maths are vendored pure modules (`tavern.js`,
`regatta.js`) in the house. An unknown venue is refused outright: no venue,
no credit. Each new seal-ready game adds one dispatch arm and its vendored
maths — this list is the protocol registry.

## 4. The trail document [NORMATIVE]

Server-side, one file per identity: `tidegate/<hex>.json` — a JSON array of
transitions in order. Derived facts:

- **balance** = `next` of the last entry (mirrors the authoritative
  `player.pegged` at all times — see §5.2's soft-record rule for the one
  permitted divergence),
- **seq** = array length,
- **tip** = the last entry.

Anchored tips additionally carry a `commitment` (§7.2). The trail is served:

- authenticated, in full: `GET /api/tidegate/trail` (the player's own copy —
  "the KISS stand-in for reading a pod; the doc shape is identical"),
- public, as a projection: `GET /api/tidegate/blocktrails/<hex>/blocktrails.json`
  (§7.5) — only anchored marks, for third-party verification.

## 5. Peg-in and peg-out [CURRENT]

The vault side of the boundary. Both directions are **server-authoritative
money moves with client-signed recording**:

```
POST /api/vault/pegin   { islandId, amount, transition }
POST /api/vault/pegout  { islandId, amount, transition }
```

### 5.1 The money move

`vaultPegIn`: requires `amount ≤ vault`; then `vault -= amount`,
`pegged += amount`. `vaultPegOut` is the mirror with `amount ≤ pegged`.
Integers only; both floor their inputs. The vault itself is out of scope here
(it is ordinary game state); the peg is where gold changes *kind*.

### 5.2 The soft-record rule

After the money moves, the client's signed transition is offered to
`tidegateRecord`, which accepts it only if it is internally consistent
(`next === prev + delta`), **lands exactly on the post-move `pegged`**, and
**chains onto the stored trail** (`prev` equals the previous tip's `next`,
or `pegged − delta` for a first entry). The stored record keeps the client's
own `prev/delta/next` — the exact values the signature commits to — because
re-stamping would orphan the signature.

A failed record is **soft**: the peg has already moved the money and is never
failed retroactively; only the trail lags. ⚠ Consequence: the trail is
*evidence*, not the *authority* — `player.pegged` is authoritative, and a
player who submits garbage transitions degrades only their own proof. An
unsigned or absent transition leaves a gap a later anchor cannot paper over.
**[OPEN]** — whether peg endpoints should *hard-require* a valid transition
once clients are stable (flag day), so trails are gap-free by construction.

## 6. The courier loop [NORMATIVE]

How sealed gold visits another app and comes home. The flow that already
carries real (testnet) value through the tavern:

```
Tideholm ──?did=&seal=&return=──▶ fleet lobby ──(query passed through,
                                       unparsed)──▶ chosen game
    ▲                                                   │
    │                                    player signs stakes/payouts
    │                                    in-browser (same nostr key)
    └────── ?tavern=<b64url signed transitions> ◀───────┘
                    POST /api/tidegate/sync
```

- **Out** — the link carries `?did=` (identity), `?seal=` (current sealed
  balance, prefill only — *never trusted on return*), `?return=` (the way
  home). The lobby (tide-games.github.io) re-attaches the query string to
  every game link and interprets **nothing**: the contract lives at the two
  ends, with zero implementations in the middle. Games without courier wiring
  ignore the params harmlessly; the lobby's ⚓ *seal-ready* badge marks the
  ones that understand them.
- **In the game** — the game keys local state by did, starts from the `seal`
  prefill, and every purse change is a fully-formed transition signed via the
  player's key (prompted once per origin). The game never holds the key and
  never talks to Tideholm directly.
- **Home** — the player carries the slip (base64url JSON array of
  transitions) back; **the player is the transport**. Pods later change
  *where* the trail lives, not this shape.

### 6.1 Sync validation — the ladder [NORMATIVE]

`POST /api/tidegate/sync` is **the one place external moves change
`pegged`**, so it is fail-closed at every rung:

1. **Bounds**: 1–50 transitions per slip ("a slip is a session, not a
   firehose"). Verify *exactly what will be applied — never a subset*.
2. **Signatures**: every transition Schnorr-verified against the canonical
   bytes (§3.1). Verifier library unavailable → refuse the slip (500),
   *never* trust.
3. **Idempotence**: transitions whose `sig` already appears on the trail are
   skipped — signatures are unique per signing, so the sig string identifies
   the exact applied move. This both tolerates re-carried slips (the game
   cannot know a slip was accepted — different origin) and closes the replay
   hole where an old winning slip is re-sent when the balance happens to
   line up again.
4. **Chain**: the slip must chain exactly from the current `pegged`
   (`prev` → `next = prev + delta`, integers, never negative, `did` and
   `pubkey` matching the player).
5. **Provable wins** (#149/#153): every positive delta's `bet` is re-derived
   from the chain — fetch the hash of block `height+1`, recompute
   `sha256(blockHash|mark)` → roll, and require the roll to beat the target
   and the payout to equal the delta, using the house's own vendored maths.
   Unreadable chain → 502, retry, never trust. No such block → refuse.
6. **Ledger rules**: the stake must actually have left the seal (a matching
   negative transition with the same bet tuple exists on the trail), and
   each bet credits **once**.
7. **All-or-nothing**: any rung fails → the whole slip is refused; otherwise
   transitions apply stepwise so every move lands on the trail with the
   mirror (`next === pegged`) intact.

### 6.2 What sync does *not* prove — the #154 hole [OPEN]

Rung 5 checks the **arithmetic** of a win, not that the bet was committed
**before its seed existed**. The player picks both the block height and the
mark, so they can pick an already-mined block and brute-force a mark that
wins — a deterministic self-mint. Closing it requires the stake to be
**witnessed on-trail before its deciding block is mined** — a server
round-trip at bet time (or an anchored stake mark). Until then the courier
loop is *accounting-sound but not trustless*: fine for testnet-with-friends,
and the reason every fleet surface says "play money" or "testnet". This is
the single highest-value open item in the platform.

## 7. Anchoring [CURRENT]

### 7.1 What an anchor is

An anchor commits the trail tip to Bitcoin (testnet4 today) as a
**BlockTrails state advance**: spending the previous anchor's output to a
freshly derived taproot address **is** the commitment. The committed state is
a canonical string in **literal key order**:

```json
{"app":"tideholm","did":"<did>","seq":<n>,"tip":"sha256:<hex>"}
```

- `seq` — number of signed transitions at anchor time,
- `tip` — sha256 of the **canonical, commitment-free** trail view: exactly
  the signed fields, fixed key order. (Commitment stamps are excluded so
  stamping an anchor onto the trail does not change the hash it anchored.)

The state string is hashed to a scalar tweak; anchor *n*'s address derives
from `pubkeyBase` plus the **sum of all tweaks so far** (the reference
BlockTrails recipe — "never hand-rolled, so a BlockTrails verifier accepts
what we write"). No OP_RETURN, no on-chain data: **the address is the
commitment**, and a divergent history for the same `(did, seq)` would need
to double-spend a UTXO — refuted by Bitcoin itself.

### 7.2 The stamp [NORMATIVE]

However the anchor is made (§7.3), the server records it via
`tidegateStamp`, guarded: txid must be 64 hex; `seq` must equal the current
trail length (the tip the client actually anchored — a stale anchor is
refused); **one stamp per tip**; address restricted to the bech32m charset;
`vout` is always 0 by the anchor convention ("the trail float is always
output 0"). The stamp is metadata on the tip entry:

```json
"commitment": { "network": "tbtc4", "seq": 4, "txid": "<64 hex>",
                "address": "tb1p…", "amount": 546, "vout": 0,
                "explorer": "…", "at": 1755000000000 }
```

⚠ The server records the *claim* and does not itself check the chain — the
public verifier does (§7.5). A false stamp thus pollutes only the claimant's
own public trail, where it visibly fails verification. **[OPEN]** — the
server could cheaply confirm the txid exists before stamping.

### 7.3 Who anchors, when

Two implementations, one convention:

- **Browser, non-custodial** (#140): the page signs and broadcasts with the
  same key that signs pegs, then reports `{txid, seq, address, amount}` to
  `POST /api/tidegate/anchor`. The key never leaves the player.
- **Server CLI** (`tools/tidegate-anchor.js`): preview (keyless, derives the
  expected address and lays out the exact unsigned spend), sign
  (deterministic, aux = 0 — inspected hex is byte-identical to pushed hex),
  push. Used operationally.

**[OPEN] Cadence is unspecified.** Anchoring is currently manual and
best-effort. To make anchors *load-bearing* (§8, and any peg-out gating),
the spec must fix: anchor on every peg-out? every N transitions? on a
schedule? — and who funds the fee (the anchor chain float is sats, spent
forward each mark). Until fixed, an anchor proves history *up to its seq*
and nothing about later transitions.

### 7.4 Chain lifecycle: closed, retired, re-genesis [NORMATIVE]

A trail's anchor chain has three ends, only one of them final:

- **closed** — sealed balance 0 and the tip anchored: a complete episode
  (0 → activity → 0), verifiable forever, chain still able to advance.
- **retired** — the tip output spent by an **explicit-closure sweep** (the
  blocktrails spec's sanctioned ordinary spend; `sweep()` in
  tidegate/anchor.js, surfaced on blocktrails.org/verify/advanced). No
  future anchor can spend forward. History stays readable and verifiable;
  only the ability to advance ends.
- **re-genesis** — anchoring after a retirement starts **chain n+1** from
  the base address (a fresh float carve), stamped with `chain: n+1` on its
  commitment (missing = 1).

Rules that make this verifiable from public data alone:

1. **Key accumulation restarts per chain** — only the current chain's
   states sum into the next address. The *state strings* never reset: `seq`
   keeps counting the whole trail, so committed content stays linear across
   chains.
2. **Retirement is detected, never reported.** The anchor tooling checks
   the tip's outspend before advancing: spent → re-genesis. The sweep never
   phones home; Bitcoin is the shared source of truth, and every surface
   (Tideholm's Tidegate box included) reads it independently.
3. **One blocktrails.json = one linear spend chain**: the projection (§7.5)
   serves the latest chain's marks only. Earlier chains remain in the full
   trail.json — confirmed forever, just no longer the live spine.
4. Edge: an anchor that broadcast but was never stamped also reads as
   "tip spent" — re-genesis branches past it and the orphaned mark simply
   never enters the projection. Accepted; the alternative (trusting the
   server's stamp over the chain) inverts rule 2.

### 7.5 The public projection [NORMATIVE]

`GET /api/tidegate/blocktrails/<hex>/blocktrails.json` — the shape
`blocktrails.org/verify` consumes (the route also answers the bare `<hex>.json`
spelling; the directory form exists because the verifier appends
`blocktrails.json` to any uri not ending in it — #152):

```json
{ "@type": "Blocktrail", "version": "0.0.3", "profile": "tidegate",
  "pubkeyBase": "02<hex>", "chain": "tbtc4",
  "states": ["tideholm seq 4 · sealed 1296 🪙", …],
  "txo":    ["txo:tbtc4:<txid>:0?amount=546", …] }
```

Only anchored marks appear; no anchors → 404 (`null`). ⚠ The `states`
strings are **display captions, not commitments** — what a mark actually
commits to is §7.1's canonical state object. A verifier that re-derives
addresses (§9) proves the binding; today's verifier proves existence,
confirmation, amount, and (it should — see §9) the spend chain.

The **full trail document** is also public, deliberately:
`GET /api/tidegate/blocktrails/<hex>/trail.json` →
`{ "@type": "TidegateTrail", "did", "trail": [ …every stored transition,
stamps included… ] }`. This is what re-deriving verifiers and lifecycle
tooling (sweep, top-up) consume — npub + this document reconstruct every
anchor address. Publishing it exposes the complete signed history including
bet evidence; that is the design (wins are *publicly* provable), decided
2026-08-12.

## 8. Threat model

| # | Threat | Defense | Status |
|---|--------|---------|--------|
| T1 | Forged transition (wrong key) | Schnorr verify on every sync transition, fail-closed; pubkey must match did | **closed** |
| T2 | Replayed slip / double-credit | sig-string idempotence set; credit-once ledger rule per bet tuple | **closed** |
| T3 | Fabricated win (arithmetic) | house re-derives roll + payout from the named block (#149/#153); stake-was-paid rule | **closed** |
| T4 | **Self-mint via chosen seed** — pick a mined block, brute-force a winning mark | needs stake witnessed on-trail *before* the deciding block exists | **OPEN — #154** |
| T5 | Divergent / rewritten history | anchor chain: same (did, seq) twice ⇒ double-spend; append-only spine | **closed** *up to the last anchored seq*; unanchored tail is server-word-only (⇒ §7.3 cadence) |
| T6 | Reorg of a deciding block | sync fetches by height at redeem time; regatta/tavern settle at 1 conf | **partial** — #154's rule must pin *confirmed* blocks; a redeem during a reorg window could pay on an orphaned hash |
| T7 | Malicious game drains the visiting purse | none in-protocol: negative deltas need no counterparty evidence — by design (a stake *is* a chosen loss). Boundary = the player's choice of venue; the lobby's curated ⚓ seal-ready badge is the practical control | **accepted risk** (documented) |
| T8 | Malicious lobby rewrites params | lobby interprets nothing, but a hostile *page* could; `?seal=` is prefill-only and never trusted on return — worst case is a wrong display | **closed** (money-wise) |
| T9 | False anchor stamp | verifier catches it publicly; server-side existence check | **partial** (§7.2 OPEN) |
| T10 | Trail/books divergence via soft-record | `pegged` stays authoritative; player degrades only their own evidence | **accepted** until §5.2's flag day |
| T11 | Stolen nostr key | out of protocol scope — the key *is* the identity; same blast radius as any key custody | **out of scope** |

## 9. Verification, third-party

Anyone, from the public projection alone:

1. fetch `blocktrails.json`, check every txo exists, is confirmed, amount
   matches — *and that each mark spends the previous* (the spine; a verifier
   that displays but does not enforce this is not verifying a trail),
2. **[OPEN — re-derivation]** rebuild the canonical state objects from a
   presented trail, recompute the tweak chain from the npub, and require each
   mark's output address to equal the derived P(n) — upgrading "the spine is
   intact" to "the spine provably carries *these* books",
3. re-derive any win from its bet tuple exactly as sync does (§6.1 rung 5) —
   the maths is public in every game repo.

The reference web verifier lives at `blocktrails.org/verify` (repo
`blocktrails/verify`); its own hardening list is tracked there.

## 10. Testability [OPEN — the extraction]

The enforcement logic today lives inside `game.js` (ledger rules) and
`app.js` (crypto + evidence), tested through the app's suite. To spec-grade
it, extract a **pure module** — fleet-style: no I/O, no clock, no globals —

```
trail.js: canonicalTransitionBytes(t)      // §3.1
          verifyTransition(t)               // shape + arithmetic + sig
          verifySlip(trail, pegged, txs)    // §6.1 rungs 3,4,6 — pure part
          canonicalTrailView(trail)         // §7.1 tip hashing
          stateString(did, seq, tipHash)    // literal key order
          deriveAnchorChain(pubkeyBase, states[]) // expected addresses
```

with **golden vectors** committed beside it: a fixture trail (keys, signed
transitions, expected tip hash, expected anchor addresses, a valid and an
invalid slip). One implementation, three consumers — server sync, the future
re-derivation verifier, and any game that wants to self-check — is how the
spec and the code stay the same thing.

## 11. Display contract

What each surface must show, so UI has a contract instead of vibes:

- **Market tab (Tideholm)**: vault balance; sealed balance; the fleet-lobby
  link out (with live `?did=&seal=&return=`); the public verify link
  (`blocktrails.org/verify/?uri=…/<hex>/blocktrails.json`); redeem feedback
  (applied count / refusal, no partial application ever implied).
- **The lobby**: pass the query through, show ⚓ seal-ready only on games
  with real courier wiring, interpret nothing.
- **A seal-ready game**: the sealed balance as the purse; every stake/payout
  as a signed transition; the slip-home link; the verify link.
- **A game that is not seal-ready** (arrival strip, shipped in the regatta):
  name the arriving sealed balance; say plainly the table is practice-only
  and the seal is untouched; verify link; way home. Never show an unlabeled
  number beside the sealed one.
- **The verifier**: verified means *all* checks passed including the spend
  chain; testnet is labeled testnet; what verification does **not** prove is
  stated on the page (it already is).

## 12. Open questions (decisions this spec forces)

1. **#154 mechanics** — witness-at-bet-time: server round-trip signing the
   stake onto the trail before the deciding block? Or anchored stake marks?
   Pick one; it defines the fleet's real-money go/no-go.
2. **Anchor cadence & funding** (§7.3) — per-peg-out, per-N, or scheduled;
   whose sats fund the float.
3. **Peg-out gating** — must the tip be anchored (and confirmed) before gold
   re-enters the vault? A settlement delay is the cheap version.
4. **Soft-record flag day** (§5.2) — when do pegs start refusing absent/bad
   transitions?
5. **Concurrent games** — two open games sign from the same `prev`; the
   second slip home refuses (chain break). Working as intended, but the UX
   ("your other table moved first — reopen from the gate") needs writing.
6. **Key loss** — the trail is unrecoverable by design; say so where players
   seal, before it is true of mainnet value.

---

*Written from the code as it stands (`app.js`, `game.js`,
`tools/tidegate-anchor.js`, the tavern's courier, the tidegate library) —
every ⚠ and [OPEN] above is present in the running system, not hypothetical.
Change the code, change this file, in the same commit.*

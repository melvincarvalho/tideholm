# News

Announcements sent to players in-game, newest first, with the exact text as
delivered. Kept because an in-game report is easy to miss, easy to mark read,
and impossible to search — this is the durable copy.

Sent through `POST /api/admin/announce`, which writes one report per human
player. Each entry gives the date it went out and links to where the change
actually landed.

Below the announcements is a second list: **things that shipped without one.**
Most of them are small enough not to warrant interrupting anyone, but a player
who never heard about the keyboard shortcuts will never find them.

---

## Season 3 — opened 2026-07-20

### 2026-07-27 · Mail: link a Nostr identity

> The Mail tab now shows your captain's profile, where you can link a Nostr
> identity. With none set, "Generate a key" opens a key tool — paste back only
> the PUBLIC key, never the secret. Once linked it shows as `did:nostr` beside
> your name in mail and rankings, and "View coin addresses" lists your testnet4
> addresses with faucet links on that page. Self-declared, not verified.

The public key is the only half that belongs here — a hex secret and a hex
pubkey look identical, so the warning is not decorative. Nothing is verified:
a `did:nostr` next to a name is a claim, not proof.

Shipped in #35, #38, #41, #45. Tracking: #34.

### 2026-07-27 · The Tidepool opens

> The Market tab now has the Tidepool. Swap wood, stone and gold at a live
> price with no trading partner needed — the rate moves with what is in the
> pool, so large trades cost more. You can also deposit resources to become a
> provider and earn a share of the 0.3% fee. Goods sail from your Harbor and
> take 30 minutes.

Seeded at 10,000 / 9,200 / 16,000 — a ratio derived from the season's own
demand and supply, which prices gold **below** wood despite gold being the
scarcer thing to produce. Two protections not mentioned in the announcement: no
single swap may take more than 30% of a reserve, and no reserve may be sold
below 25% of what was seeded.

A deposit ships all three resources, so it is roughly 3.5× the wood leg and
your Harbor limit bites much sooner than it does on a swap. The error says so,
with a figure that will fit.

Shipped in #47, #48, #50, #51, #52, #54, #55. Tracking: #46. Design notes:
[AMM.md](AMM.md).

### 2026-07-27 · Buildings capped at level 14

> Buildings are now capped at level 14. Nothing already built is affected — the
> cap only blocks further upgrades. Storehouse and Harbor are the reason: at
> level 15 one storehouse would hold more than two thirds of all the wood in
> the world. Highest right now is 12.

Production was never the problem — it grows at 1.12 per level against costs at
1.55, so it slows itself. Storehouse and Harbor grow at 1.5 and their
usefulness does not diminish, which is what needed a ceiling.

Per-world rather than an environment setting, so a restart cannot move the
ceiling under a season already in progress.

Shipped in #60.

---

## Shipped without an announcement

Player-visible, but not worth a report at the time. Listed newest first.

### Keyboard shortcuts

Letter keys jump between tabs — `i` island, `m` map, `r` reports, `l`
leaderboard, `t` trade, `a` alliance, `p` post. Digits `1`–`9` switch islands,
`Esc` closes a dialog, and **`?` shows the full sheet**.

The letters are a fixed convention rather than mnemonics, because mnemonics do
not survive translation: Map is *Karte*, Reports is *Berichte*. The `?` sheet
and the help pages both list them.

Shipped in #33.

### Sound

A war drum for an incoming attack, a note for a new report, a ding for mail, a
bell when a building finishes, a chime on a quest. One 🔊 toggle beside the
theme button turns the lot off, and the setting sticks.

Shipped in 55a014d.

### Islands dock

The strip along the bottom. Newest-first so your founding island stays anchored
at the left, arrow keys and a swipe on the header to move between them, and you
can pin the ones you actually use to the front.

Shipped in 2fc7a67, 9679da0, #29.

### Season Chronicle

Each finished season gets a permanent page, linked from its line in the Hall of
Fame. Shipped in ac5502f.

### Fixes you may have noticed

- Shipments carrying a fractional amount printed the full float — a delivery
  once read `107.20775939008854 wood`. Now floored for display; the exact
  amount still arrives. (#57)
- Every shipment in the movements list said "Returning to", whatever it was.
  (#31)
- The build queue table jumped between two and three columns while
  countdowns ticked. (#25)

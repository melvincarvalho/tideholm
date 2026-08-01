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

## Season 4 — opened 2026-07-29 16:30 UTC

Four announcements, all sent. Text below is what players actually received,
which differs from the drafts: the endpoint caps at 500 characters and reports
are plain text, so markdown emphasis and `×` became prose and `x`.

### 2026-07-31 04:29 · Colony Ships get dearer as you spread

> Each Colony Ship now costs more than the last: 1.3x per step along your
> expansion. The 10th is about 29,000 all-in instead of 2,700; the 15th about
> 106,000. Your position counts islands you hold PLUS every ship already paid
> for, so ordering one at a time costs exactly the same as ordering a batch.
> The train screen shows the real price for the number you type. Going wide is
> not stopped — it is priced.

Position counting ships as well as islands is the fix for a real hole: counting
islands alone let a player split orders for a 25% discount, and the in-code
comment claimed the opposite. Two blockers had to clear first — the knob had no
upper bound (#61), and the train form quoted a single-ship price for a batch
that charges stepped, under-quoting by 4.3× at ten ships (#62).

Shipped in #43. Enabled by #68. Tracking: #27.

### 2026-07-31 04:29 · Support costs your home island's population

> Troops you station on another player's island now keep using the population
> of the island that trained them, from the moment they sail until you recall
> them. Helping an ally is a real cost: sending troops away no longer frees
> room to train more at home. Attacks are unaffected. Moving troops to your OWN
> island was always a transfer — they join that garrison and use its
> population, as before.

The rule Tribal Wars and Travian have always had. Without it, population capped
how fast you could train but not how much you could hold: train to cap, ship
out, train again, forever.

One correction to the issue that prompted it: supporting your **own** island was
never the loophole — those troops land in the garrison and consume its
population. The exploit needed two players supporting each other.

Shipped in #65. Tracking: #40.

### 2026-07-31 04:09 · Merchant slots

> Your Harbor now provides merchants — one per level. Each shipment takes one
> and keeps it until they sail HOME, so a delivery across the map ties a
> merchant up for twice the travel time. Watch for "Merchants returning to..."
> in your movements: that line is the reason a slot is still busy after your
> goods have landed. (It was showing as ui.move.merchant until just now —
> fixed.) Market trades take a merchant from both sides. The Tidepool does not
> use merchants at all.

Season 3 made the case better than any argument: 83 concurrent shipments were
used to funnel resources into a Great Beacon, because distance cost latency but
never throughput.

The parenthesis owns a bug players had already seen. The merchant return leg
shipped with no translation, so the movements list rendered the literal string
`ui.move.merchant`. Engine mutation testing could not have caught it — the
movement was emitted correctly, it just had nothing to render with.

Shipped in #66. Label fixed in #75. Tracking: #30.

### 2026-07-30 19:29 · The Tidepool opens

> The Tidepool is open in the Market tab. Swap wood, stone and gold at a live
> price, with no trading partner needed. It needs a Harbor — but unlike an
> ordinary shipment it does NOT use one of your merchants, so it still works
> when they are all at sea. Seeded small at 100/100/100, so large swaps will be
> capped until it deepens: deposit to become a provider and earn a share of the
> 0.3% fee. Swaps and withdrawals sail from your Harbor and take 30 minutes;
> deposits settle at once.

Seeded deliberately shallow — a tenth of season 3's opening depth relative to
the economy — so players deepen it rather than inheriting it. The consequence is
visible immediately: at 100-unit depth a 50-stone swap carries a 35% price
impact, and anything over ~43 gets capped.

Two corrections to season 3's wording. That one said "goods sail and take 30
minutes", which is wrong for deposits — they settle instantly (#67). And the
merchant exemption is new and worth leading with now that slots exist.

Shipped in #47–#55. Tracking: #46.

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

**Correction (2026-08-01, #67):** the last sentence of that announcement was
inaccurate in two directions. Nothing sails *from* your Harbor — what you send
leaves at once, and it is what you **receive** that takes 30 minutes to sail
home. And a **deposit** involves no sailing at all: it returns shares, which
are a ledger entry rather than cargo, so it settles immediately. The original
text is kept above as sent.

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

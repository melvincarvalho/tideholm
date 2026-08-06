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

## Season 5 — opens 2026-08-06 15:00 UTC

### 2026-08-06 16:45 · The Tidepool opens for season 5

> The Tidepool is open in the Market tab - swap wood, stone and gold at a
> live price, no trading partner needed. New this season: the pool sits at
> the middle of the map, and goods sail the real distance from your Harbor,
> so where you live matters. Seeded shallow at 100/100/38 - the gold side
> reflects what the mines actually make - so big swaps will be capped until
> players deepen it. Deposit to become a provider and earn a share of the
> 0.3% fee. Needs a Harbor; uses no merchant. Fair winds.

Two season-5 differences from the season-4 opening, both deliberate. The
distance term (#76) is live for the first time: the pool sits mid-map and
swaps sail at TRADE_SPEED, so the courier loophole is closed and geography
prices every trade. And the seed is 100/100/38, not 100/100/100 — the gold
reserve matches the production-implied price (rates run 40/40/15), so the
pool opens honest instead of opening with a small gold-side arbitrage.
Operator's disclosure: both humans were mid-ship-race when this opened, and
the pool mildly favours the player nearer the map centre — announced to
everyone the minute it existed, which is the point of announcements.

### 2026-08-06 16:20 · The dock drops its coordinates

> Small quality-of-life change: the islands dock at the bottom now shows just
> your islands names - the coordinates are gone from the chips. The dock is a
> switcher, not a map: you click islands by name, and the coordinates doubled
> every chips width without earning it. They are still one hover away (or a
> long-press on mobile) in the chips tooltip, and unchanged on the map, the
> island header, and the dropdown. More islands per row, calmer dock, nothing
> lost. Fair winds.

Five deleted lines (#101). The apostrophes fell out of the sent copy at the
shell boundary — "your islands names" — a smaller price than the merchant
label of #66, but the same lesson: what players received is what gets
recorded. Suggested by the season-4 dock, which at fourteen islands was
two-thirds coordinates by pixel count.

### 2026-08-06 15:08 · The season-5 opener

> Season 5 is live. New laws: Colony Ships cost x1.4 per step - the 10th is
> ~56k. The Beacon wins at level 7; the last leg needs Storehouse 13. Gold
> mines run 15/h - spend it, dont hoard it. Barbarians garrison HALF as
> hard: the farm loop is real. Troops anywhere keep using their HOME
> island's population. Respawn refuges get beginner protection. The Tidepool
> sits mid-map and goods sail real distance. Your did:nostr banner survived
> the reset - quest 9 rewards raising one. Fair winds.

Held until the audience existed: an announcement only reaches players who
exist, and a fresh world has none until each logs in. Both returning
captains appeared within six minutes of the gates opening — sent then.
Eight law changes in 486 characters; the boundary batch (NEWS.md below)
and deploy/next-season.env carry the details and the reasoning.

### 2026-08-06 14:52 · Season 4 ends: the Beacon burns over V4

> The Great Beacon burns at level 6 over V4 - season 4 belongs to melvin.
> Fourteen islands, a river of convoys, and a tower raised in the open as a
> target, so the endgame was anyone's to contest. Honours to philloster's
> eleven-island empire in the southeast, and a first flag for darren. Season 5
> opens TODAY at 17:00 CET on a fresh map with new laws - the opener that
> follows has the details. Thank you for playing season 4. Fair winds.

Sent minutes after checkVictory crowned the winner (hall of fame entry 4:
melvin, 14 of 63 islands, via wonder). The tower was announced at every
level and never drew a shot; the level-5 window stood open for a full day.
Chronicle: seasons/season-4.html.

The season-5 opener was held until the returning captains appeared — see
the entry above for the text as sent.

## Season 4 — opened 2026-07-29 16:30 UTC

Seven announcements, all sent. Text below is what players actually received,
which differs from the drafts: the endpoint caps at 500 characters and reports
are plain text, so markdown emphasis and `×` became prose and `x`.

### 2026-08-05 · The res bar survives scrolling

> By popular demand: the resource bar now stays with you when you scroll.
> However deep you are in a build table or a long report, your stocks, the
> capacity, and the hourglass chip ride along at the top of the screen - so
> you can weigh an upgrade cost against what you actually hold without
> scrolling back up. A small thing, asked for by a player, shipped the same
> day. Keep them coming. Fair winds.

Asked for by a player mid-season 4, announced because it was asked for. Three
lines of CSS under the pregame banner's precedent; the parchment theme's
floating plate keeps a sliver of air above it when pinned. Only the res bar
pins — the nav tabs already have keyboard shortcuts, and pinning both would
double the vertical cost on phones.

Shipped in #91.

### 2026-08-05 · The hourglass chip

> New in the top bar: the hourglass chip. It watches your whole empire and
> shows the next thing to finish anywhere - a building, a training batch, or a
> fleet at sea - with a countdown. Click it and you land on that island, ready
> to queue the next thing. When the chip disappears, that is information too:
> nothing is under way anywhere, and idle halls earn nothing. Fair winds.

The one number that answers "why open the tab now" — every mobile 4X converged
on it independently. Server side each island row carries its soonest queue
head; the client folds in fleet arrivals and shows the minimum, minute-granular
until the final minute. Deliberately calm: no colour of its own, no seconds
until they matter.

It shipped with two gaps, both the same mistake — building the piece in
isolation instead of checking what neighbouring code already does. Every fleet
rendered as "My Island" (a `label` field movements never had; the #66 family,
one field over — fixed in #89 by reusing the Movements list's wording), and the
chip wore a hardcoded cream pill that punched through the parchment theme's
wood plate (#90 — the fix was deletion; its siblings inherit the theme, now it
does too).

Shipped in #88. Fixed in #89, #90. Tracking: #87.

### 2026-08-05 · Mid-season quality-of-life wave

> Mid-season quality-of-life wave: the new Islands tab (press o) lays out your
> whole holding — stocks, production, defence, walls, merchants — with honest
> totals and a production row. Arrow keys walk it weakest-first, and the dock
> now follows every island switch instantly. On the shipping form, the little
> arrow fills a one-resource convoy to the maximum in one click. And convoys
> between your own islands no longer write a report — the reports tab is for
> news again. Fair winds.

The wave, by the numbers: the Islands tab (#77, PRs #78/#79/#81 — totals only
where a sum is honest, production as its own row), ArrowUp/Down selection in
table order with the stale-dock fix underneath, the ▲ fill-max buttons on the
shipping form, and self-convoy receipts silenced (pool receipts and real trade
receipts kept — the discriminator is fromId === toId). Not announced because
they are invisible until the boundary: the pool.js extraction (#58), the pool
distance term (#76), respawn protection (#82, PR pending) and pop-at-origin
(#84, PR pending), all world-stamped for season 5.

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

### The boundary batch (2026-08-06, unannounced by design)

Shipped in season 4's final hours, when the world had three unread Beacon
reports and one player left standing at the keyboard. The season-5 opening
announcement is the right place to say these out loud:

- **Your did:nostr banner survives the season** (#86, PR #92): links live in
  `identity.json` — hall-of-fame pattern, the boundary never touches it —
  keyed by pod WebID. Both linked players were seeded before the reset. And
  quest 9 of 9, *Raise your banner*, closes the chain: link a key (noskey is
  the zero-install path), wear the ⚿ in rankings.
- **Gold Mine 18 → 15/h** (#64 supply half, PR #93): gold ran 14.8% of output
  against 9.6% of spend. This closes ~43% of the surplus; sinks (festivals,
  crew costs) stay open in #64 for the rest.
- **Green affordability countdowns** (#18, PR #94): `⏳ 2h 14m` beside every
  building and unit name you can't yet afford, from live stocks and rates.
  Only speaks when informative — an affordable row's button says it, and
  'never' is not a countdown.
- **Barbarians garrison to half the cap** (#39 defence half, PR #95):
  all-sentinel training made the "safe farm loop" the hardest islands in the
  world. Persona-level `defenseRatio: 0.5`; season 5's fresh bot roll carries
  it from creation. Whether farming them *pays* stays open in #39.

### Fixes you may have noticed

- Shipments carrying a fractional amount printed the full float — a delivery
  once read `107.20775939008854 wood`. Now floored for display; the exact
  amount still arrives. (#57)
- Every shipment in the movements list said "Returning to", whatever it was.
  (#31)
- The build queue table jumped between two and three columns while
  countdowns ticked. (#25)

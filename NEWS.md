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

## Season 6

### 2026-08-31 · Season 6 law: it takes two towers

> 🗼 Ninth law for season 6: the wonder crowns only the captain who holds
> TWO winning-level Beacons at once. Build both and pay the pacifist's
> premium — or build one and TAKE the other, for conquest carries
> buildings intact. A rival's rising tower is now a prize as much as a
> threat, and a lone finished beacon is not a world won: it is an
> invitation. Fair winds.

#178. One beacon behind one wall was a turtle's win; two towers cannot
hide behind one garrison, and the capture path turns rival wonders
complementary — you WANT the enemy's tower finished. Stealing a lone
finished beacon no longer ends the world by itself, which softens the
sudden-death and sets up the mutual one-beacon standoff: a race to take
the other's. Wonder stays personal; the alliance path is the crown
(#177). WONDER_WIN_COUNT knob, default 1, season 6 runs 2. Chapter Ten
of the Almanac rewritten to match. Delivered 2026-08-31 via
`/api/admin/announce`, 361 characters, the #101 route.

### 2026-08-31 · Season 6 law: the crown counts the living

> 👑 Eighth law for season 6: the crown counts the living. Dominance is
> now half of all INHABITED islands — twelve of the twenty-four today,
> rising with every colony planted. The empty sea no longer pads the
> count: rule the world that actually exists, and know that every settler
> who lands raises the bar beneath your feet. A conqueror must outpace
> the living world. Fair winds.

#177, and the operator's populated-islands instinct vindicated on the
second pass. The first pass (sixth law) rejected it for the bot-rush
trap — but that analysis predated pricing the curves: at 1.2-stepped
flagships a 12-conquest campaign costs ~225k of ladder plus armies, a
wonder-comparable timeline, and the trap is priced out. What killed the
all-islands basis was arithmetic: the flagship ladder to 23 islands
costs ~762k all-in — within 0.3% of the entire Beacon (~764k) — so a
27-island crown was solo-impossible and even 23 was a decoy nobody
would pick over the tower. Half the living world tracks beacon-cost all
season. WIN_BASIS knob (all|populated, default all), WIN_SHARE stays
0.5. Delivered 2026-08-31 via `/api/admin/announce`, 376 characters,
the #101 route.

### 2026-08-27 · Season 6 law: the Tidepool trims its sails

> ⛵ Seventh law for season 6: the Tidepool's boats sail four times faster.
> Market deliveries now run 2 minutes a field — a mid-map island gets its
> goods in about half an hour instead of two, the floor drops to 10
> minutes, and no delivery anywhere takes more than 100. Distance still
> matters; waiting half a day does not. Trade freely. Fair winds.

#176, with the cap the operator asked for aboard. The #76 design holds —
the pool sits mid-map and goods sail real distance, so the market never
dodges the harbour-slot brake (#30) — but the market's boats no longer
have to match merchant convoys: POOL_TRADE_SPEED=2, POOL_TRAVEL_MIN=10,
POOL_TRAVEL_MAX=100, all env knobs whose defaults reproduce the old
times bit-for-bit (tested). Loosening mid-season strands nothing, which
is why these are knobs rather than world stamps — #40 guards tightening,
not mercy. Melvin's own isle at 10:32: 126 minutes before, 31 after.
Staged for delivery.

### 2026-08-27 · Season 6 law: half the world crowns you

> 👑 Sixth law for season 6: dominance now takes HALF the world, down from
> 60%. Twenty-seven islands of the 54 crowns you — still more than every
> inhabited isle put together today, so no early rush wins: the world must
> grow before anyone can rule it. Every colony you raise builds the very
> map a conqueror needs. Settle carefully. Fair winds.

WIN_SHARE 0.6 → 0.5, chosen over the operator's first instinct (50% of
POPULATED islands) after the arithmetic showed that denominator inverts
the difficulty arc: 24 inhabited today would put the crown at 12 islands
— an opening-weeks bot-rush win — and the target would then RISE all
season as colonies land. Half of ALL islands keeps the right shape: at
54 total and 24 owned, 27 is unreachable until at least three more
colonizations exist anywhere, then tightens as the map fills. The
mortal-bot law (#172) is what makes the denominator honest — it no
longer inflates on every wipe-out. Delivered 2026-08-27 via
`/api/admin/announce`, 340 characters, the #101 route.

### 2026-08-27 · Season 6 law: half rations at sea

> 🍞 Fifth law for season 6: an army eats even at sea — but a marching army
> eats light. Troops aboard any voyage now cost HALF their keep against
> the home farm, both ways. Surge past your cap for a campaign; just know
> the farm remembers, and training waits until your fleets come home and
> your books balance. The endless raid that fed a second army above the
> cap is over. Fair winds.

The player's own bug report, turned law with leeway on purpose (#174):
troops in transit counted nowhere, so perpetual raiding trained a second
army into the freed headroom — the farm cap was advisory for anyone who
never came home. Strict counting would have turtled a season that just
taxed conquest, and a raider exemption was no fix (the raider IS the
attack force). `TRANSIT_POP_FACTOR=0.5` bounds the pipeline at ~2x cap
while keeping the campaign surge that attacking honestly needs. Default
0 leaves every other world untouched. Delivered 2026-08-27 via
`/api/admin/announce`, 381 characters, the #101 route.

### 2026-08-27 · Season 6 law: the Beacon's final fire

> 🔥 Fourth law for season 6: the Great Beacon wins at level 8 — and 8 is
> the true summit: the final leg needs a Storehouse 14, the highest there
> is. The last fire a beacon can burn now takes the world. And a
> correction: flagship steps count your islands as well as your fleet, so
> ×1.3 punished a lost flagship far too hard — the flagship curve is ×1.2
> from now on (10th ~29k, 15th ~73k). The Beacon burns higher, the sword
> sits easier. Fair winds.

Season 5 ran the Beacon at 7 (up from 6); 8 is not one-more-of-the-same
but the natural ceiling: level 8's biggest leg (107,472) needs exactly
Storehouse 14, the MAX_BUILDING_LEVEL fallback — level 9 would need a
storehouse that cannot exist. The operator's phrase was the spec: "raise
it 1 higher — I think that becomes max," and the arithmetic agrees.
Batched with the ×1.3→×1.2 flagship correction (see the third-law note
below). Deploy note for the record: these restarts re-supply ALL eight
game vars explicitly rather than trusting pm2's env merge — the audit
first confirmed season 5's WONDER_WIN_LEVEL=7, MORALE_FLOOR=0.3,
BOT_GARRISON_RATIO=12 and BOT_MORALE_FLOOR=1 had survived the week's
restarts. Delivered 2026-08-27 via `/api/admin/announce`, 446
characters, the #101 route.

### 2026-08-27 · Season 6 law: the conquest door pays too

> ⚓ Third law for season 6: flagships now cost more the wider you already
> are — ×1.3 per step, counted the same way as Colony Ships (islands plus
> flagships already bought; batches save nothing). The 10th runs ~60k
> all-in, the 15th ~224k. Settling is dearest, conquest is taxed, and
> blood still buys the discount. Choose your door wisely. Fair winds.

The third law closes what the first opened: at 1.6 the settle curve made
conquest the ~10x-cheaper side door to width, and #172's mortal bots made
it a prize map. #173 generalises the positional curve — `trainCost` and
`colonyPosition` now serve any stepped unit, a flagship aboard an attack
counts toward position, one clamp (#61) covers both knobs. 1.3 over the
recommended 1.2: the operator chose parity-with-blood over a soldier's
discount — then reversed within hours on a sharper reading than either
argument had: position counts ISLANDS as well as fleet, so at ten islands
the FIRST flagship already costs the 10th-step price, and every flagship
lost to a failed assault re-buys at the top of the curve. ×1.3 made
losing a flagship catastrophic rather than expensive. Corrected to ×1.2
the same day, announced batched with the fourth law — the delivered ×1.3
text above stands, per the charter, as what players received.
Delivered 2026-08-27 via `/api/admin/announce`, 347 characters, the #101
route.

### 2026-08-27 · Season 6 law: bots are mortal

> ⚔️ Second law for season 6: the bots are mortal. A bot driven from its
> last island is gone from the world — no refuge, no return. Twenty sailed
> at dawn; every one you end stays ended, and the map consolidates toward
> the living. And a fix beneath the law: any refuge now claims an uncharted
> island instead of conjuring a new one, so wiping a rival no longer grows
> the map against your own dominance count. Fair winds — for some of you.

The two halves of #172. The bug-fix half is unconditional: dominance
divides by all islands, so every minted refuge moved the WIN_SHARE
threshold — an island printer, fed by farming bots to extinction. The law
half is `BOT_RESPAWN=0`, a knob defaulting to the old behaviour; humans
are never gated by it. Tests cover claim-not-mint, the map-full mint
fallback, elimination at 0, and the human guarantee. Delivered
2026-08-27 via `/api/admin/announce`, 434 characters, JSON file over scp
— the #101 route.

### 2026-08-27 · Season 6 law: the expansion tax rises

> ⚖️ New law for season 6: Colony Ships cost ×1.6 per step, up from ×1.4.
> The 10th ship now runs ~185k all-in, the 15th ~1.9M — a wide empire must
> be truly earned, and going tall (mines, halls, the Beacon) just got
> relatively cheaper. As always the price steps by islands owned PLUS every
> ship already paid for, so batching saves nothing. Fair winds.

Applied live on the season server (pm2 restart with the new env, then
`pm2 save` so a reboot keeps the law — the knob lives only in the process
environment, which is exactly how it would have silently reverted).
README's own caution applies and is the point: "steeper bites much harder
than it looks" — 1.6 is a practical cap on width around 12–14 islands.
Position rules (#61/#62) and the [1,3] clamp unchanged. Delivered
2026-08-27 via `/api/admin/announce`, 348 characters, sent as a JSON file
over scp rather than through shell quoting — lesson #101 holds. Details
in `deploy/next-season.env`.

## Season 5 — opens 2026-08-06 15:00 UTC

### 2026-08-12 · The harbour gets its signs painted

> 🎨 The harbour got its signs painted. The top bar has retired its emoji —
> wood, stone, gold, storage, crew and loyalty now wear proper hand-painted
> icons: stacked logs, a boulder, a stack of coins, a crate, two islanders
> and the loyalty banner. Same numbers, clearer at a glance, and the same
> warm paint on both the parchment and retro looks. If you still see the old
> emoji, give the page a hard refresh. Fair winds.

The first strokes of the painted icon set (#162), in the kampfinsel spirit:
six 24px SVG symbols with fixed warm-palette fills and one dark outline each,
so a single drawing reads on cream paper and carved wood alike. The style
spec lives beside the symbols in `index.html`'s sprite. Tabs stay stroke-only
`currentColor` (#102 — chrome quiet, paint on content); JS-generated emoji
strings migrate as the set grows.

### 2026-08-11 · The Tavern opens its doors

> 🎲 The Tavern is open. Walk in through the Tidegate and stake your sealed
> gold on the Tide Dice — the next Bitcoin block rolls, so nobody, not even
> the house, knows the roll before the tide comes in. Every wager is signed
> by your own key, every roll can be proven by anyone, and your winnings walk
> home with you on a signed slip. The tavern keeps its book; take it with you
> anytime. Fair winds and honest dice.

Phase 3 of #135, done the modular way. The tavern is a **separate app** —
[melvincarvalho.github.io/tavern](https://melvincarvalho.github.io/tavern/),
built on its own pure wager maths (`tavern.js`: quotes, settlement, a
share-based bankroll, an offline verifier) — and Tideholm's entire integration
is one link out and one endpoint home (PR #147). **The Tide**: dice seeded by
the hash of the next testnet4 block, which exists for nobody at bet time — the
chain is the commitment, so even a purely client-side page is provably fair.
**Sealed mode**: arrive through the Tidegate link and your purse is your sealed
gold; every stake and payout is a signed trail transition. **The courier slip**:
your signed record rides home in a query string; Redeem verifies every Schnorr
signature server-side before the seal moves — no pods needed, because the trail
is a signed document and the player is the transport. **The Log**: the tavern
keeps its book — every wager, totals, verify links, settled slips archived, the
whole book exportable. Tavern history lands on the same trail as pegs, so the
⚓ anchor covers your nights at the dice as faithfully as your banking. A
first-in-#145 attempt that put the game inside Tideholm was reverted whole —
the tavern belongs to its own house. Player guide:
[the gist](https://gist.github.com/melvincarvalho/b1ea0b3aec3b6d4103a4200241a0403d).

### 2026-08-11 · The Tidegate anchors to Bitcoin

> ⚓ The Tidegate opens in the Market. Seal gold out of your vault into a
> balance keyed to your nostr banner — and now anchor it to Bitcoin. One
> click, signed by your own key in your own browser, writes your seal into
> testnet4 stone: a proof any soul can check with nothing but your public
> key. No harbourmaster holds your coin, no ledger but the chain. The first
> anchor is already on the water. Fly a banner to try it. Fair winds.

Vault phase 2, landed whole (#135, #140). **Peg in/out** seals vaulted gold to
a balance keyed to your did:nostr, every move signed in the browser and kept as
a verifiable trail on the server (PR #138). A **fuel gauge** shows the testnet4
satoshis your banner's taproot address holds — same secp256k1 key, so your
identity *is* a Bitcoin address (PR #139). **Anchor ⚓** then commits the trail
on-chain as a BlockTrails state advance: two clicks, non-custodial, the key
never leaves the browser; a small 10k-sat float rides the trail while the
change returns home to base (PRs #141 operator CLI, #142 the button, #143
persistent status). The first anchor is real: [`3ae578e4…`](https://mempool.space/testnet4/tx/3ae578e43115c54d234e90b3b1c5a10e951833e9160dcc565849c69efe32a7b2)
spends the genesis UTXO to P(1) — and the whole thing verifies from nothing but
the public key and the trail. Only banner-flying players see the crypto; everyone
else's market is unchanged.

### 2026-08-10 · The Vault opens

> 🏦 The Vault opens in the Market. Deposit gold into a personal strongroom and
> it's safe from raiders — they can sack an island bare and never touch what
> you've locked away. Withdraw it back to any island, up to its storehouse
> room. Instant, gold only for now. Somewhere to keep a fortune between wars.
> Fair winds.

A personal, raid-proof gold treasury (#132, PR #133). Gold in the vault lives
on the player, not an island — and loot only ever touches island resources, so
vaulted gold cannot be sacked. Deposit from any island, withdraw back capped by
its storehouse room (so it can't overflow and vanish). Instant, gold only. It's
phase 1 of a longer arc: phase 2 seals the balance cross-chain with single-use
seals anchored to your did:nostr banner (peg-in mints, peg-out redeems), and
phase 3 opens tavern games on the settled gold. Also a quiet sink for the #64
surplus — banked gold sits idle, out of production's reach.

### 2026-08-10 · The map marks where you are

> 🗺️ The World Map now marks where you stand: the island you're on is painted
> gold, on both the rail map and the full Map tab. Hold a dozen isles and
> you'll still spot your current one at a glance — switch islands and the gold
> follows at once. Small thing, easier eyes. Fair winds.

The active island is filled gold on the minimap and the stage rail's World Map
(#119, PRs #124–#126). It began as a white "you are here" ring, but a ring
around a ~3px cell is mostly outline — measured, the island's colour was 3% of
the marker at 1×, so it read as a white square no matter how it was tuned. A
unique solid colour reads where an outline never could. The rail is a separate
poller, so switching islands lagged up to 5s until app.js began firing an
event to move the gold at once; a HiDPI pass also made the whole map crisp.

### 2026-08-10 · The resbar grows meters

> ⚜️ Read the resbar at a glance. Each store now wears a fill-line — amber as
> it nears the brim, red when it spills unused. Two gauges join them: your
> muster against its cap, and an island's loyalty (that one glows amber while
> a fresh conquest still chafes). No sums, no clicking through. Hard-refresh
> to see them.

A thin water-level bar under each resbar chip (#116, PR #117). Every value was
already on the wire — resources+capacity, popUsed+popCap, loyalty+loyaltyMax —
so client + CSS only, no payload change, no restart. Storage and pop fill
toward their cap (amber near full, red at it); loyalty is inverted, low being
the danger, so amber/red mark a weak hold on a freshly-taken island. First of
a "UI candy" pass; the timer bars for the build/train queues want a payload
field and come later. Bonus: pop and loyalty left the island title, which had
been changing on every loyalty tick and resetting `sound.js`'s "same island?"
snapshot.

### 2026-08-07 · The tabs grow icons

> The tabs have grown icons - a palm for your island, a scroll for reports,
> a trophy for rankings, and friends. On a phone the words now step aside
> and the icons carry the whole row, so the top bar fits without wrapping.
> On desktop you keep both. Drawn in the games own ink, they follow
> whichever theme you play in. Small thing, easier thumbs. Fair winds.

Eight hand-drawn stroke SVGs in one inline sprite, stroke=currentColor so
every theme and the active state ink them correctly with no per-theme rules
(#102, PR #103). The apostrophe in "game's" fell at the shell boundary
again — twice now; the send pipeline owes us a proper JSON-file path. A
painted full-colour icon set exists and was deliberately not spent on 24px
chrome; it waits for content surfaces.

### 2026-08-09 · Troop counts stop resetting as you type

> Bug fixed, reported in play: when you typed a number of troops to train, the
> count kept resetting itself every few seconds - the screen refresh was
> wiping what you had entered. It now keeps your number, and your cursor,
> while you type. Thanks to the player who flagged it. Keep the reports
> coming. Fair winds.

The train inputs were rebuilt from scratch on every 5-second state poll, with
a hardcoded default — so any count you typed reset (and lost focus) within a
cycle. Now the poll snapshots the fields and the focused cursor before the
rebuild and restores them; untouched fields keep their defaults. The attack
panel was never affected — it's built on target-click, not the poll. Reported
via phil's session (his second catch of the weekend, after the movements
overview), filed #106, fixed #107.

### 2026-08-10 · The Islands tab gets an Army section

> New on the Islands tab: an Army section. Your whole military on one screen -
> a column for each kind of unit you own, a row per island, and an empire
> total. Troops you have stationed on another island show as +n, so you can
> see where your reinforcements are, not just that your defence went up. No
> more clicking every island to find your raiders. Fair winds.

The overview showed a computed defence number per island but not the army
behind it — and raiders/flagships barely register in that number, so the
attacking force was invisible on the whole-holding screen (#113, PR #114). New
table below the stocks table: a column per owned unit type (empty hidden), a
row per island, an empire total; troops stationed abroad as support show as
+n (pairs with popAbroad and the #109 support-defence fix). Payload gains
army:{home,abroad} per island, non-zero types only, pinned. Motivated straight
from live play — the manual army-tracking this retires was a real weekly chore.

### 2026-08-10 · A tidy and a couple of fixes

> A tidy and a couple of fixes. The Islands tab now counts reinforcements in an
> island's defence - troops you send as support were defending in battle all
> along, but the number ignored them; it now tells the truth. The top bar has
> dropped the island dropdown - switch islands with the dock at the bottom
> (click a chip, or the arrow keys) or from the Islands tab. And the Help link
> opens the new Almanac properly now. Fair winds.

Three ships in one note. **Reinforcements counted** (#109/#110): the overview
summed home units only while combat sums support contingents too — a defender
shoring up an island read far softer than it fought (M1 showed 558, fielded
780). **Top-bar tidy** (#112): the island `<select>` is hidden always now; the
dock and Islands tab are the switchers, and the select lives on invisibly as
the state source-of-truth (a one-liner, not the full refactor). **Help fixed**:
the links were reset to an absolute `/help.html` by applyStatic on every render,
resolving to the host root under the mount — now resolved against
`import.meta.url`, correct at any path. All reported or surfaced in play.

### 2026-08-10 · The Tideholm Almanac

> The Help link now opens The Tideholm Almanac - a proper captain's handbook.
> Fifteen chapters, from your first island to the admiral's craft: resources
> and buildings, the full unit roster, how combat and losses are actually
> calculated, colonisation and conquest, scouting and support, the Tidepool,
> the Beacon, the ways of the island folk, and hard-won advanced tactics -
> plus a quick-reference of the numbers that matter. Read the first chapters
> to play, the rest to win. Fair winds.

A self-contained, book-styled manual (public/almanac.html) replacing the thin
getting-started page: parchment aesthetic in its own CSS, theme-aware,
responsive with a mobile contents drawer, scroll-spy contents rail — no
dependency on the game's stylesheet. Built commercial-grade with a harsh-critic
pass (which caught the missing interface orientation, the Alliance/Mail
coverage, and the battle-simulator mention, all added before release).
Modular: one file plus ~10 lines. Also fixed the underlying Help-link bug — a
bare href='help.html' resolved to the host root (Cannot GET /help.html) when
the game loads without a trailing slash; the links now resolve the Almanac
against import.meta.url, correct at any mount.

### 2026-08-09 · Wealth at sea, counted — by player request

> By player request, shipped the same day: the Islands tab now counts your
> wealth at sea. A new At-sea row in the totals adds up every cargo aboard
> your shipments and returning fleets - shelved plus sailing equals what you
> actually own. Below it, a Movements table lists every fleet and cargo of
> yours on the water, empire-wide: what it is, where from, what it carries,
> when it lands. Keep the requests coming. Fair winds.

philloster's first feature request of the season ("I cannot count my
resources that are on the move because they become invisible"), filed as
#104 and shipped in #105 within the hour — the season-4 request-to-ship
loop, continued. The at-sea row extends #77's honest-totals principle to
cargo; the movements payload gained an origin field (six convoys are
indistinguishable by target alone). Sent via a JSON file this time: the
apostrophes survived.

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

- **Returning fleets show their passengers** (#160, PR #161) — reported by
  Phil, who watched two flagships sail home invisibly after taking Gull Cry.
  A combat return carries troops *and* loot, and both movement views only
  showed the loot, so a returning flagship read exactly like a trade shipment
  and fleets "rematerialized" at home with no visible journey. Now every
  movement lists whatever is actually aboard, troops first. (His third
  flagship isn't lost, by the way — the conquering flagship becomes the seat
  of power and stays to govern. It's in the conquest report, but now the
  other two visibly sail home around it.)
- **Background tabs stop polling** (#158, PR #159) — a forgotten Tideholm tab
  polled at full rate forever, and eight restored tabs could saturate the
  per-player request budget: the "429 Too Many Requests" storms in the
  console (#157). Hidden tabs now go silent and catch up the moment you
  return; two visible windows side by side still both poll. If the game ever
  told you to *Slow down*, this was why, and it shouldn't again.
- Shipments carrying a fractional amount printed the full float — a delivery
  once read `107.20775939008854 wood`. Now floored for display; the exact
  amount still arrives. (#57)
- Every shipment in the movements list said "Returning to", whatever it was.
  (#31)
- The build queue table jumped between two and three columns while
  countdowns ticked. (#25)

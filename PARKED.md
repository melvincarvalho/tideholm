# PARKED — do not merge this branch as-is

`chore/quality-pass-full` holds the leftovers of a `/simplify` pass run on
2026-07-25. It is kept for reference, **not** as a ready-to-merge cleanup
branch. Three separate reasons, in order of severity.

## 1. The bots morale change is wrongly scoped

`bots.js` here makes `moraleEst` import `MORALE_FLOOR` / `BOT_MORALE_FLOOR`
and pick the floor by whether the *defender* is a bot, mirroring the engine at
`game.js:1068-1075`.

That faithfully reproduces the engine — and the engine is arguably wrong.
Issue #13 introduced `BOT_MORALE_FLOOR` for **human** attackers ("let the
leader fight bots", the whale endgame). The engine keys it on the defender
alone, so bot-vs-bot picked it up as an unintended side effect.

Production runs `BOT_MORALE_FLOOR=1`, so merging this as-is would make bots
rate themselves ~3x stronger against other bots and **triple bot-vs-bot
aggression mid-season** — including against the barbarian islands humans farm.

Rescope it first, in `game.js`:

```js
const floor = (defOwner.isBot && attacker && !attacker.isBot)
  ? BOT_MORALE_FLOOR : MORALE_FLOOR;
```

That gives humans full power against bots (the knob's actual purpose), leaves
bot-vs-bot at `MORALE_FLOOR`, and makes `bots.js`'s original hardcoded `0.3`
*correct* — so the only change left there is importing the constant instead of
repeating the literal.

## 2. The branch is stale and would revert live work

It was cut before hotkeys (#33), the identity work (#35, #38, #41) and the JSS
0.0.220 bump (#42). Diffing its tip against `gh-pages` shows ~560 deletions —
that is the branch *missing* shipped code, not proposing removals.

**Rebase onto `gh-pages` and re-derive; never merge the tip.**

## 3. Parts of it already shipped

The low-risk third went out in #31 (trade movement label, `WONDER_WIN_LEVEL`
docs, `.admin-token` gitignore, the false `stage.css` / `stage.js` headers).
`public/stage.css` and `public/stage.js` here are now byte-identical to
`gh-pages`. Re-applying the rest will conflict or no-op.

## What is genuinely still unmerged and worth salvaging

| Change | Value | Note |
|---|---|---|
| `addReport` for admin announce | restores the 100-reports-per-player cap the hand-rolled push drops | `game.js` export + `app.js`; also hoists a `resolveWorld` out of a per-player loop |
| `targetAt(body)` helper | collapses 6 byte-identical coordinate lookups | pure refactor |
| `where = at(dest)` | removes a duplicated template literal | pure refactor |
| Drop `units:` from `/api/state` | no client reads it; `unitTypes[k].count` carries the same numbers | verify again before dropping |
| Wall constants to the client | simulator stops hardcoding `15` / `0.08` | **all-or-nothing** — shipping the client half alone makes the defence estimate `NaN`, because `state.wallFlatDef` would be undefined |

Everything above needs a `pm2 restart`, so it belongs in a season-boundary
batch alongside the balance work (#26, #27, #30, #39, #40) rather than a
standalone deploy.

## If you only take one thing from this file

The bots morale change looks like a bug fix and is a mid-season difficulty
shift. Do not merge it without the `!attacker.isBot` scoping.

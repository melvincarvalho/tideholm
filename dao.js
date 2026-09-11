// The Season DAO (#189) — a million shares a season, bought with sealed gold,
// one-way. The gold is burned: it left the seal as a signed trail move whose
// evidence names this venue, and nothing ever pays it back. What the buyer
// holds is a line in this ledger, keyed by season, and the ledger lives
// beside the hall of fame — NOT in the world — so it survives the season
// the way the hall does. Nothing here touches the world or the seal: the
// sync route validates the slip, moves the seal, then credits shares here.
//
// v1 rules, on purpose small: one gold per share, first come first served,
// no per-key cap, no vote, no trading. Each is a later step; the ledger
// does not change shape for any of them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DAO_SUPPLY = 1_000_000;   // shares a season
export const DAO_PRICE = 1;            // gold per share
export const DAO_MAX_BUY = 100_000;    // shares per signed move — the slip rides in a URL

const DAO_FILE = process.env.DAO_FILE
  || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'dao.json');

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DAO_FILE, 'utf8'));
    if (d && typeof d === 'object' && d.seasons && typeof d.seasons === 'object') return d;
  } catch { /* fresh */ }
  return { seasons: {} };
}
function save(d) {
  fs.mkdirSync(path.dirname(DAO_FILE), { recursive: true });
  fs.writeFileSync(DAO_FILE, JSON.stringify(d, null, 2));
}

// The holder key: the nostr identity where there is one (it outlives the
// season and the name), else the name — an unkeyed captain is still a captain.
export function daoKey(player) {
  return player.nostrDid ? player.nostrDid : `name:${player.name}`;
}

function seasonBook(d, season) {
  const k = String(season);
  if (!d.seasons[k]) d.seasons[k] = { season, supply: DAO_SUPPLY, price: DAO_PRICE, opened: Date.now(), holders: {}, ledger: [] };
  return d.seasons[k];
}

export function daoSold(book) {
  return Object.values(book.holders).reduce((a, h) => a + h.shares, 0);
}

// Credit `shares` to the player for `season`. `mark` is the slip move's mark
// (unique per signing); `at` the time. Returns { ok, shares, sold, remaining }
// or { error, errorParams }. Never throws.
export function daoBuy(season, player, shares, mark, at = Date.now()) {
  shares = Math.floor(Number(shares));
  if (!Number.isSafeInteger(shares) || shares < 1) return { error: 'err.badRequest' };
  if (shares > DAO_MAX_BUY) return { error: 'err.daoTooMany', errorParams: { max: DAO_MAX_BUY } };
  const d = load();
  const book = seasonBook(d, season);
  const sold = daoSold(book);
  const remaining = book.supply - sold;
  if (shares > remaining) return { error: 'err.daoSoldOut', errorParams: { remaining } };
  const key = daoKey(player);
  const h = book.holders[key] || (book.holders[key] = { name: player.name, shares: 0, first: at, last: at });
  h.name = player.name; h.shares += shares; h.last = at;
  book.ledger.push({ at, key, name: player.name, shares, gold: shares * book.price, mark: String(mark || '').slice(0, 64) });
  save(d);
  return { ok: true, shares: h.shares, sold: sold + shares, remaining: remaining - shares };
}

// How many shares a season still has for sale — the sync route asks before
// it moves the seal, so a slip that would overshoot is refused whole and the
// gold never leaves.
export function daoRemaining(season) {
  const book = load().seasons[String(season)];
  return book ? book.supply - daoSold(book) : DAO_SUPPLY;
}

// The public view: holders ranked, the sale as a series, the last moves.
// No identities beyond what the rankings already show (names) — dids are
// public anyway, but the view keys holders by name and gives the did only
// where the player chose one.
export function daoView(season, { ledgerTail = 50 } = {}) {
  const d = load();
  const book = d.seasons[String(season)] || { season, supply: DAO_SUPPLY, price: DAO_PRICE, opened: null, holders: {}, ledger: [] };
  const sold = daoSold(book);
  const holders = Object.entries(book.holders)
    .map(([key, h]) => ({ key, name: h.name, shares: h.shares, pct: sold ? +(100 * h.shares / book.supply).toFixed(3) : 0, first: h.first, last: h.last }))
    .sort((a, b) => b.shares - a.shares || a.first - b.first);
  // cumulative sold over time — the chart the venue draws
  let run = 0;
  const series = book.ledger.map((e) => { run += e.shares; return { at: e.at, sold: run }; });
  return {
    season: book.season, supply: book.supply, price: book.price, opened: book.opened,
    sold, remaining: book.supply - sold, holders,
    series, ledger: book.ledger.slice(-ledgerTail),
    seasons: Object.keys(d.seasons).map(Number).sort((a, b) => a - b),
  };
}

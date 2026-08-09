// Tideholm — app-layer tests: createApp over real HTTP.
// Run: node tests.app.js   (exits non-zero on failure)
// Covers the seams the standalone launcher doesn't exercise: prefix
// mounting, the pluggable identity provider, and password-mode auth —
// the contract an embedding host (e.g. a JSS plugin) relies on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Isolated storage: never touch the repo's live world.
process.env.GAME_SPEED = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tideholm-app-test-'));
process.env.HALL_FILE = path.join(process.env.DATA_DIR, 'hall-of-fame.json');
process.on('exit', () => {
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* gone */ }
});

const { createApp } = await import('./app.js'); // dynamic: after DATA_DIR above
const game = await import('./game.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok  ' + name);
  } else {
    failures++;
    console.log('FAIL  ' + name + (detail !== undefined ? ' — ' + detail : ''));
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

const silent = { log() {}, error: console.error };

function serve(app) {
  return new Promise((resolve) => {
    const srv = http.createServer(app.handle);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function req(port, method, p, { body, cookie, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data, headers: res.headers };
}

(async () => {
  // ---------------------------------------------------------------- password mode
  console.log('password mode (standalone)');
  const app = createApp({ botCount: 2, freeIsles: 2, log: silent });
  const { srv, port } = await serve(app);

  let r = await req(port, 'GET', '/api/state');
  check('state without session is 401', r.status === 401);

  r = await req(port, 'POST', '/api/register', { body: { name: 'App Tester', password: 'sekrit', lang: 'en' } });
  check('register succeeds', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  check('register sets a session cookie', cookie.startsWith('session='));

  r = await req(port, 'GET', '/api/state', { cookie });
  check('state with session is 200', r.status === 200);
  check('state names the player', r.data && r.data.player && r.data.player.name === 'App Tester');

  r = await req(port, 'POST', '/api/login', { body: { name: 'App Tester', password: 'wrong' } });
  check('wrong password is 401', r.status === 401);

  r = await req(port, 'GET', '/');
  check('serves the client at /', r.status === 200);

  r = await req(port, 'GET', '/api/meta');
  check('meta reports password mode', r.status === 200 && r.data.mode === 'password' && r.data.podLoginUrl === null);

  srv.close();

  // ---------------------------------------------------------------- prefix mount
  console.log('prefix mount');
  const mounted = createApp({ botCount: 2, freeIsles: 2, basePath: '/tideholm', log: silent });
  const m = await serve(mounted);

  r = await req(m.port, 'GET', '/tideholm');
  check('bare prefix redirects to prefix/', r.status === 302 && r.headers.get('location') === '/tideholm/');

  r = await req(m.port, 'GET', '/tideholm/');
  check('serves the client under the prefix', r.status === 200);

  r = await req(m.port, 'GET', '/tideholm/api/state');
  check('api answers under the prefix (401 unauthenticated)', r.status === 401);

  r = await req(m.port, 'GET', '/elsewhere');
  check('paths outside the prefix are 404', r.status === 404);

  m.srv.close();

  // ---------------------------------------------------------------- host identity
  console.log('host identity (identify option)');
  const podApp = createApp({
    botCount: 2,
    freeIsles: 2,
    log: silent,
    identify: async (rq) => {
      const webid = rq.headers['x-test-webid'];
      return webid ? { id: webid, name: rq.headers['x-test-name'] || 'Pod Person' } : null;
    },
  });
  const h = await serve(podApp);
  const alice = { 'x-test-webid': 'https://alice.pod/profile#me', 'x-test-name': 'Alice' };

  r = await req(h.port, 'GET', '/api/meta');
  check('meta reports pod mode + login url', r.status === 200
    && r.data.mode === 'pod' && r.data.podLoginUrl === '/idp/credentials');

  r = await req(h.port, 'GET', '/api/state');
  check('no identity is 401', r.status === 401);

  const playersBefore = podApp.world.players.length;
  r = await req(h.port, 'GET', '/api/state', { headers: alice });
  check('identity auto-provisions a player', r.status === 200 && r.data.player.name === 'Alice',
    JSON.stringify(r.data && r.data.player));
  check('provisioned player carries the external id',
    podApp.world.players.some((p) => p.extId === alice['x-test-webid']));

  r = await req(h.port, 'GET', '/api/state', { headers: alice });
  check('second request reuses the same player', r.status === 200
    && podApp.world.players.length === playersBefore + 1);

  // Same display name from a different pod: still gets an account.
  const alice2 = { 'x-test-webid': 'https://other.pod/alice#me', 'x-test-name': 'Alice' };
  r = await req(h.port, 'GET', '/api/state', { headers: alice2 });
  check('name collision resolved for second identity', r.status === 200
    && r.data.player.name !== 'Alice' && r.data.player.name.startsWith('Alice'));

  r = await req(h.port, 'POST', '/api/register', { body: { name: 'X', password: 'yyy' } });
  check('password register is disabled under host identity', r.status === 404);
  r = await req(h.port, 'POST', '/api/login', { body: { name: 'X', password: 'yyy' } });
  check('password login is disabled under host identity', r.status === 404);

  // Session bridge: a verified host identity mints a game session cookie so
  // play survives host-token expiry (the 3600s /idp/credentials TTL).
  r = await req(h.port, 'GET', '/api/state', { headers: alice });
  const bridge = (r.headers.get('set-cookie') || '').split(';')[0];
  check('host identity mints a game session cookie', bridge.startsWith('session='));

  r = await req(h.port, 'GET', '/api/state', { cookie: bridge }); // token "expired"
  check('session survives host-token expiry', r.status === 200 && r.data.player.name === 'Alice',
    JSON.stringify(r.data && r.data.player));

  // A live token from a different pod outranks a stale cookie.
  r = await req(h.port, 'GET', '/api/state', { cookie: bridge, headers: alice2 });
  check('live host token outranks the bridge cookie', r.status === 200
    && r.data.player.name !== 'Alice' && r.data.player.name.startsWith('Alice'));

  r = await req(h.port, 'POST', '/api/logout', { cookie: bridge });
  check('logout clears the bridge session', r.status === 200);
  r = await req(h.port, 'GET', '/api/state', { cookie: bridge });
  check('cleared bridge session is 401', r.status === 401);

  h.srv.close();

  // stop() releases the lock and saves — must be idempotent across instances
  app.stop();
  mounted.stop();
  podApp.stop();
  check('lock released after stop', !fs.existsSync(path.join(process.env.DATA_DIR, 'server.lock')));

  // ---------------------------------------------------------------- pregame (#8)
  // Fresh world so WORLD_START takes effect (loadWorld returns nothing).
  console.log('scheduled season start (pregame freeze)');
  fs.rmSync(path.join(process.env.DATA_DIR, 'world.json'), { force: true });
  process.env.WORLD_START = String(Date.now() + 3600000); // launch in 1h
  const pre = createApp({ botCount: 2, freeIsles: 2, log: silent });
  delete process.env.WORLD_START;
  const pg = await serve(pre);

  r = await req(pg.port, 'GET', '/api/meta');
  check('meta reports pregame phase', r.status === 200 && r.data.phase === 'pregame' && r.data.startAt > Date.now(),
    JSON.stringify(r.data));

  r = await req(pg.port, 'POST', '/api/register', { body: { name: 'Early Bird', password: 'sekrit', lang: 'en' } });
  check('registration is open during pregame', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  const preCookie = (r.headers.get('set-cookie') || '').split(';')[0];

  r = await req(pg.port, 'GET', '/api/state', { cookie: preCookie });
  check('state reports pregame + startAt', r.status === 200 && r.data.phase === 'pregame' && r.data.startAt > Date.now());
  const eb = pre.world.players.find((p) => p.name === 'Early Bird');
  check('a pregame player joined at launch, not now', eb && Math.abs(pre.world.startAt - eb.joinedAt) < 5);
  // A state poll must not advance the island clock past launch — otherwise
  // production would accrue poll-by-poll while the world is meant to be frozen.
  const ebIsland = pre.world.islands.find((i) => i.ownerId === eb.id);
  check('pregame poll keeps the island clock frozen at startAt',
    ebIsland && ebIsland.lastUpdate === pre.world.startAt, ebIsland && ebIsland.lastUpdate);

  r = await req(pg.port, 'POST', '/api/build', { cookie: preCookie, body: { building: 'wall', islandId: r.data.island.id } });
  check('world-mutating actions are blocked during pregame (409)', r.status === 409, JSON.stringify(r.data));

  // PREGAME_BLOCKED only guards POSTs, so every GET that resolves an island
  // must clamp to startAt itself. resolveIsland assigns lastUpdate = now
  // unconditionally, so an unclamped GET rewinds the clock into the past and
  // the next state poll accrues the whole pregame gap again — repeatably.
  // Four endpoints resolved at a raw Date.now(); /api/map resolved EVERY
  // island in the world that way.
  {
    const frozenAt = pre.world.startAt;
    const woodBefore = ebIsland.resources.wood;
    for (const path of [
      `/api/train/quote?islandId=${ebIsland.id}&unit=spearman&count=1`,
      '/api/map',
      `/api/pool?islandId=${ebIsland.id}&deposit=100`,
      `/api/pool?islandId=${ebIsland.id}&withdraw=1`,
    ]) {
      await req(pg.port, 'GET', path, { cookie: preCookie });
      check(`pregame GET does not rewind the island clock: ${path.split('?')[0]}`,
        ebIsland.lastUpdate === frozenAt, `${ebIsland.lastUpdate} vs ${frozenAt}`);
    }
    await req(pg.port, 'GET', '/api/state', { cookie: preCookie });
    check('and no pregame production was farmed by cycling them',
      ebIsland.resources.wood === woodBefore,
      `${ebIsland.resources.wood} vs ${woodBefore}`);
  }

  pg.srv.close();
  pre.stop();

  // ---------------------------------------------------------------- season reset scheduling (#2)
  console.log('admin reset can schedule the next season (countdown)');
  fs.rmSync(path.join(process.env.DATA_DIR, 'world.json'), { force: true });
  const seasonApp = createApp({ botCount: 2, freeIsles: 2, adminToken: 'sekrit-admin', log: silent });
  const sa = await serve(seasonApp);

  r = await req(sa.port, 'GET', '/api/meta');
  check('a fresh default world is live', r.status === 200 && r.data.phase === 'live');

  r = await req(sa.port, 'POST', '/api/admin/reset', { body: { token: 'sekrit-admin', startInHours: 1 } });
  check('admin reset with startInHours archives + schedules', r.status === 200 && r.data.ok
    && r.data.startAt > Date.now() + 3000000, JSON.stringify(r.data));

  r = await req(sa.port, 'GET', '/api/meta');
  check('the next season opens in pregame with a countdown', r.status === 200 && r.data.phase === 'pregame');

  sa.srv.close();
  seasonApp.stop();

  // ---------------------------------------------------------------- pool (read-only)
  // GET /api/pool must never mutate. The pool ships closed, so the strongest
  // assertion available is that nothing this endpoint does can open it or put
  // anything in it, however it is called (#46 step 3).
  console.log('\npool (read-only)');
  const poolApp = createApp({ botCount: 1, freeIsles: 1, log: silent, adminToken: '' });
  const pa = await serve(poolApp);

  r = await req(pa.port, 'GET', '/api/pool');
  check('pool needs a session', r.status === 401);

  r = await req(pa.port, 'POST', '/api/register', { body: { name: 'Pool Tester', password: 'sekrit', lang: 'en' } });
  const pcookie = (r.headers.get('set-cookie') || '').split(';')[0];

  r = await req(pa.port, 'GET', '/api/pool', { cookie: pcookie });
  check('pool reports as closed', r.status === 200 && r.data.open === false, JSON.stringify(r.data));
  check('with empty reserves', ['wood', 'stone', 'gold'].every((x) => r.data.reserves?.[x] === 0));
  check('config comes from the world', r.data.feeBps === 30 && r.data.floorFrac === 0.25);
  check('every ordered pair is priced', r.data.prices?.length === 6);
  // A closed pool's reserves are 0, so every spot price is 0/0. Counting the
  // pairs was not enough: JSON.stringify turns NaN into null silently, so the
  // whole price table was null and the test passed anyway.
  check('and every price is a finite number, not null',
    r.data.prices?.every((p) => typeof p.price === 'number' && Number.isFinite(p.price)),
    JSON.stringify(r.data.prices?.slice(0, 2)));
  // Walk the payload rather than pattern-matching the JSON text. The previous
  // version was `!json.includes('null') || floor === null`, which goes vacuous
  // the moment floor is null and would then wave through any other null.
  // `cappedBy` is the one field allowed to be null, and only inside a quote.
  const nulls = (o, path = '') => {
    if (o === null) return [path || '(root)'];
    if (typeof o === 'number') return Number.isFinite(o) ? [] : [`${path}=${o}`];
    if (Array.isArray(o)) return o.flatMap((v, i) => nulls(v, `${path}[${i}]`));
    if (o && typeof o === 'object') {
      return Object.entries(o).flatMap(([k, v]) =>
        (k === 'cappedBy' ? [] : nulls(v, path ? `${path}.${k}` : k)));
    }
    return [];
  };
  check('no null or non-finite number anywhere in a closed pool payload',
    nulls(r.data).length === 0, nulls(r.data).join(', '));
  check('a new player holds no position', r.data.mine?.shares === 0 && r.data.mine?.share === 0);
  check('no quote unless one is asked for', r.data.quote === undefined);

  // Number(null) is 0, which is finite — so an absent amount must be rejected
  // on presence, not on coercibility, or the endpoint quotes for nothing.
  for (const qs of ['?from=wood&to=gold', '?from=wood&to=gold&amount=']) {
    r = await req(pa.port, 'GET', '/api/pool' + qs, { cookie: pcookie });
    check(`${qs} returns no quote block`, r.data.quote === undefined,
      JSON.stringify(r.data.quote));
  }
  r = await req(pa.port, 'GET', '/api/pool?from=wood&to=gold&amount=0', { cookie: pcookie });
  check('an explicit amount=0 still quotes, since it was asked for',
    r.data.quote !== undefined && r.data.quote.amountIn === 0);

  r = await req(pa.port, 'GET', '/api/pool?from=wood&to=gold&amount=500', { cookie: pcookie });
  check('a quote is returned when asked', r.status === 200 && !!r.data.quote);
  check('a closed pool quotes nothing', r.data.quote?.out === 0 && r.data.quote?.used === 0);
  // effPrice is Infinity when nothing comes out, which also serialises to null.
  check('every quote field is a finite number',
    ['out', 'used', 'impact', 'effPrice', 'spotPrice', 'maxIn']
      .every((k) => Number.isFinite(r.data.quote?.[k])),
    JSON.stringify(r.data.quote));

  // Malformed query strings reach poolQuote directly, so they are the most
  // likely way to get an unexpected 500 out of this endpoint.
  for (const qs of ['?from=wood&to=wood&amount=500', '?from=iron&to=gold&amount=5',
    '?from=wood&to=gold&amount=-500', '?from=wood&to=gold&amount=abc',
    '?from=wood&amount=500', '?from=wood&to=gold&amount=1e999']) {
    r = await req(pa.port, 'GET', '/api/pool' + qs, { cookie: pcookie });
    check(`malformed query ${qs} is answered, not an error`, r.status === 200,
      `status ${r.status}`);
  }

  check('none of that opened the pool', poolApp.world.pool.open === false);
  check('none of that added reserves',
    ['wood', 'stone', 'gold'].every((x) => poolApp.world.pool.reserves[x] === 0));
  check('none of that minted shares', poolApp.world.pool.totalShares === 0);

  // Open one by hand so the paths that only exist on a live pool — real
  // prices, a real quote, a held position — are actually exercised. There is
  // no endpoint that can do this yet, which is the point.
  const tuned = { wood: 4000, stone: 3600, gold: 6800 };
  Object.assign(poolApp.world.pool, {
    open: true,
    reserves: { ...tuned },
    seeded: { ...tuned },
    totalShares: 1000,
  });
  poolApp.world.players.find((p) => p.name === 'Pool Tester').lpShares = 250;

  r = await req(pa.port, 'GET', '/api/pool', { cookie: pcookie });
  check('an open pool reports open', r.data.open === true);
  check('gold is priced below wood, as the tuning found',
    Math.abs((r.data.prices?.find((p) => p.from === 'wood' && p.to === 'gold')?.price ?? NaN) - 4000 / 6800) < 1e-9);
  check('the floor is derived from what was seeded', r.data.floor?.stone === 900);
  check('a quarter share is reported as a quarter',
    r.data.mine?.shares === 250 && Math.abs(r.data.mine?.share - 0.25) < 1e-9);
  check('and valued pro rata', Math.abs(r.data.mine?.value?.gold - 1700) < 1e-9);

  r = await req(pa.port, 'GET', '/api/pool?from=wood&to=gold&amount=500', { cookie: pcookie });
  const expect = 6800 - (4000 * 6800) / (4000 + 500 * 0.997);
  check('a live quote follows x*y=k after fee',
    Math.abs(r.data.quote?.out - expect) < 1e-9, `got ${r.data.quote?.out}`);
  check('and reports impact', r.data.quote?.impact > 0 && r.data.quote?.capped === false);

  r = await req(pa.port, 'GET', '/api/pool?from=wood&to=gold&amount=999999', { cookie: pcookie });
  check('an oversized quote is capped, not refused',
    r.data.quote?.capped === true && r.data.quote?.out > 0 && r.data.quote?.used < 999999);

  // A position cannot be reported as negative. Nothing writes lpShares yet,
  // but step 6 will, and shares/share/value disagreeing with each other is
  // exactly the kind of inconsistency a UI would render as a bug.
  poolApp.world.players.find((p) => p.name === 'Pool Tester').lpShares = -50;
  r = await req(pa.port, 'GET', '/api/pool', { cookie: pcookie });
  check('a negative position reports as zero, not negative',
    r.data.mine?.shares === 0 && r.data.mine?.share === 0);
  check('and stays consistent with its valuation',
    ['wood', 'stone', 'gold'].every((x) => r.data.mine?.value?.[x] === 0));
  poolApp.world.players.find((p) => p.name === 'Pool Tester').lpShares = 250;

  const beforeQuoting = JSON.stringify(poolApp.world.pool);
  await req(pa.port, 'GET', '/api/pool?from=gold&to=stone&amount=99999', { cookie: pcookie });
  check('quoting an open pool still mutates nothing',
    JSON.stringify(poolApp.world.pool) === beforeQuoting);

  pa.srv.close();
  poolApp.stop();

  // ---------------------------------------------------------------- admin: open the pool
  // Seeding mints resources, so it is admin-only and must stay that way.
  console.log('\npool opening (admin)');
  const openApp = createApp({ botCount: 1, freeIsles: 1, log: silent, adminToken: 'sekrit-admin' });
  // Every app in this file shares one DATA_DIR, and stop() saves — so this
  // world arrives carrying the pool the previous block opened by hand. Reset
  // it, or the seeding path is tested against an already-open pool.
  Object.assign(openApp.world.pool, game.newPool());
  for (const p of openApp.world.players) p.lpShares = 0;
  const oa = await serve(openApp);

  r = await req(oa.port, 'POST', '/api/admin/pool/open', { body: { wood: 4000, stone: 3600, gold: 6800 } });
  check('opening without the admin token is refused', r.status === 403);
  check('and did not open the pool', openApp.world.pool.open === false);

  r = await req(oa.port, 'POST', '/api/register', { body: { name: 'Pool Player', password: 'sekrit', lang: 'en' } });
  const ocookie = (r.headers.get('set-cookie') || '').split(';')[0];
  r = await req(oa.port, 'POST', '/api/admin/pool/open', { body: { wood: 4000, stone: 3600, gold: 6800 }, cookie: ocookie });
  check('a logged-in player cannot open it either', r.status === 403);

  for (const bad of [{}, { wood: 4000, stone: 3600 }, { wood: 0, stone: 1, gold: 1 }]) {
    r = await req(oa.port, 'POST', '/api/admin/pool/open',
      { body: { ...bad, token: 'sekrit-admin' } });
    check(`seed ${JSON.stringify(bad)} is a 400`, r.status === 400, `got ${r.status}`);
  }
  check('no bad seed opened it', openApp.world.pool.open === false);

  r = await req(oa.port, 'POST', '/api/admin/pool/open',
    { body: { wood: 4000, stone: 3600, gold: 6800, token: 'sekrit-admin' } });
  check('a valid seed opens the pool', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  check('the response reports the reserves', r.data.reserves?.gold === 6800);
  check('and the shares minted', Math.abs(r.data.totalShares - Math.sqrt(4000 * 3600)) < 1e-6);

  r = await req(oa.port, 'POST', '/api/admin/pool/open',
    { body: { wood: 1, stone: 1, gold: 1, token: 'sekrit-admin' } });
  check('opening an open pool is a 400', r.status === 400);
  check('and did not reprice it', openApp.world.pool.reserves.wood === 4000);

  // The read-only endpoint now has something real to say.
  r = await req(oa.port, 'GET', '/api/pool', { cookie: ocookie });
  check('GET /api/pool reports it open', r.data.open === true);
  check('with the tuned price — gold below wood',
    Math.abs(r.data.prices?.find((p) => p.from === 'wood' && p.to === 'gold')?.price - 4000 / 6800) < 1e-9);
  check('and a floor derived from the seed', r.data.floor?.stone === 900);

  r = await req(oa.port, 'GET', '/api/pool?from=wood&to=gold&amount=500', { cookie: ocookie });
  check('an open pool gives a real quote', r.data.quote?.out > 500,
    `500 wood -> ${r.data.quote?.out} gold`);

  // Close, then reopen: an off switch, not a demolition.
  r = await req(oa.port, 'POST', '/api/admin/pool/close', { body: { token: 'sekrit-admin' } });
  check('closing works', r.status === 200 && openApp.world.pool.open === false);
  r = await req(oa.port, 'POST', '/api/admin/pool/close', { body: { token: 'sekrit-admin' } });
  check('closing a shut pool is a 400', r.status === 400);
  r = await req(oa.port, 'POST', '/api/admin/pool/open', { body: { wood: 9, stone: 9, gold: 9, token: 'sekrit-admin' } });
  check('reopening resumes rather than reseeding',
    r.status === 200 && r.data.resumed === true && openApp.world.pool.reserves.wood === 4000,
    JSON.stringify(r.data));

  // ---------------------------------------------------------------- POST /api/pool/swap
  // The first endpoint through which a player can move resources. The pool is
  // already open on this app from the block above.
  console.log('\npool swap (POST)');
  const swapper = openApp.world.players.find((p) => p.name === 'Pool Player');
  const isl = openApp.world.islands.find((i) => i.ownerId === swapper.id);
  isl.buildings.harbor = 5;
  isl.buildings.storehouse = 12;
  isl.buildings.lumberyard = 0; isl.buildings.quarry = 0; isl.buildings.goldmine = 0;
  openApp.world.pool.open = true;
  const gameMod = game;
  gameMod.resolveIsland(isl, Date.now());
  isl.resources = { wood: 5000, stone: 5000, gold: 5000 };

  r = await req(oa.port, 'POST', '/api/pool/swap',
    { body: { islandId: isl.id, from: 'wood', to: 'gold', amount: 500 } });
  check('swapping without a session is refused', r.status === 401);

  // This world is still in pregame from the season-reset block above, which
  // makes it the natural place to assert the freeze applies to swaps too — a
  // swap is world-mutating, so it belongs in PREGAME_BLOCKED like every other
  // action. Found by the fixture rather than by design, but worth keeping.
  r = await req(oa.port, 'POST', '/api/pool/swap',
    { body: { islandId: isl.id, from: 'wood', to: 'gold', amount: 500 }, cookie: ocookie });
  check('the pregame freeze blocks swaps', r.status === 409, `got ${r.status}`);
  check('and nothing moved during the freeze',
    isl.resources.wood === 5000 && openApp.world.pool.reserves.wood === 4000);

  openApp.world.startAt = Date.now() - 1000; // launch the season
  r = await req(oa.port, 'GET', '/api/meta');
  check('the season is live now', r.data.phase === 'live', JSON.stringify(r.data));

  for (const [label, body, want] of [
    ['same resource', { from: 'wood', to: 'wood', amount: 500 }, 400],
    ['unknown resource', { from: 'wood', to: 'iron', amount: 500 }, 400],
    ['zero amount', { from: 'wood', to: 'gold', amount: 0 }, 400],
    ['negative amount', { from: 'wood', to: 'gold', amount: -500 }, 400],
    ['unaffordable', { from: 'wood', to: 'gold', amount: 99999 }, 400],
    ['unusable minOut', { from: 'wood', to: 'gold', amount: 500, minOut: 'abc' }, 400],
    ['unreachable minOut', { from: 'wood', to: 'gold', amount: 500, minOut: 1e9 }, 400],
  ]) {
    r = await req(oa.port, 'POST', '/api/pool/swap',
      { body: { islandId: isl.id, ...body }, cookie: ocookie });
    check(`${label} is a ${want}`, r.status === want, `got ${r.status} ${JSON.stringify(r.data)}`);
  }
  check('none of those moved anything',
    isl.resources.wood === 5000 && openApp.world.pool.reserves.wood === 4000);

  // A good swap, checked for conservation across the API boundary.
  const poolWoodBefore = openApp.world.pool.reserves.wood;
  const poolGoldBefore = openApp.world.pool.reserves.gold;
  const movementsBefore = openApp.world.movements.length;
  // Captured BEFORE the request: travel time has a 5s floor, so comparing
  // `arrive` against Date.now() *after* the round trip races the handler and
  // flaps on a slow machine.
  const sentAt = Date.now();
  r = await req(oa.port, 'POST', '/api/pool/swap',
    { body: { islandId: isl.id, from: 'wood', to: 'gold', amount: 500 }, cookie: ocookie });
  check('a good swap succeeds', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  check('and reports what it did',
    r.data.out > 500 && r.data.used === 500 && r.data.arrive >= sentAt + 5000,
    JSON.stringify(r.data));
  const swapOut = r.data.out;
  check('the island paid exactly `used`', Math.abs(isl.resources.wood - (5000 - r.data.used)) < 1e-9);
  check('the pool gained exactly `used`',
    Math.abs(openApp.world.pool.reserves.wood - (poolWoodBefore + r.data.used)) < 1e-9);
  check('the pool gave up exactly `out`',
    Math.abs(openApp.world.pool.reserves.gold - (poolGoldBefore - r.data.out)) < 1e-9);
  check('nothing is credited before the ship lands', isl.resources.gold === 5000);
  check('exactly one new shipment was created',
    openApp.world.movements.length === movementsBefore + 1,
    `${movementsBefore} -> ${openApp.world.movements.length}`);
  // Match on everything that identifies THIS swap. Any `trade` movement to
  // this island satisfied the old check, and the suite reuses one world across
  // blocks, so a leftover from an earlier block would have passed it.
  const mine = openApp.world.movements.find((m) => m.type === 'trade'
    && m.ownerId === swapper.id && m.fromId === isl.id && m.toId === isl.id
    && m.arrive === r.data.arrive);
  check('and it is this swap: right owner, island, arrival and cargo',
    !!mine && Math.abs(mine.loot.gold - r.data.out) < 1e-9
    && mine.loot.wood === 0 && mine.loot.stone === 0,
    JSON.stringify(mine && mine.loot));

  // A quote taken now must reflect the swap that just happened. Compared
  // against the actual fill, not a loose bound — `out < 1000` passed even when
  // no swap had happened at all.
  r = await req(oa.port, 'GET', '/api/pool?from=wood&to=gold&amount=500', { cookie: ocookie });
  const nextOut = r.data.quote?.out;
  check('the next quote is strictly worse than the fill just received',
    nextOut > 0 && nextOut < swapOut, `now ${nextOut} vs just filled ${swapOut}`);

  // Fractional amounts. The swap floors, so the quote must floor identically
  // or minOut derived from the quote is unreachable and the swap fails with
  // "the price moved" when nothing moved — 1.9 quoted as 1.9 but swapped as 1.
  r = await req(oa.port, 'GET', '/api/pool?from=wood&to=gold&amount=500.7', { cookie: ocookie });
  const fracQuote = r.data.quote;
  check('a fractional quote is floored', fracQuote?.amountIn === 500,
    `amountIn ${fracQuote?.amountIn}`);
  r = await req(oa.port, 'GET', '/api/pool?from=wood&to=gold&amount=500', { cookie: ocookie });
  check('and matches the whole-number quote exactly',
    Math.abs(fracQuote.out - r.data.quote.out) < 1e-12,
    `${fracQuote.out} vs ${r.data.quote.out}`);

  // The end-to-end case that was broken: quote a fractional amount, derive
  // minOut from it, swap. Small amounts are where flooring bites hardest.
  for (const amt of [500.7, 1.9]) {
    r = await req(oa.port, 'GET', `/api/pool?from=wood&to=gold&amount=${amt}`, { cookie: ocookie });
    const q = r.data.quote;
    if (!(q?.out > 0)) { check(`quote for ${amt} is usable`, false, JSON.stringify(q)); continue; }
    r = await req(oa.port, 'POST', '/api/pool/swap', {
      body: { islandId: isl.id, from: 'wood', to: 'gold', amount: amt, minOut: q.out * 0.99 },
      cookie: ocookie,
    });
    check(`quote-then-swap at ${amt} is not a spurious slippage failure`,
      r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
    check(`and delivers at least the quoted minus tolerance at ${amt}`,
      r.data.out >= q.out * 0.99, `got ${r.data.out} vs quoted ${q.out}`);
  }

  // Which island did it actually swap from? myIsland() falls back to your
  // FIRST island when the id is not one of yours — the convention every
  // handler uses — so a bad id can never touch someone else's island, but it
  // must not silently use the wrong one of yours either.
  const second = gameMod.newIsland(openApp.world, swapper.id, 'Second Isle');
  second.buildings.harbor = 5;
  second.buildings.storehouse = 12;
  second.buildings.lumberyard = 0; second.buildings.quarry = 0; second.buildings.goldmine = 0;
  gameMod.resolveIsland(second, Date.now());
  second.resources = { wood: 3000, stone: 3000, gold: 3000 };
  const firstWood = isl.resources.wood;

  r = await req(oa.port, 'POST', '/api/pool/swap',
    { body: { islandId: second.id, from: 'wood', to: 'gold', amount: 200 }, cookie: ocookie });
  check('a swap debits the island it was told to', r.status === 200
    && Math.abs(second.resources.wood - (3000 - r.data.used)) < 1e-9,
    `second isle wood ${second.resources.wood}`);
  check('and leaves the other island alone', Math.abs(isl.resources.wood - firstWood) < 1e-9);

  // Another player's island id must not reach their resources.
  const other = openApp.world.players.find((p) => p.id !== swapper.id && !p.isBot)
    || openApp.world.players.find((p) => p.isBot);
  const otherIsle = openApp.world.islands.find((i) => i.ownerId === other.id);
  const otherWoodBefore = otherIsle.resources.wood;
  r = await req(oa.port, 'POST', '/api/pool/swap',
    { body: { islandId: otherIsle.id, from: 'wood', to: 'gold', amount: 100 }, cookie: ocookie });
  check("another player's island is never debited",
    Math.abs(otherIsle.resources.wood - otherWoodBefore) < 1e-6,
    `${otherWoodBefore} -> ${otherIsle.resources.wood}`);

  // Closing stops new swaps.
  await req(oa.port, 'POST', '/api/admin/pool/close', { body: { token: 'sekrit-admin' } });
  r = await req(oa.port, 'POST', '/api/pool/swap',
    { body: { islandId: isl.id, from: 'wood', to: 'gold', amount: 100 }, cookie: ocookie });
  check('a closed pool refuses swaps over HTTP', r.status === 400, `got ${r.status}`);

  // ---------------------------------------------------------------- liquidity
  // The preview and the action are the SAME function, so the property to pin
  // is that they cannot disagree — the failure mode that bit the quote and
  // the swap over fractional amounts in 7a.
  console.log('\npool liquidity (POST)');
  openApp.world.pool.open = true;
  isl.buildings.harbor = 10;
  isl.buildings.storehouse = 14;
  gameMod.resolveIsland(isl, Date.now());
  isl.resources = { wood: 20000, stone: 20000, gold: 20000 };
  swapper.lpShares = 0;

  r = await req(oa.port, 'POST', '/api/pool/deposit', { body: { islandId: isl.id, wood: 500 } });
  check('depositing without a session is refused', r.status === 401);

  r = await req(oa.port, `GET`, `/api/pool?islandId=${isl.id}&deposit=500`, { cookie: ocookie });
  const dPlan = r.data.depositPlan;
  check('the deposit preview is returned', !!dPlan && !dPlan.error, JSON.stringify(dPlan));
  check('the preview does not mint', swapper.lpShares === 0);

  r = await req(oa.port, 'POST', '/api/pool/deposit',
    { body: { islandId: isl.id, wood: 500 }, cookie: ocookie });
  check('the deposit succeeds', r.status === 200, JSON.stringify(r.data));
  check('and mints exactly what the preview promised',
    Math.abs(r.data.minted - dPlan.minted) < 1e-9, `${r.data.minted} vs ${dPlan.minted}`);
  check('and costs exactly what the preview promised',
    r.status === 200 && ['wood','stone','gold'].every((x) => Math.abs(r.data.required?.[x] - dPlan.required[x]) < 1e-9),
    JSON.stringify({ got: r.data.required, promised: dPlan.required }));
  const minted = r.data.minted;
  check('the player holds the shares', Math.abs(swapper.lpShares - minted) < 1e-9);

  // A fractional deposit must be floored identically by preview and action —
  // the exact shape of the 7a bug.
  r = await req(oa.port, `GET`, `/api/pool?islandId=${isl.id}&deposit=300.9`, { cookie: ocookie });
  const fracPlan = r.data.depositPlan;
  r = await req(oa.port, `GET`, `/api/pool?islandId=${isl.id}&deposit=300`, { cookie: ocookie });
  check('a fractional deposit preview matches the whole-number one',
    Math.abs(fracPlan.minted - r.data.depositPlan.minted) < 1e-12);
  r = await req(oa.port, 'POST', '/api/pool/deposit',
    { body: { islandId: isl.id, wood: 300.9, minShares: fracPlan.minted }, cookie: ocookie });
  check('and a fractional deposit is not a spurious slippage failure',
    r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);

  // A preview error must carry its placeholders. err.tradeCapacity says
  // "your Harbor can carry {cap}" — without errorParams the player is shown
  // the brace.
  r = await req(oa.port, `GET`, `/api/pool?islandId=${isl.id}&deposit=999999`, { cookie: ocookie });
  const errPlan = r.data.depositPlan;
  check('a preview error is reported', !!errPlan?.error, JSON.stringify(errPlan));
  check('and carries its params so the message can render',
    errPlan.error === 'err.noResources'
      ? (errPlan.errorParams?.need > 0 && !!errPlan.errorParams?.res)
      : errPlan.errorParams?.cap > 0,
    JSON.stringify(errPlan));

  // The preview must resolve the island exactly as the action does. Reading
  // the stored object shows pre-accrual resources and a pre-upgrade harbour,
  // so the preview refused deposits the POST accepted — a preview/action
  // disagreement that sharing the planner does not prevent, because it is
  // about the INPUT each side reads, not the maths.
  {
    // Its own player, so this block gets its own rate-limit bucket. Adding one
    // more POST to the shared one tipped the block past 20-per-10s and failed
    // a later check with "Slow down".
    r = await req(oa.port, 'POST', '/api/register',
      { body: { name: 'Stale Tester', password: 'sekrit', lang: 'en' } });
    const scookie = (r.headers.get('set-cookie') || '').split(';')[0];
    const staler = openApp.world.players.find((p) => p.name === 'Stale Tester');
    const stale = gameMod.newIsland(openApp.world, staler.id, 'Stale Isle');
    stale.buildings.harbor = 10;
    stale.buildings.storehouse = 14;
    stale.buildings.lumberyard = 15;
    stale.buildings.quarry = 15;
    stale.buildings.goldmine = 15;
    gameMod.resolveIsland(stale, Date.now());
    stale.resources = { wood: 100, stone: 100, gold: 100 };
    stale.lastUpdate = Date.now() - 3600 * 1000;   // an hour of pending accrual

    r = await req(oa.port, `GET`, `/api/pool?islandId=${stale.id}&deposit=500`, { cookie: scookie });
    check('the preview resolves the island before planning',
      !r.data.depositPlan?.error, JSON.stringify(r.data.depositPlan));

    stale.resources = { wood: 100, stone: 100, gold: 100 };
    stale.lastUpdate = Date.now() - 3600 * 1000;
    r = await req(oa.port, 'POST', '/api/pool/deposit',
      { body: { islandId: stale.id, wood: 500 }, cookie: scookie });
    check('and the action agrees with it', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);

    // Same for withdrawal, where the stale field that bites is the HARBOUR:
    // resolveIsland completes finished builds, so an unresolved island still
    // shows the old level and mis-caps (or refuses) the shipment.
    const stStaler = openApp.world.players.find((p) => p.name === 'Stale Tester');
    check('the stale tester holds a stake', stStaler.lpShares > 0);
    stale.buildings.harbor = 0;                       // no harbour => err.buildFirst
    stale.queue = [{ building: 'harbor', level: 10, finish: Date.now() - 60_000 }];
    stale.lastUpdate = Date.now() - 3600 * 1000;
    r = await req(oa.port, `GET`, `/api/pool?islandId=${stale.id}&withdraw=${stStaler.lpShares}`,
      { cookie: scookie });
    check('the withdraw preview resolves the island too',
      !r.data.withdrawPlan?.error, JSON.stringify(r.data.withdrawPlan));
    check('and the finished harbour upgrade is what made it possible',
      stale.buildings.harbor === 10, `harbour ${stale.buildings.harbor}`);
  }

  // Withdraw.
  const held = swapper.lpShares;
  r = await req(oa.port, `GET`, `/api/pool?islandId=${isl.id}&withdraw=${held}`, { cookie: ocookie });
  const wPlan = r.data.withdrawPlan;
  check('the withdraw preview is returned', !!wPlan && !wPlan.error, JSON.stringify(wPlan));
  const woodBeforeW = isl.resources.wood;

  r = await req(oa.port, 'POST', '/api/pool/withdraw',
    { body: { islandId: isl.id, shares: held }, cookie: ocookie });
  check('the withdrawal succeeds', r.status === 200, JSON.stringify(r.data));
  check('and returns exactly what the preview promised',
    r.status === 200 && !wPlan.error
      && ['wood','stone','gold'].every((x) => Math.abs(r.data.out?.[x] - wPlan.out?.[x]) < 1e-9),
    JSON.stringify({ got: r.data.out, promised: wPlan.out }));
  check('the shares are gone', swapper.lpShares === 0);
  check('nothing is credited before the ship lands', isl.resources.wood === woodBeforeW);
  check('a shipment is in flight', r.data.arrive > Date.now());

  r = await req(oa.port, 'POST', '/api/pool/withdraw',
    { body: { islandId: isl.id, shares: 100 }, cookie: ocookie });
  check('withdrawing with no stake is a 400', r.status === 400);
  check('and says so, rather than blaming the request',
    r.data.error && !/request/i.test(r.data.error), r.data.error);

  // A malformed request must not masquerade as "you have no stake". Number()
  // turns these into NaN, poolAmount turns NaN into 0, and the player was
  // told something both wrong and unactionable.
  //
  // Own player again: the POST budget is 20 per 10s per player, and six more
  // on the shared one tipped it into "Slow down" — which then failed the
  // checks AFTER it too, not just these.
  r = await req(oa.port, 'POST', '/api/register',
    { body: { name: 'Malformed Tester', password: 'sekrit', lang: 'en' } });
  const mcookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const mIsle = gameMod.playerIslands(openApp.world,
    openApp.world.players.find((p) => p.name === 'Malformed Tester').id)[0];
  for (const bad of [undefined, null, 'abc', {}, -5, 0]) {
    r = await req(oa.port, 'POST', '/api/pool/withdraw',
      { body: { islandId: mIsle.id, shares: bad }, cookie: mcookie });
    check(`shares=${JSON.stringify(bad)} is a bad request, not "no stake"`,
      r.status === 400 && /request/i.test(r.data.error || ''),
      `${r.status} ${JSON.stringify(r.data)}`);
  }

  // Strings over the wire. poolAmount deliberately refuses them, so the HTTP
  // layer has to coerce — and it has to do so on the ACTION as well as the
  // preview, or a holder is told they have no stake. The preview coerced and
  // the POST did not, which is the same preview/action split this whole step
  // was built to avoid, reintroduced one layer above the shared planner.
  r = await req(oa.port, 'POST', '/api/pool/deposit',
    { body: { islandId: isl.id, wood: '400' }, cookie: ocookie });
  check('a string deposit amount is accepted', r.status === 200, JSON.stringify(r.data));
  const strShares = String(swapper.lpShares);
  r = await req(oa.port, 'POST', '/api/pool/withdraw',
    { body: { islandId: isl.id, shares: strShares }, cookie: ocookie });
  check('a string share count is accepted, not read as no stake',
    r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  check('and it burned the whole holding', swapper.lpShares === 0);

  // ------------------------------------- catalog requirements (the beacon-at-hall-9 bug)
  // tryBuild always enforced building requirements; the catalog never
  // mentioned them, so the client lit the Beacon whenever it was affordable.
  {
    console.log('\ncatalog requirements');
    r = await req(oa.port, 'GET', '/api/state', { cookie: ocookie });
    const wonderRow = r.data.buildings && r.data.buildings.wonder;
    check('the wonder row reports its unmet requirement',
      wonderRow && wonderRow.needs && wonderRow.needs.level === 10
      && typeof wonderRow.needs.building === 'string',
      JSON.stringify(wonderRow && wonderRow.needs));
    isl.buildings.hall = 10;
    r = await req(oa.port, 'GET', '/api/state', { cookie: ocookie });
    check('and clears it at hall 10', !(r.data.buildings.wonder.needs));
    isl.buildings.hall = 1;
  }

  // ------------------------------------- the islands table payload (#77)
  // The table's value is that you can trust it without clicking through. So
  // every figure is checked against game.js for EVERY island, not just the
  // active one — a payload that silently reported the active island's numbers
  // on all rows would look perfectly fine on screen.
  {
    console.log('\nislands payload (#77)');
    // Make the two islands genuinely differ, so a copied row cannot pass.
    second.buildings.wall = 4;
    second.units = { spearman: 30, sentinel: 10 };
    isl.buildings.wall = 0;
    isl.units = {};
    // Rewind the NON-active island's clock. stateFor used to resolve only the
    // active island, so its row would report an hour-stale resources column
    // while looking perfectly plausible. Only a clock that has moved proves
    // the poll resolved it.
    second.buildings.lumberyard = 5;   // an earlier block zeroed it; it must produce
    // #87 positive case: a queued training batch must surface as nextFinish.
    second.trainQueue = [{ unit: 'spearman', count: 2, finish: Date.now() + 600000 }];
    const staleAt = Date.now() - 3600_000;
    second.lastUpdate = staleAt;
    second.resources = { wood: 100, stone: 100, gold: 100 };

    r = await req(oa.port, 'GET', '/api/state', { cookie: ocookie });
    const rows = r.data.islands;
    check('state carries a row for every island held',
      rows.length === 2 && rows.some((x) => x.id === isl.id) && rows.some((x) => x.id === second.id),
      JSON.stringify(rows.map((x) => x.id)));

    for (const row of rows) {
      const src = openApp.world.islands.find((i) => i.id === row.id);
      const where = `island ${row.id}`;
      check(`${where}: points match game.js`,
        row.points === gameMod.islandPoints(src), `${row.points} vs ${gameMod.islandPoints(src)}`);
      check(`${where}: pop matches game.js`,
        row.popUsed === Math.round(gameMod.popUsed(src)) && row.popCap === gameMod.popCap(src.buildings.farm),
        `${row.popUsed}/${row.popCap}`);
      check(`${where}: wall level matches game.js`, row.wall === src.buildings.wall, row.wall);
      // Defence is the number combat uses — units plus the wall's flat
      // contribution, times the wall's multiplier. Not the raw unit total: a
      // level-4 wall on an empty island is not zero defence.
      const want = Math.round(
        (gameMod.unitPower(src.units, 'def') + gameMod.WALL_FLAT_DEF * src.buildings.wall)
        * (1 + gameMod.WALL_DEF_BONUS * src.buildings.wall));
      check(`${where}: defence matches the combat formula`, row.defence === want, `${row.defence} vs ${want}`);
      check(`${where}: resources match the resolved island`,
        row.resources.wood === Math.floor(src.resources.wood)
        && row.resources.stone === Math.floor(src.resources.stone)
        && row.resources.gold === Math.floor(src.resources.gold),
        JSON.stringify(row.resources));
      check(`${where}: capacity matches game.js`,
        row.capacity === gameMod.storageCapacity(src.buildings.storehouse), row.capacity);
      // The rates the table renders under each stock figure (#77 follow-up):
      // they must be the island's own, not the active island's — the same
      // copied-row hazard every other figure in this block guards against.
      const wantRates = gameMod.islandRates(src);
      // #87: the chip's per-island source must be the island's own queue
      // heads — same copied-row hazard as every other figure here.
      const wantNext = (() => {
        const c = [];
        if (src.queue && src.queue.length) c.push(src.queue[0].finish);
        if (src.trainQueue && src.trainQueue.length) c.push(src.trainQueue[0].finish);
        return c.length ? Math.min(...c) : null;
      })();
      check(`${where}: nextFinish matches the queue heads`,
        (wantNext == null && row.nextFinish == null)
        || (row.nextFinish && row.nextFinish.at === wantNext),
        JSON.stringify(row.nextFinish));
      check(`${where}: production rates match game.js`,
        row.rates && row.rates.wood === wantRates.wood
        && row.rates.stone === wantRates.stone && row.rates.gold === wantRates.gold,
        JSON.stringify(row.rates));
    }

    // The two rows must actually differ, or every check above could pass
    // against one island reported twice.
    const [ra, rb] = rows;
    check('the rows are per-island, not the active island repeated',
      ra.defence !== rb.defence && ra.id !== rb.id, `${ra.defence} vs ${rb.defence}`);

    // A row for an island you do not hold would be an information leak.
    const mineIds = new Set(openApp.world.islands.filter((i) => i.ownerId === swapper.id).map((i) => i.id));
    check('no row for an island the player does not hold',
      rows.every((x) => mineIds.has(x.id)));

    // The poll must have moved the non-active island's clock forward, and its
    // row must carry the production that resolve earned — not the stale 100.
    check('the state poll resolved the non-active island too',
      second.lastUpdate > staleAt, `${second.lastUpdate} vs ${staleAt}`);
    const secondRow = rows.find((x) => x.id === second.id);
    check('and its row reports the resolved figures, not the stale ones',
      secondRow.resources.wood > 100 || secondRow.resources.stone > 100,
      JSON.stringify(secondRow.resources));
  }

  oa.srv.close();
  openApp.stop();

  // ------------------------------------- the train quote is the real total (#62)
  //
  // The catalog can only carry a single-unit price, and the Colony Ship steps
  // per ship, so cost x count under-quotes by 4.3x at ten ships. The endpoint
  // must agree with what tryTrain actually charges, and refuse exactly what it
  // refuses — a preview that accepts more than the action is how the pool's
  // seams kept reopening.
  console.log('\ntrain quote (#62)');
  const qApp = createApp({ botCount: 0, freeIsles: 6, log: silent });
  const qa = await serve(qApp);
  r = await req(qa.port, 'POST', '/api/register',
    { body: { name: 'Quoter', password: 'sekrit', lang: 'en' } });
  const qcookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const qw = qApp.world;
  const qp = qw.players.find((p) => p.name === 'Quoter');
  const qi = qw.islands.find((i) => i.ownerId === qp.id);

  r = await req(qa.port, 'GET', `/api/train/quote?islandId=${qi.id}&unit=colonyship&count=3`,
    { cookie: qcookie });
  check('#62 the endpoint answers', r.status === 200, JSON.stringify(r.data));
  check('#62 it echoes what was asked', r.data.unit === 'colonyship' && r.data.count === 3);
  check('#62 and it matches what training would charge',
    JSON.stringify(r.data.cost) === JSON.stringify(game.trainCost(qw, qi, 'colonyship', 3)),
    JSON.stringify(r.data.cost));
  check('#62 every leg is finite, never null on the wire',
    ['wood', 'stone', 'gold'].every((k) => Number.isFinite(r.data.cost[k])));

  for (const [count, why] of [[0, 'zero'], [501, 'over the cap'], ['abc', 'junk'], [-1, 'negative']]) {
    r = await req(qa.port, 'GET', `/api/train/quote?islandId=${qi.id}&unit=colonyship&count=${count}`,
      { cookie: qcookie });
    check(`#62 a ${why} count is refused`, r.status === 400, `${count} -> ${r.status}`);
  }
  r = await req(qa.port, 'GET', `/api/train/quote?islandId=${qi.id}&unit=nope&count=1`,
    { cookie: qcookie });
  check('#62 an unknown unit is refused', r.status === 400);
  r = await req(qa.port, 'GET', '/api/train/quote?islandId=1&unit=spearman&count=2');
  check('#62 it needs a session', r.status === 401);
  // 2.5 floors to 2, exactly as tryTrain does.
  r = await req(qa.port, 'GET', `/api/train/quote?islandId=${qi.id}&unit=spearman&count=2.5`,
    { cookie: qcookie });
  check('#62 a fractional count floors rather than refusing',
    r.status === 200 && r.data.count === 2, JSON.stringify(r.data));

  // The checks above all run at the default growth of 1, where per-unit x count
  // is exact — so a handler that returned `unitCost x count` would pass every
  // one of them, which is precisely the bug #62 is about. The knob is read at
  // module load, so the stepped case needs a child process.
  {
    const probe = `
      // Its own data dir: the parent already holds the lock on theirs, and
      // createApp refuses to start on a directory another pid owns.
      const fsm = await import('node:fs');
      const osm = await import('node:os');
      const pathm = await import('node:path');
      process.env.DATA_DIR = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'tideholm-step-'));
      process.env.HALL_FILE = pathm.join(process.env.DATA_DIR, 'hall.json');
      const http = await import('node:http');
      const game = await import('./game.js');
      const { createApp } = await import('./app.js');
      const app = createApp({ botCount: 0, freeIsles: 6, log: { log() {}, error() {} } });
      const srv = http.createServer(app.handle);
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      const call = async (m, p, body, cookie) => {
        const res = await fetch('http://127.0.0.1:' + port + p, {
          method: m,
          headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, data: await res.json().catch(() => null), res };
      };
      let r = await call('POST', '/api/register', { name: 'Stepper', password: 'sekrit', lang: 'en' });
      const cookie = (r.res.headers.get('set-cookie') || '').split(';')[0];
      const w = app.world;
      const p = w.players.find((x) => x.name === 'Stepper');
      const isl = w.islands.find((i) => i.ownerId === p.id);
      isl.units.colonyship = 4; // position 5, matching the figures in #62
      const q = await call('GET', '/api/train/quote?islandId=' + isl.id + '&unit=colonyship&count=3', null, cookie);
      console.log(JSON.stringify({
        growth: game.COLONY_COST_GROWTH,
        quoted: q.data && q.data.cost,
        engine: game.trainCost(w, isl, 'colonyship', 3),
        naive: game.trainCost(w, isl, 'colonyship', 1).wood * 3,
      }));
      srv.close(); app.stop();
      try { fsm.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* gone */ }
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      env: { ...process.env, COLONY_COST_GROWTH: '1.3' }, encoding: 'utf8', cwd: HERE,
    }).trim().split('\n').pop());

    check('#62 the child really is running stepped', out.growth === 1.3);
    check('#62 stepped: the quote matches what training charges',
      JSON.stringify(out.quoted) === JSON.stringify(out.engine),
      `${JSON.stringify(out.quoted)} vs ${JSON.stringify(out.engine)}`);
    check('#62 stepped: and it is NOT single-price x count',
      out.quoted.wood !== out.naive, `both ${out.quoted.wood}`);
    check('#62 stepped: the real figures from the issue (13675 vs 10281)',
      out.quoted.wood === 13675 && out.naive === 10281,
      `${out.quoted.wood} / ${out.naive}`);
  }

  qa.srv.close();
  qApp.stop();

  // ------------------------------- every movement type has a label (#66 gap)
  //
  // The merchant leg shipped in #30 with no i18n key, so the movements list
  // rendered the literal string "ui.move.merchant". Engine mutation testing
  // could never catch it: the type was correct, it just had nothing to render
  // with. This asserts the two lists agree, in every language.
  console.log('\nmovement labels');
  {
    const src = fs.readFileSync(new URL('./game.js', import.meta.url), 'utf8');
    const types = [...new Set([...src.matchAll(/type: '([a-z]+)'/g)].map((m) => m[1]))].sort();
    const i18nSrc = fs.readFileSync(new URL('./public/i18n.js', import.meta.url), 'utf8');
    check('found the movement types in game.js', types.length >= 6, types.join(','));
    // One check per type: the count IS the existence check, and a weaker
    // "does it exist anywhere" passed while the key was missing from English.
    for (const ty of types) {
      const n = (i18nSrc.match(new RegExp(`'ui\\.move\\.${ty}':`, 'g')) || []).length;
      check(`ui.move.${ty} is translated in all 3 languages`, n === 3, `${n} of 3`);
    }
    // and the reverse: no orphan label for a type the engine cannot emit
    const labels = [...new Set([...i18nSrc.matchAll(/'ui\.move\.([a-z]+)':/g)].map((m) => m[1]))];
    const orphans = labels.filter((l) => !types.includes(l) && l !== 'incoming' && l !== 'withLoot');
    check('no label for a type the engine never emits', orphans.length === 0, orphans.join(','));
  }

  // ------------------------------------- the islands table is translated (#77)
  // Same lesson as #75: my first version of these headers carried
  // title="wood" — hardcoded English, invisible to a screen reader, and the
  // only untranslated string in index.html. Assert every header in this table
  // is labelled through i18n, and that every key resolves in all 3 languages.
  {
    console.log('\nislands table headers');
    const html = fs.readFileSync(path.join(HERE, 'public/index.html'), 'utf8');
    const pane = html.slice(html.indexOf('id="view-islands"'), html.indexOf('id="view-map"'));
    const ths = [...pane.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[0]);
    check('found the islands table headers (9 cols + totals/production/at-sea + 4 movement cols)', ths.length === 16, ths.length); // #104 added 5

    const i18n = await import('./public/i18n.js');
    for (const th of ths) {
      const key = (th.match(/data-i18n="([^"]+)"/) || [])[1];
      const label = th.replace(/<[^>]*>/g, '').trim();
      check(`header is labelled through i18n: ${key || label || th}`, !!key, th);
      if (!key) continue;
      const missing = i18n.LANGS.filter((l) => i18n.t(l, key) === key);
      check(`  ${key} resolves in all 3 languages`, missing.length === 0, missing.join(','));
    }
    // No hardcoded English left in the pane. title= is how it got in last time.
    check('no hardcoded title= attribute in the islands pane',
      !/\stitle="/.test(pane), (pane.match(/\stitle="[^"]*"/g) || []).join(' '));
    // An emoji header must still say something to a screen reader — checked
    // per header, not by counting: equal counts across the pane would pass
    // even if one <th> had both and another had neither.
    const hidden = ths.filter((th) => th.includes('aria-hidden="true"'));
    check('the emoji headers are the three resource columns', hidden.length === 3, hidden.length);
    for (const th of hidden) {
      check(`  its emoji is paired with an sr-only label: ${th.replace(/<[^>]*>/g, '').trim()}`,
        th.includes('class="sr-only"'), th);
    }
    const css = fs.readFileSync(path.join(HERE, 'public/style.css'), 'utf8');
    check('and .sr-only actually hides it', /\.sr-only\s*\{[^}]*clip-path/.test(css));

    // The totals row (#77 follow-up): sums only where a sum is honest.
    const tfoot = (pane.match(/<tfoot>[\s\S]*?<\/tfoot>/) || [''])[0];
    check('the islands table has a totals row', !!tfoot);
    for (const id of ['isl-t-wood', 'isl-t-stone', 'isl-t-gold', 'isl-t-pop', 'isl-t-merch', 'isl-t-points',
                      'isl-p-wood', 'isl-p-stone', 'isl-p-gold']) {
      check(`  totals/production cell exists: ${id}`, tfoot.includes(`id="${id}"`));
    }
    // Defence and wall must NOT total: an attacker meets one island's
    // defence, never the fleet's. The markup keeps them as dashes.
    check('  defence and wall stay a dash, not a sum',
      (tfoot.match(/&mdash;/g) || []).length === 2
      && !tfoot.includes('isl-t-def') && !tfoot.includes('isl-t-wall'));
  }

  // ---- #86: the did:nostr link survives a world reset ----
  {
    process.env.IDENTITY_FILE = path.join(process.env.DATA_DIR, 'identity.json');
    const DID = 'did:nostr:' + 'cd'.repeat(32);
    const idApp = createApp({ botCount: 0, freeIsles: 2, log: silent });
    const { srv, port } = await serve(idApp);
    const reg = await req(port, 'POST', '/api/register',
      { body: { name: 'Banner Bearer', password: 'sekritsekrit', lang: 'en' } });
    const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
    const link = await req(port, 'POST', '/api/identity/nostr',
      { cookie, body: { did: DID } });
    check('#86 link accepted', link.status === 200 && link.data.nostrDid === DID,
      JSON.stringify(link.data));
    srv.close();

    // the season boundary: the world file goes, the identity store stays.
    // Same name registers afresh on the new world with the banner flying.
    fs.rmSync(path.join(process.env.DATA_DIR, 'world.json'), { force: true });
    const nextApp = createApp({ botCount: 0, freeIsles: 2, log: silent });
    const { srv: srv2, port: port2 } = await serve(nextApp);
    const reg2 = await req(port2, 'POST', '/api/register',
      { body: { name: 'Banner Bearer', password: 'other-season-pass', lang: 'en' } });
    check('#86 fresh world, fresh register', reg2.status === 200, JSON.stringify(reg2.data));
    const cookie2 = (reg2.headers.get('set-cookie') || '').split(';')[0];
    const rank = await req(port2, 'GET', '/api/rankings', { cookie: cookie2 });
    const row = rank.data.rankings.find((r) => r.name === 'Banner Bearer');
    check('#86 rankings row carries the recalled did', row && row.nostrDid === DID,
      JSON.stringify(row));
    srv2.close();
    delete process.env.IDENTITY_FILE;
  }

  // ---- #96: bots fly the banner the host hands them ----
  {
    fs.rmSync(path.join(process.env.DATA_DIR, 'world.json'), { force: true });
    const didFor = (name) => 'did:nostr:' + Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64);
    const botApp = createApp({
      botCount: 3, freeIsles: 1, log: silent,
      botIdentity: async (name) => ({ webId: `https://pods.test/${name}`, nostrDid: didFor(name) }),
    });
    botApp.start();
    const { srv, port } = await serve(botApp);
    const reg = await req(port, 'POST', '/api/register',
      { body: { name: 'Watcher', password: 'sekritsekrit', lang: 'en' } });
    const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
    // the sweep is async fire-and-forget from start() — poll briefly
    let bots = [];
    for (let i = 0; i < 20; i++) {
      const rank = await req(port, 'GET', '/api/rankings', { cookie });
      bots = (rank.data.rankings || []).filter((r) => r.isBot);
      if (bots.length && bots.every((b) => b.nostrDid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    check('#96 every bot row carries its did', bots.length === 3 && bots.every((b) => b.nostrDid === didFor(b.name)),
      JSON.stringify(bots.map((b) => [b.name, b.nostrDid && b.nostrDid.slice(0, 16)])));
    check('#96 bot webIds ride along as extId', bots.every((b) => b.webId === `https://pods.test/${b.name}`));
    const world = botApp.world;
    check('#96 the sweep persists on the player objects',
      world.players.filter((p) => p.isBot).every((p) => p.nostrDid && p.extId));
    botApp.stop();
    srv.close();
  }

  // ---- #104: movements carry their origin; the islands tab counts the sea ----
  {
    const mv = createApp({ botCount: 1, freeIsles: 2, log: silent });
    const w2 = mv.world;
    const me = w2.players.find((p) => !p.isBot) || (() => {
      const r = mv.world; return null; })();
    // register a player over http to get a session + islands
    const { srv, port } = await serve(mv);
    const reg = await req(port, 'POST', '/api/register',
      { body: { name: 'Argo', password: 'sekritsekrit', lang: 'en' } });
    const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
    const player = w2.players.find((p) => p.name === 'Argo');
    const home = w2.islands.find((i) => i.ownerId === player.id);
    const bot = w2.players.find((p) => p.isBot);
    const botIsle = w2.islands.find((i) => i.ownerId === bot.id);
    // a return movement with loot — the archetypal cargo-at-sea
    w2.movements.push({
      id: w2.nextId++, type: 'return', ownerId: player.id,
      fromId: botIsle.id, toId: home.id, units: { raider: 3 },
      loot: { wood: 120, stone: 45, gold: 60 },
      depart: Date.now(), arrive: Date.now() + 3600_000,
    });
    const st = await req(port, 'GET', '/api/state', { cookie });
    const out = st.data.movements.outgoing;
    check('#104 outgoing rows carry an origin', out.length === 1 && typeof out[0].from === 'string'
      && out[0].from.includes(String(botIsle.x)), JSON.stringify(out));
    check('#104 cargo survives into the payload', out[0].loot && out[0].loot.wood === 120);
    srv.close(); mv.stop();
  }
  {
    const html = fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8');
    for (const id of ['isl-s-wood', 'isl-s-stone', 'isl-s-gold', 'fleet-moves']) {
      check(`#104 markup exists: ${id}`, html.includes(`id="${id}"`));
    }
  }

  // ---- flagship count defaults to 1, not a 5-batch (28.5k foot-gun) ----
  {
    const capApp = createApp({ botCount: 0, freeIsles: 1, log: silent });
    const { srv, port } = await serve(capApp);
    const reg = await req(port, 'POST', '/api/register',
      { body: { name: 'Capt', password: 'sekritsekrit', lang: 'en' } });
    const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
    const st = await req(port, 'GET', '/api/state', { cookie });
    const ut = st.data.unitTypes;
    check('flagship is a capture unit, not a ship',
      ut.flagship.capture === true && ut.flagship.ship === false, JSON.stringify({c: ut.flagship.capture, s: ut.flagship.ship}));
    check('colony ship is a ship, not capture',
      ut.colonyship.ship === true && ut.colonyship.capture === false);
    check('spearman is neither (defaults to a batch)',
      !ut.spearman.ship && !ut.spearman.capture);
    srv.close(); capApp.stop();
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests pass');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

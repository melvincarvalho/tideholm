// Tideholm — app-layer tests: createApp over real HTTP.
// Run: node tests.app.js   (exits non-zero on failure)
// Covers the seams the standalone launcher doesn't exercise: prefix
// mounting, the pluggable identity provider, and password-mode auth —
// the contract an embedding host (e.g. a JSS plugin) relies on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Isolated storage: never touch the repo's live world.
process.env.GAME_SPEED = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tideholm-app-test-'));
process.env.HALL_FILE = path.join(process.env.DATA_DIR, 'hall-of-fame.json');
process.on('exit', () => {
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* gone */ }
});

const { createApp } = await import('./app.js'); // dynamic: after DATA_DIR above

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok  ' + name);
  } else {
    failures++;
    console.log('FAIL  ' + name + (detail !== undefined ? ' — ' + detail : ''));
  }
}

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
  check('a new player holds no position', r.data.mine?.shares === 0 && r.data.mine?.share === 0);
  check('no quote unless one is asked for', r.data.quote === undefined);

  r = await req(pa.port, 'GET', '/api/pool?from=wood&to=gold&amount=500', { cookie: pcookie });
  check('a quote is returned when asked', r.status === 200 && !!r.data.quote);
  check('a closed pool quotes nothing', r.data.quote?.out === 0 && r.data.quote?.used === 0);

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

  const beforeQuoting = JSON.stringify(poolApp.world.pool);
  await req(pa.port, 'GET', '/api/pool?from=gold&to=stone&amount=99999', { cookie: pcookie });
  check('quoting an open pool still mutates nothing',
    JSON.stringify(poolApp.world.pool) === beforeQuoting);

  pa.srv.close();
  poolApp.stop();

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests pass');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

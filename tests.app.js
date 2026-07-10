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

  h.srv.close();

  // stop() releases the lock and saves — must be idempotent across instances
  app.stop();
  mounted.stop();
  podApp.stop();
  check('lock released after stop', !fs.existsSync(path.join(process.env.DATA_DIR, 'server.lock')));

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests pass');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

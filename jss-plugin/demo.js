// End-to-end proof for the plugin-zero RFC (#206): Tideholm mounted inside
// a real JavaScript Solid Server, playing as a pod identity.
//
//   npm install && node jss-plugin/demo.js
//
// JSS comes from the javascript-solid-server devDependency (>= 0.0.214 for
// the appPaths + getAgent seams). To run against a local JSS checkout instead:
//   npm install /path/to/JavaScriptSolidServer
//
// Boots JSS (IDP on, appPaths seam), registers a pod account over HTTP,
// obtains a Bearer token from /idp/credentials, and plays the game at
// /tideholm/* — the WebID auto-provisions a Tideholm player. Exits non-zero
// on failure. Uses temp dirs; touches no real pods or worlds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'javascript-solid-server/src/server.js';
import { getAgent } from 'javascript-solid-server/auth.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tideholm-jss-demo-'));
process.env.HALL_FILE = path.join(tmp, 'hall-of-fame.json');
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ }
});

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('FAIL  ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}

const { tideholmApp } = await import(new URL('./tideholm-jss.js', import.meta.url));

// ---------------------------------------------------------------- boot

const game = await tideholmApp({
  dataDir: path.join(tmp, 'game'),
  botCount: 2,
  freeIsles: 2,
  log: { log() {}, error: console.error },
  getWebId: getAgent, // public seam since JSS 0.0.214 (#584)
});

// The IdP needs its issuer URL before listen — reserve a free port first.
const net = await import('node:net');
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject); // fail loudly, don't hang, if listen errors
  probe.listen(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;

const fastify = createServer({
  root: path.join(tmp, 'pods'),
  idp: true,
  idpIssuer: base,
  appPaths: [game.prefix],
});
await game.register(fastify);
await fastify.listen({ port, host: '127.0.0.1' });
console.log(`JSS + Tideholm up at ${base} (mounted at ${game.prefix})`);

// ---------------------------------------------------------------- account

let r = await fetch(`${base}/idp/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'alice', password: 'sailing-far', confirmPassword: 'sailing-far' }),
});
check('pod account registered', r.status < 400, `status ${r.status}`);

r = await fetch(`${base}/idp/credentials`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'alice', password: 'sailing-far' }),
});
const cred = await r.json().catch(() => ({}));
check('bearer token issued', r.status === 200 && !!cred.access_token, JSON.stringify(cred).slice(0, 120));
check('token names the webid', typeof cred.webid === 'string' && cred.webid.includes('alice'), cred.webid);
const auth = { Authorization: `Bearer ${cred.access_token}` };

// ---------------------------------------------------------------- play

r = await fetch(`${base}/tideholm/api/state`);
check('anonymous game request is 401 (game auth, not WAC)', r.status === 401, `status ${r.status}`);

r = await fetch(`${base}/tideholm/api/state`, { headers: auth });
let state = await r.json().catch(() => null);
check('webid plays: state is 200', r.status === 200, `status ${r.status}`);
check('player auto-provisioned as "alice"', state && state.player && state.player.name === 'alice',
  JSON.stringify(state && state.player));
check('player has a starting island', state && state.island && typeof state.island.name === 'string');
check('game world keyed by webid', game.world.players.some((p) => p.extId === cred.webid));

// a real action through the whole stack: queue a building upgrade
r = await fetch(`${base}/tideholm/api/build`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ islandId: state.island.id, building: 'lumberyard' }),
});
state = await r.json().catch(() => null);
check('build order accepted through JSS', r.status === 200 && state.island.queue.length === 1,
  `status ${r.status}`);

// static client is served under the prefix
r = await fetch(`${base}/tideholm/`);
const html = await r.text();
check('game client served under /tideholm/', r.status === 200 && html.includes('Tideholm'));

// ---------------------------------------------------------------- coexistence

// The pod is still a pod: LDP answers on the same origin.
r = await fetch(`${base}/alice/profile/card.jsonld`, { headers: auth });
check('LDP still serves the profile beside the game', r.status === 200, `status ${r.status}`);

// A second pod identity gets its own player.
await fetch(`${base}/idp/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'bob', password: 'rowing-home', confirmPassword: 'rowing-home' }),
});
r = await fetch(`${base}/idp/credentials`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'bob', password: 'rowing-home' }),
});
const bob = await r.json();
r = await fetch(`${base}/tideholm/api/state`, { headers: { Authorization: `Bearer ${bob.access_token}` } });
const bobState = await r.json().catch(() => null);
check('second pod gets its own player', r.status === 200 && bobState.player.name === 'bob',
  JSON.stringify(bobState && bobState.player));

// ---------------------------------------------------------------- done

game.stop();
await fastify.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks pass — pod identity plays Tideholm');
process.exit(failures ? 1 : 0);

// Persistent JSS + Tideholm testbed — the composed instance for local play.
//
//   node jss-plugin/serve.js            # or under pm2
//   PORT=3210 ADMIN_TOKEN=... node jss-plugin/serve.js
//
// JSS comes from the javascript-solid-server devDependency (>= 0.0.214).
// To run against a local JSS checkout: npm install /path/to/checkout.
//
// Boots a real JavaScript Solid Server (IdP on, appPaths seam) with Tideholm
// mounted at /tideholm. Pod accounts are game accounts: register a pod at
// /idp/register, then sign in on the game's login screen with the same
// credentials. Data persists in jss-plugin/data/ (pods + game world).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'javascript-solid-server/src/server.js';
import { getAgent } from 'javascript-solid-server/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3210);
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const { tideholmApp } = await import(new URL('./tideholm-jss.js', import.meta.url));

const game = await tideholmApp({
  dataDir: path.join(DATA, 'game'),
  adminToken: process.env.ADMIN_TOKEN,
  getWebId: getAgent, // public seam since JSS 0.0.214 (#584)
});

const fastify = createServer({
  root: path.join(DATA, 'pods'),
  idp: true,
  idpIssuer: `http://localhost:${PORT}`,
  appPaths: [game.prefix],
});
await game.register(fastify);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    game.stop();
    await fastify.close().catch(() => {});
    process.exit(0);
  });
}

await fastify.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Testbed up:`);
console.log(`  game:  http://localhost:${PORT}${game.prefix}/   (sign in with your pod)`);
console.log(`  pods:  http://localhost:${PORT}/idp/register     (create a pod)`);

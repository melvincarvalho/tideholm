// Persistent JSS + Tideholm testbed — the composed instance for local play.
//
//   node jss-plugin/serve.js            # or under pm2
//   PORT=3210 ADMIN_TOKEN=... node jss-plugin/serve.js
//
// Since javascript-solid-server 0.0.215 the composition is pure config:
// the plugin loader (#206) imports the adapter, mounts it WAC-exempt at
// /tideholm, and runs its deactivate (world save) on close. Pod accounts
// are game accounts. Data persists in jss-plugin/data/ (pods + game world).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'javascript-solid-server/src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3210);
// Behind a TLS-terminating proxy, set PUBLIC_URL to the public origin
// (e.g. https://tideholm.example) so the IdP issues tokens for the right
// issuer. Defaults to the local address for laptop use.
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATA = process.env.DATA || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const fastify = createServer({
  root: path.join(DATA, 'pods'),
  idp: true,
  idpIssuer: PUBLIC_URL,
  plugins: [{
    module: path.join(__dirname, 'tideholm-jss.js'),
    prefix: '/tideholm',
    config: {
      dataDir: path.join(DATA, 'game'), // pre-loader deployments keep their world
      adminToken: process.env.ADMIN_TOKEN,
      issuer: PUBLIC_URL, // bots get pods + did:nostr banners (#96)
    },
  }],
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await fastify.close().catch(() => {}); // runs the plugin's deactivate (world save)
    process.exit(0);
  });
}

await fastify.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Tideholm + pods up:`);
console.log(`  game:  ${PUBLIC_URL}/tideholm/   (sign in with your pod)`);
console.log(`  pods:  ${PUBLIC_URL}/idp/register     (create a pod)`);

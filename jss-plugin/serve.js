// Persistent JSS + Tideholm testbed — the composed instance for local play.
//
//   node jss-plugin/serve.js            # or under pm2
//   PORT=3210 JSS_PATH=... ADMIN_TOKEN=... node jss-plugin/serve.js
//
// Boots a real JavaScript Solid Server (IdP on, appPaths seam) with Tideholm
// mounted at /tideholm. Pod accounts are game accounts: register a pod at
// /idp/register, then sign in on the game's login screen with the same
// credentials. Data persists in jss-plugin/data/ (pods + game world).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3210);
const JSS_PATH = process.env.JSS_PATH
  || '/home/melvin/remote/github.com/JavaScriptSolidServer/JavaScriptSolidServer';
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const { createServer } = await import(pathToFileURL(path.join(JSS_PATH, 'src/server.js')));
const { getWebIdFromRequestAsync } = await import(pathToFileURL(path.join(JSS_PATH, 'src/auth/token.js')));
const { tideholmApp } = await import(new URL('./tideholm-jss.js', import.meta.url));

const game = await tideholmApp({
  dataDir: path.join(DATA, 'game'),
  adminToken: process.env.ADMIN_TOKEN,
  getWebId: async (request) => {
    const { webId } = await getWebIdFromRequestAsync(request);
    return webId;
  },
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

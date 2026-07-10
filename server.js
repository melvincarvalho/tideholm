// Tideholm — standalone HTTP launcher. Zero dependencies: node server.js
// Env: PORT (default 3000), GAME_SPEED (default 5), BOTS (default 20),
//      FREE_ISLES, ADMIN_TOKEN, TRUST_PROXY, DATA_DIR
//
// All game and HTTP logic lives in app.js (createApp), so a host process —
// e.g. a JSS plugin — can mount the same application under its own server,
// prefix, and identity provider. This file only owns the socket and signals.

'use strict';

const http = require('http');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);

const app = createApp(); // options default from env
app.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { app.stop(); process.exit(0); });
}
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err);
  try { app.stop(); } catch { /* best effort */ }
  process.exit(1);
});

const server = http.createServer(app.handle);

// If the port is taken, hop to the next one (up to 20 tries).
let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < PORT + 20) {
    console.log(`Port ${port} is in use, trying ${port + 1}...`);
    port++;
    setTimeout(() => server.listen(port), 100);
  } else {
    throw err;
  }
});

server.listen(port, () => {
  console.log(`Tideholm listening on http://localhost:${port}`);
});

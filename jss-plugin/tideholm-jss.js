// Tideholm as a JSS app — the "plugin zero" adapter from
// JavaScriptSolidServer/JavaScriptSolidServer#206.
//
// Two contracts, one implementation:
//
//  * today (plain Fastify, the bitmark-explorer pattern):
//        const app = tideholmApp({ getWebId, dataDir });
//        const fastify = createServer({ appPaths: [app.prefix] });
//        await app.register(fastify);
//
//  * tomorrow (the #206 loader): activate(api) below, driven by
//        jss.plugin.json — same mount, api-provided seams.
//
// The game core stays zero-dependency; this file is only glue. All requests
// under `prefix` are handed to Tideholm's transport-agnostic handler
// (app.js createApp), with the pod identity resolved per request: your
// WebID *is* your player — no password, auto-provisioned on first visit.

// "https://alice.pods.example/profile#me" -> "alice"
// "http://localhost:3210/alice/profile/card#me" -> "alice"
export function nameFromWebId(webId) {
  try {
    const u = new URL(webId);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (seg && !['profile', 'card', 'me'].includes(seg.toLowerCase())) return seg;
    const host = u.hostname.split('.')[0];
    return host || 'Voyager';
  } catch {
    return 'Voyager';
  }
}

// "Barnacle Bill" -> "barnacle-bill": pod-safe slug for a bot name.
export function botSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// #96: every bot flies a banner. Ensure a pod exists for the bot and return
// its identity. The pod is minted through the host's own machinery (account
// record + createPodStructure with provisionKeys), so the bot gets exactly
// what a human registrant gets: profile card.jsonld, a /private/ owner key
// (Schnorr secp256k1 — nostr's scheme), owner-only WAC. The did:nostr IS the
// pod owner key; this plugin never touches key material.
//
// A registry file (bot-pods.json, beside the world in dataDir) remembers
// name -> identity so later seasons reuse the pod: Ned is Ned forever. If
// the slug is already a real account we did not create, the bot flies no
// banner — never hijack a human's pod.
async function makeEnsureBotPod({ issuer, dataDir, log }) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { createAccount, findByUsername } = await import('javascript-solid-server/src/idp/accounts.js');
  const { createPodStructure } = await import('javascript-solid-server/src/handlers/container.js');
  const regFile = path.join(dataDir, 'bot-pods.json');
  const loadReg = () => { try { return JSON.parse(fs.readFileSync(regFile, 'utf8')); } catch { return {}; } };

  return async function ensureBotPod(botName) {
    const key = String(botName || '').toLowerCase();
    const reg = loadReg();
    if (reg[key]) return reg[key];

    const slug = botSlug(botName);
    if (!slug) return null;
    const webId = `${issuer}/${slug}/profile/card.jsonld#me`;
    const podUri = `${issuer}/${slug}/`;

    const existing = await findByUsername(slug);
    if (existing) return null; // someone real holds this name — no banner

    await createAccount({
      username: slug,
      // Throwaway: bot auth is the pod owner key, never a password login.
      password: crypto.randomBytes(24).toString('hex'),
      webId,
      podName: slug,
    });
    const creation = await createPodStructure(slug, webId, podUri, issuer, 0, { provisionKeys: true });
    const didNostr = creation && creation.ownerKey && creation.ownerKey.didNostr;
    if (!didNostr) {
      if (log && log.error) log.error(`bot pod for "${botName}": no owner key came back`);
      return null;
    }
    const record = { slug, webId, nostrDid: didNostr };
    reg[key] = record;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(regFile, JSON.stringify(reg, null, 2));
    if (log && log.log) log.log(`bot pod minted: ${botName} -> ${podUri} (${didNostr.slice(0, 20)}...)`);
    return record;
  };
}

/**
 * @param {object} opts
 * @param {string}   [opts.prefix='/tideholm']  mount point
 * @param {function} [opts.getWebId]            async (fastifyRequest) => webId|null
 * @param {string}   [opts.dataDir]             game storage (world.json, backups)
 * @param {string}   [opts.issuer]              public origin; when set, every
 *                                              bot gets a pod + did:nostr (#96)
 * @param {number}   [opts.botCount] [opts.freeIsles] [opts.adminToken] …
 *                                              forwarded to createApp
 * @param {object}   [opts.log]                 console-like
 */
export async function tideholmApp(opts = {}) {
  const prefix = (opts.prefix || '/tideholm').replace(/\/+$/, '');
  const getWebId = opts.getWebId || (async () => null);

  // game.js resolves DATA_DIR when its module evaluates — set the env before
  // the (dynamic) import below. One world per process; a second app with a
  // different dataDir would race.
  if (opts.dataDir) process.env.DATA_DIR = opts.dataDir;
  const { createApp } = await import('../app.js');

  const botIdentity = opts.issuer
    ? await makeEnsureBotPod({
        issuer: String(opts.issuer).replace(/\/+$/, ''),
        dataDir: process.env.DATA_DIR,
        log: opts.log,
      })
    : null;

  const app = createApp({
    basePath: prefix,
    log: opts.log,
    botIdentity,
    botCount: opts.botCount,
    freeIsles: opts.freeIsles,
    adminToken: opts.adminToken,
    podLoginUrl: opts.podLoginUrl, // defaults to /idp/credentials in the app
    identify: async (rawReq) => {
      const webId = rawReq.__tideholmWebId;
      return webId ? { id: webId, name: nameFromWebId(webId) } : null;
    },
  });
  app.start();

  async function register(fastify) {
    const handler = async (request, reply) => {
      // Resolve pod identity with the host's own auth machinery, then hand
      // the raw socket to the game's node-style handler.
      let webId = null;
      try { webId = await getWebId(request); } catch { /* anonymous */ }
      request.raw.__tideholmWebId = webId || null;
      reply.hijack();
      app.handle(request.raw, reply.raw);
    };
    // Scoped so the host's content parsers don't consume request bodies —
    // the game reads its own raw stream (standard fastify proxy pattern).
    await fastify.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', (req, payload, done) => done(null, payload));
      scope.all(prefix, handler);
      scope.all(prefix + '/*', handler);
    });
  }

  return {
    prefix,
    register,
    stop: () => app.stop(),      // saves the world, clears timers
    get world() { return app.world; },
  };
}

// ---------------------------------------------------------------------------
// #206 loader contract: createServer({ plugins: [{ module, prefix }] }) calls
// activate(api) with api.fastify, api.prefix, api.config, api.auth.getAgent,
// and api.storage.pluginDir() (private server-side data dir).
export async function activate(api) {
  const app = await tideholmApp({
    prefix: api.prefix || (api.config && api.config.prefix) || '/tideholm',
    // config.dataDir lets an existing deployment keep its world in place;
    // fresh installs default to the loader's private plugin dir.
    dataDir: (api.config && api.config.dataDir)
      || (api.storage && api.storage.pluginDir ? api.storage.pluginDir('tideholm') : undefined),
    getWebId: api.auth && api.auth.getAgent
      ? (req) => api.auth.getAgent(req)
      : undefined,
    adminToken: api.config && api.config.adminToken,
    issuer: api.config && api.config.issuer,
    botCount: api.config && api.config.bots,
    freeIsles: api.config && api.config.freeIsles,
    log: api.log,
  });
  await app.register(api.fastify);
  return { deactivate: () => app.stop() };
}

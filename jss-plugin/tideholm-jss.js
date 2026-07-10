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

/**
 * @param {object} opts
 * @param {string}   [opts.prefix='/tideholm']  mount point
 * @param {function} [opts.getWebId]            async (fastifyRequest) => webId|null
 * @param {string}   [opts.dataDir]             game storage (world.json, backups)
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

  const app = createApp({
    basePath: prefix,
    log: opts.log,
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
    botCount: api.config && api.config.bots,
    freeIsles: api.config && api.config.freeIsles,
    log: api.log,
  });
  await app.register(api.fastify);
  return { deactivate: () => app.stop() };
}

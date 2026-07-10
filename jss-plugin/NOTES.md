# Plugin-zero findings log

What mounting Tideholm inside JSS teaches us, one line at a time. Feeds the
loader issues (JavaScriptSolidServer #206, #582, #583, #584) and eventual PRs.

## Confirmed (in issues already)

- **WAC hook swallows plugin routes** → `appPaths` seam (#582). Demo runs on
  an 8-line local diff to JSS `createServer`.
- **Fastify content parsers eat raw bodies** → scoped pass-through parser
  (#583); cost an hour of "why does POST hang".
- **Identity needs no new code, only a public blessing** →
  `getWebIdFromRequestAsync` covers Bearer/DPoP/NIP-98/LWS-CID (#584).

## From building the browser bridge

- **The programmatic flow ≠ the human flow.** The 12-check demo passes Bearer
  headers from node; a browser sends none. Games/apps need a login UI that
  speaks the host's auth. We bridge via `POST /idp/credentials` (pod
  username + password → Bearer token in localStorage). A future
  loader could offer a nicer story (cookie-session `getAgent`, or a tiny
  OIDC helper for vanilla-JS apps).
- **Apps need to *discover* the identity mode.** Added `GET /api/meta`
  (`mode: password|pod`, `podLoginUrl`) so the same client serves both
  standalone and mounted deployments. A loader-provided convention would be
  nicer than every app inventing its own meta endpoint.
- **`/idp/credentials` tokens expire in 3600s** and there is no refresh
  flow for this path. After an hour the game 401s; the client drops the
  token and shows the login screen again. Fine for a testbed, rude
  mid-battle. Candidate follow-ups: longer app-token TTL option in JSS, or
  silent re-auth in the client.

## Open questions for playtesting

- Does the WAC-exempted prefix interact with subdomain-pod mode?
- Two identity models, one world file: what happens if a testbed world is
  later served standalone (extId players have random passwords — they can
  never log in via password mode; is that acceptable lockout?).
- Rate limiting keys on game player id — fine; but registration limits are
  per-IP at the JSS layer now, not the game's (game's own /api/register is
  dark). Good — one fewer thing to double-enforce.

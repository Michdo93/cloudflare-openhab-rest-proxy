# cloudflare-openhab-rest-proxy

A deliberately narrow proxy between browser applications and an openHAB REST API. It is designed for Cloudflare Workers and does **not** expose a generic REST tunnel.

> Status: initial implementation / review required before connecting real devices. The myopenHAB account-authentication path must be tested with the target account. In particular, verify whether the Cloud Connector supports `/rest/events` (SSE) for your installation.

## Design goals

- Keep myopenHAB account credentials on the Worker, never in browser code.
- Connect to the fixed myopenHAB endpoint `https://myopenhab.org` using the myopenHAB account email address and password.
- Do not use an openHAB API token for the myopenHAB Cloud Connector route.
- Expose only a small, versioned API:
  - `GET /api/v1/items`
  - `GET /api/v1/items/:name`
  - `GET /api/v1/items/:name/state`
  - `POST /api/v1/items/:name/command`
  - `GET /api/v1/events` (SSE)
- Enforce an explicit item and command allowlist.
- Allow only `ItemStateChangedEvent` events for readable allowlisted items.
- Never forward arbitrary paths, query parameters, headers, or HTTP methods to openHAB.
- Keep CORS separate from authentication. CORS is a browser policy, not an access-control boundary.

## Architecture

```text
Browser / JS client
        |
        | restricted /api/v1/* (unchanged client contract)
        v
Cloudflare Worker
  - allowlist
  - command validation
  - optional Cloudflare Access JWT validation
  - SSE event filtering
        |
        | HTTPS + HTTP Basic (myopenHAB email:password)
        v
https://myopenhab.org/rest
        |
        v
myopenHAB Cloud Connector / openHAB instance
```

The Worker uses `https://myopenhab.org` as its upstream origin and `/rest` as the API prefix. It sends HTTP Basic authentication with the myopenHAB account email address as the username and the myopenHAB account password as the password. The credentials are held only in Worker secrets (or local `.dev.vars` during development).

The openHAB API token is **not used** for this myopenHAB cloud route. It remains useful for direct REST access to an openHAB instance, but it is not a substitute for the myopenHAB account credentials here.

Do not assume that every openHAB endpoint, especially `/rest/events`, is available through the Cloud Connector. Test REST and SSE independently.

## Requirements

- A Cloudflare account with Workers enabled.
- Node.js 20+ and npm.
- A myopenHAB account linked to the target openHAB instance.
- The myopenHAB account email address and password.
- A working myopenHAB Cloud Connector connection.

Cloudflare's TypeScript Worker runtime and Wrangler are documented at:

- https://developers.cloudflare.com/workers/languages/typescript/
- https://developers.cloudflare.com/workers/wrangler/
- https://developers.cloudflare.com/workers/configuration/secrets/

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and set:

```dotenv
MYOPENHAB_EMAIL=your-myopenhab-email@example.com
MYOPENHAB_PASSWORD=your-myopenhab-password
```

Never commit `.dev.vars`. The upstream URL is configured in `wrangler.jsonc` as `https://myopenhab.org`; the REST prefix is `/rest`.

Edit `wrangler.jsonc` as needed:

- `ACCESS_MODE`: `public-demo` or `access`.
- `CORS_ALLOWED_ORIGINS`: comma-separated exact browser origins.
- `ALLOWED_ITEMS_JSON`: item names, read permission, and exact allowed commands.
- `MYOPENHAB_BASE_URL`: keep this set to `https://myopenhab.org` for the myopenHAB cloud route.
- `OPENHAB_API_PREFIX`: normally `/rest`.

Run locally:

```bash
npm run types
npm run typecheck
npm test
npm run dev
```

## Deployment

```bash
npx wrangler login
npx wrangler secret put MYOPENHAB_EMAIL
npx wrangler secret put MYOPENHAB_PASSWORD
npm run deploy
```

Enter the myopenHAB email address and password when Wrangler prompts for each secret. These are encrypted Worker secrets. Do not put them in `vars`, `wrangler.jsonc`, GitHub Actions logs, or source control.

If using Cloudflare Access, also configure the Access secrets described below.

## Allowlist format

Example:

```json
{
  "Demo_Light": {
    "read": true,
    "commands": ["ON", "OFF"]
  },
  "Demo_Temperature": {
    "read": true,
    "commands": []
  },
  "Internal_Item": {
    "read": false,
    "commands": ["RESET"]
  }
}
```

Only `read: true` items are returned by the list endpoint or exposed through item/state reads and SSE. Commands are exact string matches. A command permission does not imply read permission.

Use item names that actually exist in your openHAB instance. Keep this allowlist minimal. A public demo should contain only virtual/demo items that cannot operate real devices.

## Access modes

### `public-demo`

No user authentication is required to call the Worker. This mode is appropriate only for a public demonstration backed by virtual items and harmless commands. Anyone who discovers the Worker URL can call its allowlisted operations. The myopenHAB credentials remain server-side, but this mode does not authenticate callers of the Worker.

### `access`

The Worker validates the `Cf-Access-Jwt-Assertion` JWT against the configured Cloudflare Access team domain and application audience. Configure a Cloudflare Access self-hosted application in front of the Worker and protect the Worker hostname/path. Set these Worker secrets:

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_AUD
```

Set `ACCESS_MODE` to `access`. Configure the Access application so requests to the Worker are authenticated and the application audience matches `ACCESS_AUD`.

For a real installation, protect the Worker with Cloudflare Access and test JWT validation end-to-end. Do not treat CORS, an obscure URL, or a frontend-only password as authentication.

## API

### `GET /health`

Returns a small health response. It does not test upstream connectivity.

### `GET /api/v1/items`

Returns only allowlisted items with `read: true`. The Worker currently fetches the upstream item list and filters it. If you have a very large openHAB instance, consider a future implementation that fetches each permitted item individually or caches a minimal snapshot.

### `GET /api/v1/items/:name`

Returns the openHAB item representation, only if the item is allowlisted for reading.

### `GET /api/v1/items/:name/state`

Returns the item's state as plain text.

### `POST /api/v1/items/:name/command`

Sends a command as a plain-text request body. Example:

```bash
curl -X POST \
  -H 'Content-Type: text/plain' \
  --data 'ON' \
  https://YOUR-WORKER.workers.dev/api/v1/items/Demo_Light/command
```

The command must exactly match one of the item's `commands` entries. The Worker forwards it as an HTTP `POST` to `/rest/items/:name`, which is the openHAB REST command operation. `postUpdate` is intentionally not exposed.

### `GET /api/v1/events`

Returns an SSE stream. Only events named `ItemStateChangedEvent` whose envelope topic matches `openhab/items/<allowlisted-item>/state` are passed through. The stream is forwarded incrementally and upstream reading is cancelled when the downstream stream is cancelled.

The implementation subscribes upstream using exact topic names. Verify that the openHAB version and Cloud Connector support this event endpoint and topic syntax. The Worker does not buffer the complete stream.

## CORS

Set `CORS_ALLOWED_ORIGINS` to exact origins, e.g.:

```text
https://your-dashboard.github.io,http://localhost:5173
```

Do not use `*` for a real installation. CORS only constrains browser JavaScript; it does not stop curl, scripts, or other servers from calling the API.

## Security checklist before production

- [ ] Use a dedicated myopenHAB account for the Worker if practical; understand that its cloud credentials grant the access associated with that account.
- [ ] Use `ACCESS_MODE=access` for real installations.
- [ ] Put the Worker behind a Cloudflare Access application.
- [ ] Keep `MYOPENHAB_EMAIL`, `MYOPENHAB_PASSWORD`, `ACCESS_TEAM_DOMAIN`, and `ACCESS_AUD` as Worker secrets.
- [ ] Keep `.dev.vars` out of Git.
- [ ] Never expose myopenHAB credentials to the browser or return them in API responses.
- [ ] Use exact CORS origins (understand that CORS is not authentication).
- [ ] Allowlist only the virtual or real items that must be exposed.
- [ ] Allowlist exact commands per item.
- [ ] Test every command against a noncritical item first.
- [ ] Verify myopenHAB upstream REST and SSE behavior, authentication, reconnects, and idle timeouts.
- [ ] Add Cloudflare rate limiting / abuse protection before publishing a public endpoint.
- [ ] Review logs and avoid logging credentials, event payloads, or personal data.

## Known limitations / next hardening steps

This is a starter implementation, not a certified security gateway.

1. The in-memory Worker runtime does not provide a globally consistent per-user rate limiter. Add Cloudflare rate limiting or a Durable Object if abuse resistance is required.
2. SSE filtering assumes the standard openHAB event envelope contains a `topic` field like `openhab/items/ItemName/state`. Confirm this against your deployed openHAB version and the myopenHAB route.
3. The Worker fetches `/rest/items` before filtering the list. The response is not exposed wholesale, but upstream bandwidth and parsing scale with the full item registry.
4. Cloudflare Access JWT key retrieval is performed during authorization. Add a bounded JWKS cache if request volume warrants it.
5. The myopenHAB account's permissions apply to the upstream connection; the Worker allowlist is the browser-facing restriction and does not replace account-level security.
6. Add automated integration tests against a disposable openHAB instance and a real myopenHAB Cloud Connector account before production.

## Development notes

```bash
npm run typecheck
npm test
```

The test suite covers allowlist parsing and verifies that upstream requests target `https://myopenhab.org/rest` using HTTP Basic authentication with the configured email address and password. It does not perform a live request to myopenHAB.

## License

MIT. See [LICENSE](LICENSE).

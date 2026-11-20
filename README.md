# cloudflare-openhab-rest-proxy

A deliberately narrow proxy between browser applications and an openHAB REST API. It is designed for Cloudflare Workers and does **not** expose a generic REST tunnel.

> Status: initial implementation / review required before connecting real devices. Test the myopenHAB Cloud Connector path and SSE behavior with your own account before relying on it.

## Design goals

- Keep the openHAB API token on the Worker, never in browser code.
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
        | restricted /api/v1/*
        v
Cloudflare Worker
  - allowlist
  - command validation
  - optional Cloudflare Access JWT validation
  - SSE event filtering
        |
        | HTTPS + Bearer token
        v
myopenHAB Cloud Connector / openHAB
```

The Worker expects an upstream URL such as `https://myopenhab.org` and uses `/rest` as the API prefix by default. It authenticates with HTTP Basic authentication using the API token as the username and an empty password (`token:`), as required by the openHAB REST API. Confirm the correct URL and token behavior for your myopenHAB deployment. Do not assume that every openHAB endpoint, especially `/rest/events`, is available through the cloud connector.

## Requirements

- A Cloudflare account with Workers enabled.
- Node.js 20+ and npm.
- An openHAB API token with only the permissions needed by the proxy.
- A working HTTPS-reachable openHAB REST endpoint (directly or through myopenHAB).

Cloudflare's TypeScript Worker runtime and Wrangler are documented at:
- https://developers.cloudflare.com/workers/languages/typescript/
- https://developers.cloudflare.com/workers/wrangler/
- https://developers.cloudflare.com/workers/configuration/secrets/

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and set `OPENHAB_TOKEN`. Never commit this file.

Edit `wrangler.jsonc`:
- `OPENHAB_BASE_URL`: upstream origin, e.g. `https://myopenhab.org`.
- `OPENHAB_API_PREFIX`: normally `/rest`.
- `ACCESS_MODE`: `public-demo` or `access`.
- `CORS_ALLOWED_ORIGINS`: comma-separated exact browser origins.
- `ALLOWED_ITEMS_JSON`: item names, read permission, and exact allowed commands.

Run locally:

```bash
npm run types
npm run typecheck
npm run dev
```

Deploy:

```bash
npx wrangler login
npx wrangler secret put OPENHAB_TOKEN
npm run deploy
```

`wrangler secret put` stores the token as an encrypted Worker secret. Do not put it in `vars`, `wrangler.jsonc`, GitHub Actions logs, or source control.

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

No user authentication is required. This mode is appropriate only for a public demonstration backed by virtual items and harmless commands. Anyone who discovers the Worker URL can call its allowlisted operations.

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

The implementation subscribes upstream using exact topic names. Verify that the openHAB version and cloud connector support this event endpoint and topic syntax. The Worker does not buffer the complete stream.

## CORS

Set `CORS_ALLOWED_ORIGINS` to exact origins, e.g. The Worker enables credentialed CORS only for explicitly matched origins (not for `*`):

```text
https://your-dashboard.github.io,http://localhost:5173
```

Do not use `*` for a real installation. CORS only constrains browser JavaScript; it does not stop curl, scripts, or other servers from calling the API.

## Security checklist before production

- [ ] Use a dedicated openHAB API token with minimum permissions.
- [ ] Use `ACCESS_MODE=access` for real installations.
- [ ] Put the Worker behind a Cloudflare Access application.
- [ ] Keep `OPENHAB_TOKEN`, `ACCESS_TEAM_DOMAIN`, and `ACCESS_AUD` as Worker secrets.
- [ ] Keep `.dev.vars` out of Git.
- [ ] Use exact CORS origins (understand that CORS is not authentication).
- [ ] Allowlist only the virtual or real items that must be exposed.
- [ ] Allowlist exact commands per item.
- [ ] Test every command against a noncritical item first.
- [ ] Verify myopenHAB upstream REST and SSE behavior, token scope, reconnects, and idle timeouts.
- [ ] Add Cloudflare rate limiting / abuse protection before publishing a public endpoint.
- [ ] Review logs and avoid logging tokens, event payloads, or personal data.

## Known limitations / next hardening steps

This is a starter implementation, not a certified security gateway.

1. The in-memory Worker runtime does not provide a globally consistent per-user rate limiter. Add Cloudflare rate limiting or a Durable Object if abuse resistance is required.
2. SSE filtering assumes the standard openHAB event envelope contains a `topic` field like `openhab/items/ItemName/state`. Confirm this against your deployed openHAB version and the myopenHAB route.
3. The Worker fetches `/rest/items` before filtering the list. The response is not exposed wholesale, but upstream bandwidth and parsing scale with the full item registry.
4. Cloudflare Access JWT key retrieval is performed during authorization. Add a bounded JWKS cache if request volume warrants it.
5. The implementation uses a dedicated token but cannot restrict token permissions by item at the openHAB server itself. The Worker allowlist is the browser-facing restriction.
6. Add automated integration tests against a disposable openHAB instance before production.

## Development notes

```bash
npm run typecheck
npm test
```

The test suite is intentionally small and currently focuses on allowlist parsing. Add route, command, Access JWT, and SSE integration tests before tagging a stable release.

## License

MIT. See [LICENSE](LICENSE).

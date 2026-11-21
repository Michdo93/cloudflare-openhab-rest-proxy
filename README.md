# cloudflare-openhab-rest-proxy

A small Cloudflare Worker that lets a public web page – for example a dashboard on GitHub Pages – use **parts** of an openHAB REST API without ever seeing the openHAB credentials.

It is not a tunnel. The Worker offers five fixed endpoints, checks every item name against an allowlist, checks every command against the item type, and passes on only state changes of allowed items.

```text
Browser (GitHub Pages)  --/api/v1/*-->  Cloudflare Worker  --/rest/*-->  myopenHAB  -->  openHAB
   no credentials                       allowlist, typed       HTTP Basic
                                        commands, filtered     (+ optional API token)
                                        events, rate limit
```

The matching browser library is [js-openhab-proxy-client](https://github.com/Michdo93/js-openhab-proxy-client). It has the same classes and methods as [js-openhab-rest-client](https://github.com/Michdo93/js-openhab-rest-client), so a dashboard can switch between direct access (at home) and the proxy (public demo) by loading a different script.

## API

| Method | Path | Answer |
|---|---|---|
| GET | `/api/v1/items` | allowed items (JSON, reduced fields) |
| GET | `/api/v1/items/{name}` | one item; group members are filtered |
| GET | `/api/v1/items/{name}/state` | state as text |
| POST | `/api/v1/items/{name}/command` | body: command as text; answer `{"message":"OK"}` |
| GET | `/api/v1/items/{name}/history?start=…&end=…` | values from the persistence: `{"name","datapoints","data":[{"time","state"}]}`; ISO times, default the last 24 h, at most `MAX_HISTORY_DAYS` |
| GET | `/api/v1/events[?items=A,B]` | Server-Sent Events, only `ItemStateChangedEvent` and `GroupItemStateChangedEvent` of allowed items |
| GET | `/health` | `{"status":"ok"}`, does not contact openHAB |

Errors are JSON objects with an `error` text, e.g. `{"error":"Item not found."}` (404) for items that do not exist **or** are not allowed – the proxy does not reveal which. A rejected command answers 403 with a `reason`, too many commands 429.

Events are passed on in the format of openHAB (`event: message`, `data: {"topic","payload","type"}`), so the same parser works for both. The Worker answers the event request immediately and connects to openHAB in the background: myopenHAB only sends the headers of an event stream together with the first event ([openhab-cloud #258](https://github.com/openhab/openhab-cloud/issues/258)). A comment line every 15 s keeps the connection open and lets the Worker notice a closed browser.

## Allowlist

`ALLOWED_ITEMS_JSON` (or the `allowlist` option, see below) maps item names to rules:

```json
{
  "Wohnzimmer_Deckenlampe_Schalter": { "read": true, "commands": "type", "type": "Switch" },
  "Wohnzimmer_Thermostat_Soll": { "read": true, "commands": "type",
                                  "type": "Number:Temperature", "min": 16, "max": 26 },
  "Diele_Alarmanlage_Modus": { "read": true, "commands": ["aus", "intern", "extern"] },
  "Garten_Temperatur": { "read": true }
}
```

| Field | Meaning |
|---|---|
| `read` | item may be listed, read and appears in the event stream |
| `commands` | `"type"`: every command that is valid for `type`; a list: exactly these; missing: none |
| `type` | openHAB item type, needed for `"type"` |
| `min`, `max` | range for Number, Dimmer and Rollershutter commands |

What `"type"` allows:

| Type | Commands |
|---|---|
| Switch | `ON`, `OFF` |
| Dimmer | `ON`, `OFF`, `INCREASE`, `DECREASE`, 0–100 |
| Color | as Dimmer, plus `H,S,B` (0–360, 0–100, 0–100) |
| Rollershutter | `UP`, `DOWN`, `STOP`, `MOVE`, 0–100 |
| Player | `PLAY`, `PAUSE`, `NEXT`, `PREVIOUS`, `REWIND`, `FASTFORWARD` |
| Number | a number; `Number:<Dimension>` also with a unit, e.g. `21.5 °C` |
| String | any text up to `MAX_COMMAND_LENGTH` without control characters |
| DateTime | ISO 8601 date and time |
| Location | `latitude,longitude[,altitude]` |
| Contact, Call, Image, Group | none – sensors are read-only, groups would switch many items at once |

Prefer a fixed list for String items with a few modes. Sensors get no `commands` at all.

## Setup

Requirements: a free Cloudflare account, Node.js 20 or newer, an openHAB 5 that is reachable over HTTPS – usually through the [openHAB Cloud Connector](https://www.openhab.org/addons/integrations/openhabcloud/) and myopenHAB.

```bash
git clone https://github.com/Michdo93/cloudflare-openhab-rest-proxy
cd cloudflare-openhab-rest-proxy
npm install
npm test
```

Edit `wrangler.jsonc`:

| Variable | Example |
|---|---|
| `OPENHAB_URL` | `https://myopenhab.org` or your own `https://openhab.example.org` |
| `ACCESS_MODE` | `public-demo` or `access` (see below) |
| `CORS_ALLOWED_ORIGINS` | `https://YOUR-NAME.github.io,http://localhost:5173` |
| `ALLOWED_ITEMS_JSON` | the allowlist as one JSON string (max. 5 KB) |
| `PERSISTENCE_SERVICE` | service for `/history`, e.g. `rrd4j`; empty = the default of openHAB |
| `MAX_HISTORY_DAYS` | longest period for `/history` (default 7, `0` switches it off) |

Secrets never go into `wrangler.jsonc` or Git:

```bash
npx wrangler login
npx wrangler secret put OPENHAB_USER        # myopenHAB: your e-mail address
npx wrangler secret put OPENHAB_PASSWORD    # myopenHAB: your password
npx wrangler secret put OPENHAB_TOKEN       # optional, see below
npm run deploy
```

Authentication towards openHAB:

| Secrets | Sent as | Use |
|---|---|---|
| `OPENHAB_USER` + `OPENHAB_PASSWORD` | `Authorization: Basic …` | myopenHAB |
| + `OPENHAB_TOKEN` | additionally `X-OPENHAB-TOKEN: …` | myopenHAB, if openHAB itself requires a token |
| only `OPENHAB_TOKEN` | `Authorization: Bearer …` | an openHAB that is directly reachable over HTTPS |

For local development copy `.dev.vars.example` to `.dev.vars` and run `npm run dev`.

## Access modes

**`public-demo`** – anyone who knows the Worker URL may use the allowlist. Only for virtual items that control nothing real. Commands are rate-limited per client (`COMMAND_LIMITER` binding in `wrangler.jsonc`, 20 per minute; without the binding a simple per-instance limiter with 30 per minute is used).

**`access`** (default) – every request needs a valid [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/) token (`Cf-Access-Jwt-Assertion`). Put an Access application in front of the Worker and set `ACCESS_TEAM_DOMAIN` (e.g. `example.cloudflareaccess.com`) and `ACCESS_AUD` as secrets. Use this mode for real devices.

CORS only stops other web pages in a browser. It does not stop curl or scripts – the allowlist and the access mode do.

## Using the proxy as a library

Keep your own configuration in a separate (private) repository and install this one as a dependency:

```bash
npm install github:Michdo93/cloudflare-openhab-rest-proxy#v0.3.0
```

```ts
import { createProxy } from "cloudflare-openhab-rest-proxy";
import { ALLOWLIST } from "./allowlist";

export default createProxy({
  allowlist: ALLOWLIST,
  upstreamUrl: "https://myopenhab.org",
  accessMode: "public-demo",
  corsOrigins: ["https://your-name.github.io"]
});
```

`createProxy()` also accepts a function `(env) => options` if parts of the configuration come from variables.

## Tested

- Unit tests (`npm test`) for commands, allowlist and event filter, the latter with frames recorded from openHAB 5.2.3.
- `wrangler dev` against openHAB 5.2.3 behind `tools/fake-myopenhab.mjs`, a stand-in that checks HTTP Basic and holds back the event-stream headers like myopenHAB: lists, groups, states, allowed and rejected commands, foreign origins, rate limit, event filter.
- Not tested here: the real myopenHAB service and a deployed Worker. Check both with your account before you publish the URL.

In `wrangler dev` a closed browser is noticed with the next heartbeat (at most 15 s), not at once.

## Support

If this project helps you, I appreciate a coffee:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/Michdo93)

## License

MIT – see [LICENSE](LICENSE).

import { isItemName, readableItems } from "./allowlist";
import { checkAccess } from "./access";
import { checkCommand } from "./commands";
import { eventStream } from "./events";
import { restUrl, upstream } from "./upstream";
import type { Allowlist, Env, ProxyOptions } from "./types";

const KEEP = ["name", "label", "type", "groupType", "state", "transformedState",
  "stateDescription", "commandDescription", "unitSymbol", "category", "tags"];
const LIST_FIELDS = [...KEEP, "groupNames"].join(",");

type Item = Record<string, unknown>;

/** Keeps only harmless fields and hides items that are not allowed. */
export function cleanItem(item: Item, allowlist: Allowlist): Item {
  const result: Item = {};
  for (const key of KEEP) if (key in item) result[key] = item[key];
  const allowed = (name: unknown) =>
    typeof name === "string" && allowlist[name]?.read;
  if (Array.isArray(item.groupNames)) {
    result.groupNames = item.groupNames.filter(allowed);
  }
  if (Array.isArray(item.members)) {
    result.members = (item.members as Item[])
      .filter((member) => allowed(member.name))
      .map((member) => cleanItem(member, allowlist));
  }
  return result;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

const NOT_FOUND = () => json({ error: "Item not found." }, 404);

/** Simple limiter per Worker instance, used without a rate limit binding. */
class LocalLimiter {
  private hits = new Map<string, { count: number; until: number }>();
  constructor(private perMinute: number) {}
  async limit({ key }: { key: string }) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.until < now) {
      if (this.hits.size > 5000) this.hits.clear();
      this.hits.set(key, { count: 1, until: now + 60_000 });
      return { success: true };
    }
    entry.count += 1;
    return { success: entry.count <= this.perMinute };
  }
}

/** Creates the Worker: a fixed, small API in front of openHAB. */
export function createProxy(options: ProxyOptions | ((env: Env) => ProxyOptions)) {
  let fallback: LocalLimiter | undefined;

  return {
    async fetch(
      request: Request, env: Env, ctx?: ExecutionContext
    ): Promise<Response> {
      let config: ProxyOptions;
      try {
        config = typeof options === "function" ? options(env) : options;
      } catch (error) {
        console.error("configuration:", error);
        return json({ error: "proxy configuration error" }, 500);
      }
      const cors = corsHeaders(request, config.corsOrigins);
      const origin = request.headers.get("Origin");
      if (origin && !cors.has("Access-Control-Allow-Origin")) {
        return json({ error: "origin not allowed" }, 403);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }

      let response: Response;
      try {
        response = await route(request, { ...env, OPENHAB_URL: config.upstreamUrl },
          config, ctx,
          () => (fallback ??= new LocalLimiter(config.commandsPerMinute ?? 30)));
      } catch (error) {
        console.error("proxy:", error);
        response = json({ error: "openHAB not reachable" }, 502);
      }
      const headers = new Headers(response.headers);
      cors.forEach((value, key) => headers.set(key, value));
      return new Response(response.body, { status: response.status, headers });
    }
  };
}

async function route(
  request: Request, env: Env, config: ProxyOptions,
  ctx: ExecutionContext | undefined, local: () => LocalLimiter
): Promise<Response> {
  const url = new URL(request.url);
  const { allowlist } = config;
  const timeout = config.upstreamTimeoutMs ?? 15000;

  if (url.pathname === "/health" && request.method === "GET") {
    return json({ status: "ok", service: "cloudflare-openhab-rest-proxy" });
  }
  if (config.accessMode !== "public-demo" && !(await checkAccess(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  if (url.pathname === "/api/v1/items" && request.method === "GET") {
    const upstreamResponse = await upstream(env,
      restUrl(env.OPENHAB_URL!, "items", { fields: LIST_FIELDS }), {}, timeout);
    if (!upstreamResponse.ok) return json({ error: "openHAB error" }, 502);
    const items = await upstreamResponse.json() as Item[];
    return json(items
      .filter((item) => allowlist[String(item.name)]?.read)
      .map((item) => cleanItem(item, allowlist)));
  }

  if (url.pathname === "/api/v1/events" && request.method === "GET") {
    const wanted = url.searchParams.get("items");
    const only = wanted ? new Set(wanted.split(",").filter(isItemName)) : undefined;
    if (readableItems(allowlist).length === 0) {
      return json({ error: "nothing allowed" }, 404);
    }
    const { response, done } = eventStream(request, env, allowlist, {
      only, timeoutMs: timeout, heartbeatMs: config.heartbeatMs ?? 15000
    });
    ctx?.waitUntil(done);
    return response;
  }

  const match = /^\/api\/v1\/items\/([^/]+)(?:\/(state|command))?$/
    .exec(url.pathname);
  if (!match) return json({ error: "not found" }, 404);
  const name = safeName(match[1]);
  const rule = name ? allowlist[name] : undefined;
  if (!name || !rule) return NOT_FOUND();
  const item = encodeURIComponent(name);

  if (match[2] === "command") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const command = (await request.text()).trim();
    const reason = checkCommand(rule, command, config.maxCommandLength ?? 64);
    if (reason) return json({ error: "Command not allowed.", reason }, 403);
    const limiter = env.COMMAND_LIMITER ?? local();
    const client = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await limiter.limit({ key: client })).success) {
      return json({ error: "Too many commands." }, 429);
    }
    const answer = await upstream(env, restUrl(env.OPENHAB_URL!, `items/${item}`), {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: command
    }, timeout);
    if (answer.status === 400) {
      return json({ error: "Invalid command for this item." }, 400);
    }
    if (answer.status === 404) return NOT_FOUND();
    if (!answer.ok) return json({ error: "openHAB error" }, 502);
    return json({ message: "OK" });
  }

  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!rule.read) return NOT_FOUND();
  if (match[2] === "state") {
    const answer = await upstream(env,
      restUrl(env.OPENHAB_URL!, `items/${item}/state`),
      { headers: { Accept: "text/plain" } }, timeout);
    if (answer.status === 404) return NOT_FOUND();
    if (!answer.ok) return json({ error: "openHAB error" }, 502);
    return new Response(await answer.text(), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
  const answer = await upstream(env,
    restUrl(env.OPENHAB_URL!, `items/${item}`, { metadata: "none" }), {}, timeout);
  if (answer.status === 404) return NOT_FOUND();
  if (!answer.ok) return json({ error: "openHAB error" }, 502);
  return json(cleanItem(await answer.json() as Item, allowlist));
}

function safeName(raw: string): string | null {
  try {
    const name = decodeURIComponent(raw);
    return isItemName(name) ? name : null;
  } catch {
    return null;
  }
}

function corsHeaders(request: Request, origins: string[]): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin"
  });
  const origin = request.headers.get("Origin");
  if (origin && origins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true"); // Cloudflare Access
  } else if (origin && origins.includes("*")) {
    headers.set("Access-Control-Allow-Origin", "*");         // no credentials
  }
  return headers;
}

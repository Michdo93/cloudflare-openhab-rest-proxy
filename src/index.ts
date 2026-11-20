import type { Allowlist, Env, OpenHABEventEnvelope } from "./types";
import { authorize, isAllowedOrigin, parseAllowlist } from "./security";
import { upstreamFetch } from "./openhab";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers({ ...JSON_HEADERS, "Cache-Control": "no-store" });
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
    "Access-Control-Max-Age": "600"
  });
  const allowedOrigin = isAllowedOrigin(request, env);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    if (allowedOrigin !== "*") headers.set("Access-Control-Allow-Credentials", "true");
  }
  return headers;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function parseItemName(raw: string): string | null {
  try {
    const name = decodeURIComponent(raw);
    return /^[A-Za-z0-9_-]{1,128}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

function getPermissions(env: Env): Allowlist {
  return parseAllowlist(env.ALLOWED_ITEMS_JSON);
}

async function proxyJson(response: Response): Promise<Response> {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    return json({ error: "openhab_upstream_error", status: response.status, detail }, response.status);
  }
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: { ...JSON_HEADERS, "Cache-Control": "no-store" }
  });
}

async function listItems(env: Env, allowlist: Allowlist): Promise<Response> {
  const permitted = Object.entries(allowlist).filter(([, permission]) => permission.read).map(([name]) => name);
  if (permitted.length === 0) return json([]);
  const upstream = await upstreamFetch(env, "items");
  if (!upstream.ok) return proxyJson(upstream);
  const items = await upstream.json() as Array<Record<string, unknown>>;
  const byName = new Map(items.map((item) => [String(item.name ?? ""), item]));
  return json(permitted.map((name) => byName.get(name)).filter(Boolean));
}

async function getItem(env: Env, name: string): Promise<Response> {
  const upstream = await upstreamFetch(env, `items/${encodeURIComponent(name)}`);
  return proxyJson(upstream);
}

async function getItemState(env: Env, name: string): Promise<Response> {
  const upstream = await upstreamFetch(env, `items/${encodeURIComponent(name)}/state`, {
    headers: { "Accept": "text/plain" }
  });
  if (!upstream.ok) return proxyJson(upstream);
  return new Response(await upstream.text(), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function sendCommand(request: Request, env: Env, name: string, allowed: string[]): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > 256) return json({ error: "command_too_large" }, 413);
  const command = (await request.text()).trim();
  const maxLength = Math.max(1, Number(env.MAX_COMMAND_LENGTH ?? "64"));
  if (!command || command.length > maxLength || !allowed.includes(command)) {
    return json({ error: "command_not_allowed" }, 403);
  }
  const upstream = await upstreamFetch(env, `items/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8", "Accept": "application/json" },
    body: command
  });
  if (!upstream.ok) return proxyJson(upstream);
  return json({ accepted: true, item: name, command }, 202);
}

function isAllowedEvent(envelope: OpenHABEventEnvelope, allowlist: Allowlist): boolean {
  const topic = typeof envelope.topic === "string" ? envelope.topic : "";
  const match = topic.match(/^openhab\/items\/([A-Za-z0-9_-]+)\/state$/);
  return Boolean(match && allowlist[match[1]]?.read);
}

async function events(request: Request, env: Env, allowlist: Allowlist): Promise<Response> {
  const names = Object.entries(allowlist).filter(([, permission]) => permission.read).map(([name]) => name);
  if (names.length === 0) return new Response("event: proxy-ready\ndata: {}\n\n", {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" }
  });

  const topics = names.map((name) => `openhab/items/${name}/state`).join(",");
  const upstream = await upstreamFetch(env, `events?topics=${encodeURIComponent(topics)}`, {
    headers: { "Accept": "text/event-stream" },
    signal: request.signal
  });
  if (!upstream.ok || !upstream.body) {
    return json({ error: "event_stream_unavailable", status: upstream.status }, upstream.status || 502);
  }

  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            if (buffer.trim()) processFrame(buffer, controller, encoder, allowlist);
            closed = true;
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let boundaryMatch: RegExpExecArray | null;
          const frameBoundary = /\r?\n\r?\n/;
          while ((boundaryMatch = frameBoundary.exec(buffer)) !== null) {
            const frame = buffer.slice(0, boundaryMatch.index);
            buffer = buffer.slice(boundaryMatch.index + boundaryMatch[0].length);
            processFrame(frame, controller, encoder, allowlist);
          }
          // Return control after each upstream chunk so the downstream can apply backpressure.
          return;
        }
      } catch {
        closed = true;
        try { controller.close(); } catch { /* stream already closed */ }
      }
    },
    async cancel(reason) {
      closed = true;
      try { await reader.cancel(reason); } catch { /* upstream already closed */ }
    }
  });

  request.signal.addEventListener("abort", () => {
    if (!closed) {
      closed = true;
      void reader.cancel("downstream request aborted");
    }
  }, { once: true });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

function processFrame(
  frame: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  allowlist: Allowlist
): void {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (eventName !== "ItemStateChangedEvent" || dataLines.length === 0) return;
  try {
    const envelope = JSON.parse(dataLines.join("\n")) as OpenHABEventEnvelope;
    if (!isAllowedEvent(envelope, allowlist)) return;
    controller.enqueue(encoder.encode(`${frame}\n\n`));
  } catch {
    // Ignore malformed upstream event frames rather than leaking unclassified data.
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      if (request.headers.has("Origin") && !cors.has("Access-Control-Allow-Origin")) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return withCors(json({ status: "ok", service: "cloudflare-openhab-rest-proxy" }), request, env);
    }

    if (request.headers.has("Origin") && !cors.has("Access-Control-Allow-Origin")) {
      return json({ error: "origin_not_allowed" }, 403);
    }
    if (!await authorize(request, env)) {
      return withCors(json({ error: "unauthorized" }, 401), request, env);
    }

    let allowlist: Allowlist;
    try {
      allowlist = getPermissions(env);
    } catch (error) {
      return withCors(json({ error: "proxy_configuration_error", detail: String(error) }, 500), request, env);
    }

    try {
      let response: Response;
      if (url.pathname === "/api/v1/items" && request.method === "GET") {
        response = await listItems(env, allowlist);
      } else if (url.pathname === "/api/v1/events" && request.method === "GET") {
        response = await events(request, env, allowlist);
      } else {
        const match = url.pathname.match(/^\/api\/v1\/items\/([^/]+)(?:\/(state|command))?$/);
        if (!match) response = json({ error: "not_found" }, 404);
        else {
          const name = parseItemName(match[1]);
          const permission = name ? allowlist[name] : undefined;
          if (!name || !permission) response = json({ error: "item_not_allowed" }, 404);
          else if (match[2] === "command" && request.method === "POST") {
            response = await sendCommand(request, env, name, permission.commands);
          } else if (match[2] === "state" && request.method === "GET" && permission.read) {
            response = await getItemState(env, name);
          } else if (!match[2] && request.method === "GET" && permission.read) {
            response = await getItem(env, name);
          } else response = json({ error: "method_not_allowed" }, 405);
        }
      }
      return withCors(response, request, env);
    } catch (error) {
      return withCors(json({ error: "proxy_error", detail: String(error) }, 502), request, env);
    }
  }
};

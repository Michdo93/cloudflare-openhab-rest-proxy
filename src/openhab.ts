import type { Env } from "./types";

export function openHABUrl(env: Env, path: string): URL {
  const base = new URL(env.OPENHAB_BASE_URL);
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("OPENHAB_BASE_URL must use HTTPS (except local development)");
  }
  const prefix = (env.OPENHAB_API_PREFIX ?? "/rest").replace(/\/+$/, "");
  const safePath = path.replace(/^\/+/, "");
  return new URL(`${prefix}/${safePath}`, base);
}

export async function upstreamFetch(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Basic ${btoa(`${env.OPENHAB_TOKEN}:`)}`);
  headers.set("Accept", headers.get("Accept") ?? "application/json");
  const timeout = Math.max(1000, Number(env.UPSTREAM_TIMEOUT_MS ?? "15000"));
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);

  return fetch(openHABUrl(env, path), {
    ...init,
    headers,
    signal,
    redirect: "manual"
  });
}

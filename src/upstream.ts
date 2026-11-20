import type { Env } from "./types";

/** Headers with the credentials for openHAB or myopenHAB. */
export function authHeaders(env: Env): Headers {
  const headers = new Headers();
  const basic = env.OPENHAB_USER && env.OPENHAB_PASSWORD;
  if (basic) {
    const pair = `${env.OPENHAB_USER}:${env.OPENHAB_PASSWORD}`;
    headers.set("Authorization", `Basic ${base64(pair)}`);
  }
  if (env.OPENHAB_TOKEN) {
    // myopenHAB uses Authorization itself; openHAB also reads X-OPENHAB-TOKEN.
    if (basic) headers.set("X-OPENHAB-TOKEN", env.OPENHAB_TOKEN);
    else headers.set("Authorization", `Bearer ${env.OPENHAB_TOKEN}`);
  }
  return headers;
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Builds the URL below /rest/ – only from fixed paths of the proxy. */
export function restUrl(
  baseUrl: string, path: string, query?: Record<string, string>
): URL {
  const base = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1"].includes(base.hostname);
  if (base.protocol !== "https:" && !local) {
    throw new Error("OPENHAB_URL must use HTTPS");
  }
  const url = new URL(`${base.pathname.replace(/\/+$/, "")}/rest/${path}`, base);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * Calls openHAB. The timeout only covers the time until the response
 * headers arrive, so that event streams stay open afterwards.
 */
export async function upstream(
  env: Env, url: URL, init: RequestInit = {}, timeoutMs = 15000
): Promise<Response> {
  const headers = authHeaders(env);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("upstream timeout")), timeoutMs);
  const outer = init.signal;
  const onAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url,
      { ...init, headers, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

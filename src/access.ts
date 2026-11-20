import type { Env } from "./types";

interface Jwks { keys?: Array<JsonWebKey & { kid?: string }> }
let jwksCache: { team: string; keys: Jwks; until: number } | undefined;

/** Checks the Cloudflare Access token (Cf-Access-Jwt-Assertion). */
export async function checkAccess(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const team = env.ACCESS_TEAM_DOMAIN;
  if (!token || !team || !env.ACCESS_AUD) return false;
  try {
    const [head, body, signature] = token.split(".");
    const header = JSON.parse(text(head)) as { alg?: string; kid?: string };
    const claims = JSON.parse(text(body)) as {
      aud?: string | string[]; exp?: number; nbf?: number; iss?: string;
    };
    if (header.alg !== "RS256" || !header.kid) return false;
    if (claims.iss !== `https://${team}`) return false;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(env.ACCESS_AUD)) return false;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now) return false;
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) return false;
    const jwk = (await keys(team)).keys?.find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(signature),
      new TextEncoder().encode(`${head}.${body}`));
  } catch {
    return false;
  }
}

async function keys(team: string): Promise<Jwks> {
  if (jwksCache && jwksCache.team === team && jwksCache.until > Date.now()) {
    return jwksCache.keys;
  }
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error("JWKS not available");
  const loaded = await response.json() as Jwks;
  jwksCache = { team, keys: loaded, until: Date.now() + 10 * 60 * 1000 };
  return loaded;
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function text(value: string): string {
  return new TextDecoder().decode(bytes(value));
}

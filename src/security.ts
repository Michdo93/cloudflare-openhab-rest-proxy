import type { Env } from "./types";

export function parseAllowlist(raw: string): Record<string, { read: boolean; commands: string[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ALLOWED_ITEMS_JSON is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ALLOWED_ITEMS_JSON must be a JSON object");
  }
  const result: Record<string, { read: boolean; commands: string[] }> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
      throw new Error(`Invalid item name in allowlist: ${name}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid permission entry for ${name}`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.read !== "boolean" || !Array.isArray(entry.commands) ||
        !entry.commands.every((command) => typeof command === "string" && command.length <= 64)) {
      throw new Error(`Invalid permission entry for ${name}`);
    }
    result[name] = {
      read: entry.read,
      commands: [...new Set((entry.commands as string[]).map((command) => command.trim()).filter(Boolean))]
    };
  }
  return result;
}

export function isAllowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const configured = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return configured.includes("*") ? "*" : (configured.includes(origin) ? origin : null);
}

export async function authorize(request: Request, env: Env): Promise<boolean> {
  if (env.ACCESS_MODE === "public-demo") return true;
  if (env.ACCESS_MODE !== "access") return false;

  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = assertion.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return false;
    const header = JSON.parse(decodeBase64Url(encodedHeader)) as { alg?: string; kid?: string };
    const payload = JSON.parse(decodeBase64Url(encodedPayload)) as {
      aud?: string | string[];
      exp?: number;
      nbf?: number;
      iss?: string;
    };
    if (header.alg !== "RS256" || !header.kid) return false;
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return false;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(env.ACCESS_AUD)) return false;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= now) return false;
    if (typeof payload.nbf === "number" && payload.nbf > now + 60) return false;
    const jwksResponse = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    if (!jwksResponse.ok) return false;
    const jwks = await jwksResponse.json() as { keys?: JsonWebKey[] };
    const jwk = jwks.keys?.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
    if (!jwk) return false;
    const publicKey = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", publicKey, decodeBase64UrlBytes(encodedSignature), data
    );
  } catch {
    return false;
  }
}

function decodeBase64Url(value: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(value));
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

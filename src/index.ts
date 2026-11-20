import { parseAllowlist } from "./allowlist";
import { createProxy } from "./proxy";
import type { AccessMode, Env, ProxyOptions } from "./types";

export { createProxy } from "./proxy";
export { parseAllowlist } from "./allowlist";
export { checkCommand } from "./commands";
export type * from "./types";

/** Reads the configuration from the variables in wrangler.jsonc. */
export function optionsFromEnv(env: Env): ProxyOptions {
  const mode = env.ACCESS_MODE ?? "access";
  if (mode !== "public-demo" && mode !== "access") {
    throw new Error("ACCESS_MODE must be public-demo or access");
  }
  if (!env.OPENHAB_URL) throw new Error("OPENHAB_URL is missing");
  return {
    allowlist: parseAllowlist(env.ALLOWED_ITEMS_JSON ?? "{}"),
    upstreamUrl: env.OPENHAB_URL,
    accessMode: mode as AccessMode,
    corsOrigins: (env.CORS_ALLOWED_ORIGINS ?? "").split(",")
      .map((origin) => origin.trim()).filter(Boolean),
    maxCommandLength: Number(env.MAX_COMMAND_LENGTH ?? 64),
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 15000)
  };
}

let cached: { raw: string; options: ProxyOptions } | undefined;

export default createProxy((env) => {
  const raw = JSON.stringify([env.OPENHAB_URL, env.ACCESS_MODE,
    env.CORS_ALLOWED_ORIGINS, env.ALLOWED_ITEMS_JSON]);
  if (cached?.raw !== raw) cached = { raw, options: optionsFromEnv(env) };
  return cached.options;
});

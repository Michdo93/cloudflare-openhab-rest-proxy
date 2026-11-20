import type { Allowlist, ItemRule } from "./types";

const NAME = /^[A-Za-z0-9_]{1,128}$/;

/** Checks an item name: letters, digits and underscores, like openHAB. */
export function isItemName(name: string): boolean {
  return NAME.test(name);
}

/** Reads and checks an allowlist, e.g. from ALLOWED_ITEMS_JSON. */
export function parseAllowlist(raw: unknown): Allowlist {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("allowlist must be an object");
  }
  const result: Allowlist = {};
  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    if (!isItemName(name)) throw new Error(`invalid item name: ${name}`);
    result[name] = checkRule(name, value);
  }
  return result;
}

function checkRule(name: string, value: unknown): ItemRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid rule for ${name}`);
  }
  const rule = value as Record<string, unknown>;
  if (typeof rule.read !== "boolean") throw new Error(`${name}: read missing`);
  const commands = rule.commands ?? [];
  const isList = Array.isArray(commands) &&
    commands.every((c) => typeof c === "string" && c.length > 0 && c.length <= 64);
  if (commands !== "type" && !isList) {
    throw new Error(`${name}: commands must be "type" or a list of strings`);
  }
  if (commands === "type" && typeof rule.type !== "string") {
    throw new Error(`${name}: commands "type" needs the item type`);
  }
  for (const key of ["min", "max"] as const) {
    if (rule[key] !== undefined && typeof rule[key] !== "number") {
      throw new Error(`${name}: ${key} must be a number`);
    }
  }
  return {
    read: rule.read,
    commands: commands as ItemRule["commands"],
    ...(typeof rule.type === "string" ? { type: rule.type } : {}),
    ...(typeof rule.min === "number" ? { min: rule.min } : {}),
    ...(typeof rule.max === "number" ? { max: rule.max } : {})
  };
}

/** Names of all readable items. */
export function readableItems(allowlist: Allowlist): string[] {
  return Object.keys(allowlist).filter((name) => allowlist[name].read);
}

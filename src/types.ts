/** Item types of openHAB 5 that the proxy knows how to validate. */
export type ItemType =
  | "Switch" | "Dimmer" | "Color" | "Rollershutter" | "Player"
  | "Number" | "String" | "DateTime" | "Location" | "Contact"
  | "Call" | "Image" | "Group";

/** What the proxy allows for one item. */
export interface ItemRule {
  /** Item may be read: list, item, state and events. */
  read: boolean;
  /**
   * Allowed commands:
   *  - "type": everything that is valid for the item type
   *  - a list: exactly these commands
   *  - none / empty list: no commands
   */
  commands?: "type" | string[];
  /** Item type, e.g. "Dimmer" or "Number:Temperature". */
  type?: string;
  /** Range for numeric commands (Number, Dimmer, Rollershutter). */
  min?: number;
  max?: number;
}

export type Allowlist = Record<string, ItemRule>;

export type AccessMode = "public-demo" | "access";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Everything createProxy() needs. */
export interface ProxyOptions {
  allowlist: Allowlist;
  /** e.g. "https://myopenhab.org" or "http://openhab:8080" */
  upstreamUrl: string;
  accessMode: AccessMode;
  corsOrigins: string[];
  maxCommandLength?: number;
  upstreamTimeoutMs?: number;
  heartbeatMs?: number;
  /** Requests per minute and client in the fallback limiter. */
  commandsPerMinute?: number;
  /** Persistence service for /history, e.g. "rrd4j"; null = openHAB default. */
  persistenceService?: string | null;
  /** Longest period /history returns, in days (default 7, 0 = off). */
  maxHistoryDays?: number;
}

/** Bindings and secrets of the Worker. */
export interface Env {
  OPENHAB_URL?: string;
  OPENHAB_USER?: string;
  OPENHAB_PASSWORD?: string;
  OPENHAB_TOKEN?: string;
  ACCESS_MODE?: string;
  CORS_ALLOWED_ORIGINS?: string;
  ALLOWED_ITEMS_JSON?: string;
  MAX_COMMAND_LENGTH?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  PERSISTENCE_SERVICE?: string;
  MAX_HISTORY_DAYS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  COMMAND_LIMITER?: RateLimiter;
}

/** One event as openHAB sends it in the "data:" line. */
export interface OpenHABEvent {
  topic: string;
  payload: string;
  type: string;
}

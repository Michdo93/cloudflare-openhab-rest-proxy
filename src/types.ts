export interface ItemPermission {
  read: boolean;
  commands: string[];
}

export interface Env {
  MYOPENHAB_BASE_URL: string;
  OPENHAB_API_PREFIX?: string;
  ACCESS_MODE: "public-demo" | "access";
  CORS_ALLOWED_ORIGINS?: string;
  ALLOWED_ITEMS_JSON: string;
  MAX_COMMAND_LENGTH?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  MYOPENHAB_EMAIL: string;
  MYOPENHAB_PASSWORD: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

export interface OpenHABEventEnvelope {
  topic?: string;
  payload?: string;
  type?: string;
  [key: string]: unknown;
}

export type Allowlist = Record<string, ItemPermission>;

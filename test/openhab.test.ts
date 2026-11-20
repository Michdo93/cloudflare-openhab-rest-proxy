import { afterEach, describe, expect, it, vi } from "vitest";
import { openHABUrl, upstreamFetch } from "../src/openhab";
import type { Env } from "../src/types";

const env: Env = {
  MYOPENHAB_BASE_URL: "https://myopenhab.org",
  OPENHAB_API_PREFIX: "/rest",
  ACCESS_MODE: "public-demo",
  ALLOWED_ITEMS_JSON: "{}",
  MYOPENHAB_EMAIL: "demo@example.com",
  MYOPENHAB_PASSWORD: "test-password"
};

afterEach(() => vi.unstubAllGlobals());

describe("myopenHAB upstream connection", () => {
  it("builds REST URLs on myopenhab.org", () => {
    expect(openHABUrl(env, "items").toString()).toBe("https://myopenhab.org/rest/items");
  });

  it("uses HTTP Basic authentication with email and password", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await upstreamFetch(env, "items");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(url.toString()).toBe("https://myopenhab.org/rest/items");
    expect(headers.get("Authorization")).toBe(`Basic ${btoa("demo@example.com:test-password")}`);
    expect(headers.get("Authorization")).not.toContain("API_TOKEN");
  });

  it("fails clearly if myopenHAB credentials are missing", async () => {
    await expect(upstreamFetch({ ...env, MYOPENHAB_PASSWORD: "" }, "items"))
      .rejects.toThrow("MYOPENHAB_EMAIL and MYOPENHAB_PASSWORD must be configured");
  });
});

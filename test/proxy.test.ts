import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxy } from "../src/proxy";

const proxy = createProxy({
  allowlist: {
    Licht: { read: true, commands: "type", type: "Switch" },
    Sensor: { read: true }
  },
  upstreamUrl: "https://myopenhab.org",
  accessMode: "public-demo",
  corsOrigins: ["https://demo.example"]
});
const env = { OPENHAB_USER: "a@b.c", OPENHAB_PASSWORD: "geheim" };
const call = (path: string, init?: RequestInit) =>
  proxy.fetch(new Request(`https://proxy.example${path}`, init), env);

afterEach(() => vi.restoreAllMocks());

describe("proxy", () => {
  it("sends allowed commands with Basic auth to /rest/items", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const answer = await call("/api/v1/items/Licht/command",
      { method: "POST", body: "ON" });
    expect(await answer.json()).toEqual({ message: "OK" });
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://myopenhab.org/rest/items/Licht");
    expect(new Headers(init.headers).get("Authorization"))
      .toBe(`Basic ${btoa("a@b.c:geheim")}`);
  });

  it("never asks openHAB for rejected requests", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await call("/api/v1/items/Sensor/command",
      { method: "POST", body: "5" })).status).toBe(403);
    expect((await call("/api/v1/items/Licht/command",
      { method: "POST", body: "TOGGLE" })).status).toBe(403);
    expect((await call("/api/v1/items/Herd/state")).status).toBe(404);
    expect((await call("/api/v1/items",
      { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes members and fields that are not allowed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      name: "Licht", type: "Switch", state: "ON", link: "https://intern/rest",
      editable: true, groupNames: ["Geheim"],
      members: [{ name: "Sensor" }, { name: "Herd" }]
    }));
    const item = await (await call("/api/v1/items/Licht")).json();
    expect(item).toEqual({ name: "Licht", type: "Switch", state: "ON",
      groupNames: [], members: [{ name: "Sensor" }] });
  });
});

describe("history", () => {
  it("asks the persistence for a limited period and passes only time and state",
    async () => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ name: "Sensor", data: [{ time: 1, state: "20.5", x: 1 }] }));
      const answer = await call("/api/v1/items/Sensor/history"
        + "?start=2026-11-20T00:00:00Z&end=2026-11-21T00:00:00Z");
      expect(await answer.json())
        .toEqual({ name: "Sensor", datapoints: 1, data: [{ time: 1, state: "20.5" }] });
      expect(String(fetch.mock.calls[0][0])).toContain("/rest/persistence/items/Sensor?");
    });

  it("refuses long periods and unknown items without asking openHAB", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await call("/api/v1/items/Sensor/history"
      + "?start=2026-01-01T00:00:00Z&end=2026-11-21T00:00:00Z")).status).toBe(400);
    expect((await call("/api/v1/items/Herd/history")).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});

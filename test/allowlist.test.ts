import { describe, expect, it } from "vitest";
import { parseAllowlist } from "../src/allowlist";

describe("parseAllowlist", () => {
  it("reads valid rules", () => {
    const list = parseAllowlist(
      '{"Licht":{"read":true,"commands":"type","type":"Switch"}}');
    expect(list.Licht).toEqual({ read: true, commands: "type", type: "Switch" });
  });
  it("rejects unsafe or incomplete rules", () => {
    expect(() => parseAllowlist('{"../rest":{"read":true}}')).toThrow();
    expect(() => parseAllowlist('{"A":{"read":true,"commands":"type"}}')).toThrow();
    expect(() => parseAllowlist('{"A":{"read":"yes"}}')).toThrow();
    expect(() => parseAllowlist('{"A":{"read":true,"commands":"*"}}')).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { parseAllowlist } from "../src/security";

describe("parseAllowlist", () => {
  it("parses valid item permissions", () => {
    expect(parseAllowlist('{"Lamp":{"read":true,"commands":["ON","OFF"]}}')).toEqual({
      Lamp: { read: true, commands: ["ON", "OFF"] }
    });
  });

  it("rejects malformed JSON", () => {
    expect(() => parseAllowlist("{")).toThrow();
  });

  it("rejects unsafe item names", () => {
    expect(() => parseAllowlist('{"Bad/Name":{"read":true,"commands":[]}}')).toThrow();
  });

  it("rejects malformed permissions", () => {
    expect(() => parseAllowlist('{"Lamp":{"read":"yes","commands":[]}}')).toThrow();
  });
});

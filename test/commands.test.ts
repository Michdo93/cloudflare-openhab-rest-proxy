import { describe, expect, it } from "vitest";
import { checkCommand } from "../src/commands";
import type { ItemRule } from "../src/types";

const typed = (type: string, extra: Partial<ItemRule> = {}): ItemRule =>
  ({ read: true, commands: "type", type, ...extra });

describe("checkCommand", () => {
  it("accepts what the item type accepts", () => {
    expect(checkCommand(typed("Switch"), "ON")).toBeNull();
    expect(checkCommand(typed("Dimmer"), "42.5")).toBeNull();
    expect(checkCommand(typed("Color"), "240,100,50")).toBeNull();
    expect(checkCommand(typed("Rollershutter"), "STOP")).toBeNull();
    expect(checkCommand(typed("Player"), "PAUSE")).toBeNull();
    expect(checkCommand(typed("Number:Temperature"), "21.5 °C")).toBeNull();
    expect(checkCommand(typed("Location"), "48.05,8.2")).toBeNull();
    expect(checkCommand(typed("DateTime"), "2026-11-20T19:57:52+01:00")).toBeNull();
  });

  it("rejects what does not fit", () => {
    expect(checkCommand(typed("Switch"), "TOGGLE")).not.toBeNull();
    expect(checkCommand(typed("Dimmer"), "150")).not.toBeNull();
    expect(checkCommand(typed("Color"), "400,0,0")).not.toBeNull();
    expect(checkCommand(typed("Number"), "21 °C")).not.toBeNull();
    expect(checkCommand(typed("Contact"), "OPEN")).not.toBeNull();
    expect(checkCommand(typed("Group"), "OFF")).not.toBeNull();
    expect(checkCommand(typed("String"), "a\u0000b")).not.toBeNull();
    expect(checkCommand(typed("String"), "x".repeat(65))).not.toBeNull();
  });

  it("respects ranges and fixed lists", () => {
    const soll = typed("Number:Temperature", { min: 16, max: 26 });
    expect(checkCommand(soll, "26 °C")).toBeNull();
    expect(checkCommand(soll, "30 °C")).not.toBeNull();
    const modus = { read: true, commands: ["aus", "intern", "extern"] };
    expect(checkCommand(modus, "intern")).toBeNull();
    expect(checkCommand(modus, "panik")).not.toBeNull();
    expect(checkCommand({ read: true }, "ON")).not.toBeNull();
  });
});

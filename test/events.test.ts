import { describe, expect, it } from "vitest";
import { filterFrame, splitFrames } from "../src/events";

// Frames as openHAB 5.2 sends them (recorded from /rest/events)
const changed = 'event: message\n' +
  'data: {"topic":"openhab/items/Haus_Uhrzeit/statechanged",' +
  '"payload":"{\\"type\\":\\"DateTime\\",' +
  '\\"value\\":\\"2026-11-20T19:57:52+0100\\"}",' +
  '"type":"ItemStateChangedEvent"}';
const command = 'event: message\n' +
  'data: {"topic":"openhab/items/Haus_Uhrzeit/command",' +
  '"payload":"{}","type":"ItemCommandEvent"}';
const alive = 'event: alive\ndata: {"type":"ALIVE","interval":10}';
const list = { Haus_Uhrzeit: { read: true }, Geheim: { read: false } };

describe("event filter", () => {
  it("forwards state changes of readable items", () => {
    expect(filterFrame(changed, list)).toContain('"type":"ItemStateChangedEvent"');
  });
  it("drops other events and items", () => {
    expect(filterFrame(command, list)).toBeNull();
    expect(filterFrame(changed.replace(/Haus_Uhrzeit/g, "Geheim"), list)).toBeNull();
    expect(filterFrame(changed, list, new Set(["Anderes"]))).toBeNull();
  });
  it("turns ALIVE into a comment", () => {
    expect(filterFrame(alive, list)).toBe(": alive\n\n");
  });
  it("keeps incomplete frames for the next chunk", () => {
    const { frames, rest } = splitFrames(`${alive}\n\n${changed.slice(0, 30)}`);
    expect(frames).toEqual([alive]);
    expect(rest).toBe(changed.slice(0, 30));
  });
});

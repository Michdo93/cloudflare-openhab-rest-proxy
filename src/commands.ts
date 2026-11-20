import type { ItemRule } from "./types";

const NUMBER = /^-?\d{1,9}(\.\d{1,6})?$/;
const QUANTITY = /^(-?\d{1,9}(?:\.\d{1,6})?)\s?([^\d\s,;][^,;]{0,15})?$/;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

const WORDS: Record<string, string[]> = {
  Switch: ["ON", "OFF"],
  Dimmer: ["ON", "OFF", "INCREASE", "DECREASE"],
  Color: ["ON", "OFF", "INCREASE", "DECREASE"],
  Rollershutter: ["UP", "DOWN", "STOP", "MOVE"],
  Player: ["PLAY", "PAUSE", "NEXT", "PREVIOUS", "REWIND", "FASTFORWARD"]
};

/**
 * Checks a command against the rule of an item.
 * Returns null if it is allowed, otherwise the reason.
 */
export function checkCommand(
  rule: ItemRule, command: string, maxLength = 64
): string | null {
  if (!command) return "empty command";
  if (command.length > maxLength) return "command too long";
  if (/[\u0000-\u001f\u007f]/.test(command)) return "control characters";
  if (Array.isArray(rule.commands)) {
    return rule.commands.includes(command) ? null : "command not in list";
  }
  if (rule.commands !== "type" || !rule.type) return "item accepts no commands";
  return checkByType(rule, command);
}

function checkByType(rule: ItemRule, command: string): string | null {
  const base = rule.type!.split(":")[0];
  if (WORDS[base]?.includes(command)) return null;
  switch (base) {
    case "Dimmer":
    case "Rollershutter":
      return inRange(command, rule.min ?? 0, rule.max ?? 100);
    case "Color":
      return command.includes(",") ? checkHsb(command)
        : inRange(command, 0, 100);
    case "Number":
      return checkNumber(rule, command);
    case "String":
      return null;
    case "DateTime":
      return ISO_DATE.test(command) && !Number.isNaN(Date.parse(command))
        ? null : "not a date";
    case "Location":
      return checkLocation(command);
    default:
      return WORDS[base] ? `not a ${base} command`
        : `type ${base} accepts no commands`;
  }
}

function inRange(text: string, min: number, max: number): string | null {
  if (!NUMBER.test(text)) return "not a number";
  const value = Number(text);
  return value >= min && value <= max ? null : `outside ${min}..${max}`;
}

function checkNumber(rule: ItemRule, command: string): string | null {
  const match = QUANTITY.exec(command);
  if (!match) return "not a number";
  if (match[2] && !rule.type!.includes(":")) return "plain Number takes no unit";
  const value = Number(match[1]);
  if (rule.min !== undefined && value < rule.min) return `below ${rule.min}`;
  if (rule.max !== undefined && value > rule.max) return `above ${rule.max}`;
  return null;
}

function checkHsb(command: string): string | null {
  const parts = command.split(",");
  if (parts.length !== 3) return "HSB needs three values";
  const limits = [360, 100, 100];
  for (let i = 0; i < 3; i++) {
    if (inRange(parts[i].trim(), 0, limits[i]) !== null) return "invalid HSB value";
  }
  return null;
}

function checkLocation(command: string): string | null {
  const parts = command.split(",").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return "location needs lat,lon[,alt]";
  if (inRange(parts[0], -90, 90) || inRange(parts[1], -180, 180)) {
    return "invalid coordinates";
  }
  if (parts[2] !== undefined && !NUMBER.test(parts[2])) return "invalid altitude";
  return null;
}

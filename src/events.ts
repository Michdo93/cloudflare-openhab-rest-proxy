import type { Allowlist, Env, OpenHABEvent } from "./types";
import { restUrl, upstream } from "./upstream";

const TOPIC = /^openhab\/items\/([A-Za-z0-9_]+)(?:\/([A-Za-z0-9_]+))?\/statechanged$/;
const TYPES = ["ItemStateChangedEvent", "GroupItemStateChangedEvent"];

/** Decides whether an openHAB event may leave the proxy. */
export function allowEvent(
  event: unknown, allowlist: Allowlist, only?: Set<string>
): boolean {
  if (!event || typeof event !== "object") return false;
  const { topic, payload, type } = event as Partial<OpenHABEvent>;
  if (typeof topic !== "string" || typeof payload !== "string") return false;
  if (typeof type !== "string" || !TYPES.includes(type)) return false;
  const match = TOPIC.exec(topic);
  if (!match) return false;
  const names = match[2] ? [match[1], match[2]] : [match[1]];
  if (!names.every((name) => allowlist[name]?.read)) return false;
  return !only || only.has(match[1]);
}

/** Splits an SSE text buffer into complete frames and the rest. */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  return { frames: parts, rest };
}

/** Turns one frame from openHAB into the frame for the browser (or null). */
export function filterFrame(
  frame: string, allowlist: Allowlist, only?: Set<string>
): string | null {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if ((event as { type?: string })?.type === "ALIVE") return ": alive\n\n";
  if (!allowEvent(event, allowlist, only)) return null;
  const { topic, payload, type } = event as OpenHABEvent;
  return `event: message\ndata: ${JSON.stringify({ topic, payload, type })}\n\n`;
}

/**
 * Answers at once with an open stream and connects to openHAB in the
 * background. myopenHAB sends its headers only with the first event, so the
 * browser would otherwise wait – or run into a timeout.
 */
export function eventStream(
  request: Request, env: Env, allowlist: Allowlist,
  options: { only?: Set<string>; timeoutMs: number; heartbeatMs: number }
): { response: Response; done: Promise<void> } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const upstreamAbort = new AbortController();
  let open = true;

  const send = async (text: string) => {
    if (!open) return;
    try {
      await writer.write(encoder.encode(text));
    } catch {
      stop();                       // browser has gone away
    }
  };
  const stop = () => {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    upstreamAbort.abort();
    writer.close().catch(() => undefined);
  };
  const heartbeat = setInterval(() => void send(": ping\n\n"), options.heartbeatMs);
  request.signal?.addEventListener("abort", stop, { once: true });

  const done = (async () => {
    await send(": connected\nretry: 5000\n\n");
    try {
      const url = restUrl(env.OPENHAB_URL!, "events", {
        topics: "openhab/items/*/statechanged"
      });
      const response = await upstream(env, url, {
        headers: { Accept: "text/event-stream" },
        signal: upstreamAbort.signal
      }, options.timeoutMs);
      if (!response.ok || !response.body) {
        throw new Error(`openHAB answered ${response.status}`);
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (open) {
        const { value, done: end } = await reader.read();
        if (end) break;
        const { frames, rest } = splitFrames(buffer + value);
        buffer = rest;
        for (const frame of frames) {
          const out = filterFrame(frame, allowlist, options.only);
          if (out) await send(out);
        }
      }
      await send(`event: proxy-error\ndata: {"error":"stream ended"}\n\n`);
    } catch (error) {
      if (open) {
        console.error("event stream:", error);   // details only in the Worker log
        await send(`event: proxy-error\ndata: {"error":"upstream unavailable"}\n\n`);
      }
    } finally {
      stop();
    }
  })();

  const response = new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
  return { response, done };
}

// Stand-in for myopenHAB while developing: checks HTTP Basic like myopenHAB
// and – like openhab-cloud issue #258 – sends the headers of an event
// stream only together with the first event.
//
//   FAKE_USER=a@b.c FAKE_PASSWORD=geheim node tools/fake-myopenhab.mjs
//   -> http://localhost:8090 forwards to http://localhost:8080
import http from "node:http";

const target = new URL(process.env.FAKE_TARGET ?? "http://localhost:8080");
const port = Number(process.env.FAKE_PORT ?? 8090);
const expected = "Basic " + Buffer.from(
  `${process.env.FAKE_USER}:${process.env.FAKE_PASSWORD}`).toString("base64");

http.createServer((req, res) => {
  if (req.headers.authorization !== expected || !req.url.startsWith("/rest/")) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="myopenHAB"' }).end();
    return;
  }
  const headers = { ...req.headers, host: target.host };
  delete headers.authorization;               // the cloud keeps its own login
  const token = headers["x-openhab-token"];
  if (token) headers.authorization = `Bearer ${token}`;
  const out = http.request(new URL(req.url, target),
    { method: req.method, headers }, (answer) => {
      const stream = String(answer.headers["content-type"]).includes("event-stream");
      if (!stream) {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
        return;
      }
      let started = false;                    // headers with the first event only
      answer.on("data", (chunk) => {
        if (!started && !String(chunk).includes('"topic"')) return;
        if (!started) res.writeHead(answer.statusCode, answer.headers);
        started = true;
        res.write(chunk);
      });
      answer.on("end", () => res.end());
    });
  out.on("error", () => res.destroy());
  res.on("close", () => out.destroy());       // browser or Worker went away
  req.pipe(out);
}).listen(port, () => console.log(`fake myopenHAB on http://localhost:${port}`));

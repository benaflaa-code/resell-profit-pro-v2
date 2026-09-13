import { readFile } from "node:fs/promises";

const read = path => readFile(path, "utf8");
const [agent, worker, app, compose, example, html] = await Promise.all([
  read("agent/server.py"),
  read("worker/index.js"),
  read("dist/app.js"),
  read("docker-compose.yml"),
  read(".env.example"),
  read("dist/index.html")
]);

const required = [
  [agent, "secrets.compare_digest", "constant-time token comparison"],
  [agent, "TOKEN_CONFIGURED", "minimum token strength"],
  [agent, "response_peer_is_public", "peer-IP validation"],
  [agent, "follow_redirects=False", "manual redirect validation"],
  [agent, "MAX_RESPONSE_BYTES", "download limit"],
  [agent, "docs_url=None", "disabled API documentation"],
  [worker, "content-security-policy", "Content Security Policy"],
  [worker, "sameOriginRequest", "same-origin API check"],
  [worker, 'request.headers.get("cf-connecting-ip")', "non-spoofable rate-limit key"],
  [worker, "readSmallJson", "request-size limit"],
  [app, "sessionStorage, \"rpp2_agent_token\"", "tab-only token storage"],
  [app, 'url.protocol==="https:"', "HTTPS-only listing links"],
  [compose, '"127.0.0.1:8787:8787"', "localhost-only agent port"],
  [compose, "no-new-privileges:true", "container privilege restriction"],
  [example, "SEARXNG_SECRET=replace-with-a-different-long-random-value", "separate SearXNG secret"],
  [html, 'referrerpolicy="no-referrer"', "private remote-image referrer policy"]
];

for (const [source, marker, name] of required) {
  if (!source.includes(marker)) throw new Error(`Missing security control: ${name}`);
}

if (/localStorage\.setItem\(["']rpp2_agent_connection/.test(app)) {
  throw new Error("The agent token must not be persisted in localStorage");
}

const publicText = [agent, worker, app, compose, example, html].join("\n");
const forbidden = [
  [/\b33140\b/i, "private ZIP code"],
  [/https:\/\/[a-z]+(?:-[a-z]+){2,}\.trycloudflare\.com/i, "live Quick Tunnel address"],
  [/AGENT_TOKEN=[a-f0-9]{32,}/i, "real agent token"]
];
for (const [pattern, name] of forbidden) {
  if (pattern.test(publicText)) throw new Error(`Potential secret or private data detected: ${name}`);
}

console.log("Security invariants validated");

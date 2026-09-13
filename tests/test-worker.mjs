import assert from "node:assert/strict";
import worker from "../dist/server/index.js";

const call = (path, init = {}) => worker.fetch(new Request(`https://example.com${path}`, init), {}, {});

const home = await call("/");
assert.equal(home.status, 200);
assert.match(home.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
assert.equal(home.headers.get("x-frame-options"), "DENY");

const crossOrigin = await call("/api/market-health", { headers: { origin: "https://evil.example" } });
assert.equal(crossOrigin.status, 403);

const missingAgent = await call("/api/market-health");
assert.equal(missingAgent.status, 503);
assert.equal(missingAgent.headers.get("cache-control"), "no-store");

const oversized = await call("/api/market-lookup", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-rpp-agent-url": "https://example.trycloudflare.com",
    "x-rpp-agent-token": "test-token"
  },
  body: JSON.stringify({ product_name: "x".repeat(5000) })
});
assert.equal(oversized.status, 413);

for (let index = 0; index < 30; index += 1) {
  const response = await call("/api/not-a-route", { headers: { "cf-connecting-ip": "203.0.113.10" } });
  assert.equal(response.status, 404);
}
const limited = await call("/api/not-a-route", { headers: { "cf-connecting-ip": "203.0.113.10" } });
assert.equal(limited.status, 429);
assert.equal(limited.headers.get("retry-after"), "60");

console.log("Worker security behavior validated");

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-dns-prefetch-control": "off",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};
const RATE_BUCKETS = new Map();

const json = (value, status = 200, extraHeaders = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders }
});
const plain = (value, status) => new Response(value, { status, headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

function sameOriginRequest(request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return (!origin || origin === new URL(request.url).origin) && (!fetchSite || fetchSite === "same-origin" || fetchSite === "none");
}

function rateAllowed(request, limit = 30) {
  const now = Date.now();
  const key = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const recent = (RATE_BUCKETS.get(key) || []).filter(timestamp => now - timestamp < 60000);
  if (recent.length >= limit) return false;
  recent.push(now);
  RATE_BUCKETS.set(key, recent);
  if (RATE_BUCKETS.size > 500) {
    for (const [candidate, timestamps] of RATE_BUCKETS) {
      if (!timestamps.some(timestamp => now - timestamp < 60000)) RATE_BUCKETS.delete(candidate);
    }
  }
  return true;
}

async function readSmallJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 4096) throw new Error("request_too_large");
  if (!request.body) throw new Error("invalid_json");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let raw = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 4096) {
      await reader.cancel();
      throw new Error("request_too_large");
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  return JSON.parse(raw);
}

function safeAgentUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function browserAgentUrl(request) {
  const raw = request.headers.get("x-rpp-agent-url")?.trim().slice(0, 320);
  const url = safeAgentUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".trycloudflare.com") || url.username || url.password || (url.port && url.port !== "443")) return null;
  return new URL(url.origin);
}

function agentConnection(request, env) {
  const browserUrl = browserAgentUrl(request);
  const browserToken = request.headers.get("x-rpp-agent-token")?.trim().slice(0, 512);
  if (browserUrl && browserToken) return { url: browserUrl, token: browserToken, source: "browser" };
  const envUrl = safeAgentUrl(env.PRICE_AGENT_URL);
  return envUrl ? { url: envUrl, token: env.PRICE_AGENT_TOKEN || "", source: "deployment" } : null;
}

async function marketHealth(request, env) {
  const connection = agentConnection(request, env);
  if (!connection) return json({ configured: false, reachable: false }, 503);
  try {
    const response = await fetch(new URL("/health", connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(10000)
    });
    const payload = await response.json().catch(() => ({}));
    const authorized = response.ok && payload.status === "ok";
    return json({
      configured: true,
      reachable: response.ok || response.status === 401,
      authorized,
      model: payload.model || null,
      token_configured: Boolean(payload.token_configured),
      source: connection.source
    }, response.ok && authorized ? 200 : response.ok ? 401 : 502);
  } catch {
    return json({ configured: true, reachable: false, error: "agent_unavailable" }, 502);
  }
}

async function marketLookup(request, env) {
  const connection = agentConnection(request, env);
  if (!connection) return json({ error: "agent_not_configured" }, 503);

  let body;
  try { body = await readSmallJson(request); } catch (error) {
    const tooLarge = error?.message === "request_too_large";
    return json({ error: tooLarge ? "request_too_large" : "invalid_json", message: tooLarge ? "The request is too large." : "Invalid request." }, tooLarge ? 413 : 400);
  }
  const identifier = String(body?.identifier || "").trim().slice(0, 120);
  const productName = String(body?.product_name || "").trim().slice(0, 180);
  const referenceUrl = String(body?.reference_url || "").trim().slice(0, 1000);
  if (!identifier && !productName && !referenceUrl) return json({ error: "missing_query", message: "Enter a product identifier, name, or listing URL." }, 400);

  const endpoint = new URL("/lookup", connection.url);
  const headers = { "content-type": "application/json", "user-agent": "ResellProfitPro/2.2" };
  if (connection.token) headers.authorization = `Bearer ${connection.token}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ identifier, product_name: productName, reference_url: referenceUrl }),
      signal: AbortSignal.timeout(45000)
    });
    const payload = await response.json().catch(() => ({ error: "invalid_agent_response" }));
    if (!response.ok) {
      const message = response.status === 401 ? "The agent token was rejected. Reconnect the agent with the token from your local .env file." : payload.message || payload.detail || "The price agent returned an error.";
      return json({ error: payload.error || "agent_error", message }, response.status >= 400 && response.status < 600 ? response.status : 502);
    }
    return json(payload);
  } catch {
    return json({ error: "agent_unavailable", message: "The open-source market agent is unavailable right now." }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!sameOriginRequest(request)) return json({ error: "cross_origin_rejected" }, 403);
      if (!rateAllowed(request)) return json({ error: "rate_limited", message: "Too many requests. Wait a minute and try again." }, 429, { "retry-after": "60" });
    }
    if (url.pathname === "/api/market-lookup" && request.method === "POST") return marketLookup(request, env);
    if (url.pathname === "/api/market-health" && request.method === "GET") return marketHealth(request, env);
    if (request.method !== "GET" && request.method !== "HEAD") return plain("Method not allowed", 405);

    const asset = url.pathname === "/" ? [HTML, "text/html; charset=utf-8"]
      : url.pathname === "/styles.css" ? [CSS, "text/css; charset=utf-8"]
      : url.pathname === "/app.js" ? [APP_JS, "text/javascript; charset=utf-8"] : null;
    if (!asset) return plain("Not found", 404);
    return new Response(request.method === "HEAD" ? null : asset[0], {
      headers: { ...SECURITY_HEADERS, "content-type": asset[1], "cache-control": "no-cache" }
    });
  }
};

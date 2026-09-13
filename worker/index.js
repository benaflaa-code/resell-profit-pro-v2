const json = (value, status = 200, extraHeaders = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders }
});

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
    const response = await fetch(new URL("/health", connection.url), { signal: AbortSignal.timeout(10000) });
    const payload = await response.json().catch(() => ({}));
    let authorized = false;
    if (response.ok && connection.token) {
      const authResponse = await fetch(new URL("/lookup", connection.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
        body: JSON.stringify({ identifier: "", product_name: "" }),
        signal: AbortSignal.timeout(10000)
      });
      authorized = authResponse.status === 400;
    }
    return json({
      configured: true,
      reachable: response.ok && payload.status === "ok",
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
  try { body = await request.json(); } catch { return json({ error: "invalid_json", message: "Invalid request." }, 400); }
  const identifier = String(body?.identifier || "").trim().slice(0, 120);
  const productName = String(body?.product_name || "").trim().slice(0, 180);
  if (!identifier && !productName) return json({ error: "missing_query", message: "Enter a product identifier or name." }, 400);

  const endpoint = new URL("/lookup", connection.url);
  const headers = { "content-type": "application/json", "user-agent": "ResellProfitPro/2.1" };
  if (connection.token) headers.authorization = `Bearer ${connection.token}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ identifier, product_name: productName }),
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
    if (url.pathname === "/api/market-lookup" && request.method === "POST") return marketLookup(request, env);
    if (url.pathname === "/api/market-health" && request.method === "GET") return marketHealth(request, env);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    const asset = url.pathname === "/" ? [HTML, "text/html; charset=utf-8"]
      : url.pathname === "/styles.css" ? [CSS, "text/css; charset=utf-8"]
      : url.pathname === "/app.js" ? [APP_JS, "text/javascript; charset=utf-8"] : null;
    if (!asset) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : asset[0], {
      headers: { "content-type": asset[1], "cache-control": "no-cache" }
    });
  }
};

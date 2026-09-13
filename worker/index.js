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

async function marketLookup(request, env) {
  const agentUrl = safeAgentUrl(env.PRICE_AGENT_URL);
  if (!agentUrl) return json({ error: "agent_not_configured" }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json", message: "Invalid request." }, 400); }
  const identifier = String(body?.identifier || "").trim().slice(0, 120);
  const productName = String(body?.product_name || "").trim().slice(0, 180);
  if (!identifier && !productName) return json({ error: "missing_query", message: "Enter a product identifier or name." }, 400);

  const endpoint = new URL("/lookup", agentUrl);
  const headers = { "content-type": "application/json", "user-agent": "ResellProfitPro/2.1" };
  if (env.PRICE_AGENT_TOKEN) headers.authorization = `Bearer ${env.PRICE_AGENT_TOKEN}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ identifier, product_name: productName }),
      signal: AbortSignal.timeout(45000)
    });
    const payload = await response.json().catch(() => ({ error: "invalid_agent_response" }));
    if (!response.ok) return json({ error: payload.error || "agent_error", message: payload.message || "The price agent returned an error." }, response.status >= 400 && response.status < 600 ? response.status : 502);
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
    if (url.pathname === "/api/market-health") return json({ configured: Boolean(safeAgentUrl(env.PRICE_AGENT_URL)) });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    const asset = url.pathname === "/" ? [HTML, "text/html; charset=utf-8"]
      : url.pathname === "/styles.css" ? [CSS, "text/css; charset=utf-8"]
      : url.pathname === "/app.js" ? [APP_JS, "text/javascript; charset=utf-8"] : null;
    if (!asset) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : asset[0], {
      headers: { "content-type": asset[1], "cache-control": url.pathname === "/" ? "no-cache" : "public, max-age=3600" }
    });
  }
};

# Resell Profit Pro v2

An open-source, decision-first resale profitability calculator designed for sourcing small products and offering free shipping to U.S. buyers.

## Live app

https://resell-profit-pro-v2.amineben.chatgpt.site

## Included

- Maximum safe buying price using profit, margin, and ROI guardrails
- Five-marketplace comparison with editable planning assumptions
- Conservative, expected, and optimistic outcomes
- Seller-paid U.S. shipping estimate
- One-click exact-offer and specification-matched alternative comparison
- Separate retail and wholesale comparisons with unit price, pack size, MOQ, and minimum order cost
- Automatic quarantine of extreme price anomalies so they cannot distort the usable market range
- Conservative sale history that accepts only public records explicitly marked sold, completed, or ended
- Optional retailer URL input for more precise product and specification extraction
- Refreshable market snapshots from a self-hosted open-source price agent
- Browser-persistent Product Idea Book
- Actual-versus-forecast post-sale review
- Responsive, accessible single-page interface

## Data and pricing

Ideas and fee settings are stored in the browser using local storage. The private market-agent token is stored only in browser session storage and is removed when that browser session ends. Marketplace fees and shipping amounts are estimates and must be checked before purchasing inventory. When the optional market agent is connected, the entered product identifier and name are sent to that self-hosted service to retrieve current public listings. The app labels asking prices separately from verified sales and never invents sold history.

## Open-source market agent

The included Docker setup runs three local services:

- SearXNG for metasearch
- Ollama with `qwen3:4b` for match validation and description cleanup
- A small FastAPI service that extracts public listing prices and returns structured sources

1. Install Docker Desktop.
2. Copy `.env.example` to `.env`. Replace both examples with different random values of at least 32 characters; never commit `.env`.
3. Run `docker compose up -d --build`.
4. Verify `http://127.0.0.1:8787/health` using the `AGENT_TOKEN` value as a Bearer authorization header.
5. Place the agent behind an authenticated HTTPS endpoint. Do not expose Ollama or SearXNG directly. For a temporary test, a Cloudflare Quick Tunnel can point to `http://host.docker.internal:8787`.
6. In the live app, open **Settings**, paste the HTTPS tunnel address and private agent token, then select **Test connection**. The address remains in that browser, while the token lasts only for the current browser session. Neither is added to public source code.

For an always-on deployment, site administrators can instead configure private `PRICE_AGENT_URL` and `PRICE_AGENT_TOKEN` runtime variables. Quick Tunnel addresses change when the tunnel restarts and are intended for testing.

The hosted app remains usable without the agent: manual marketplace links and comparable-sale entry continue to work. Public sites can restrict or block automated access, so every result includes its source and must be checked before buying.

The agent requires an exact normalized UPC, ASIN, or model-number match whenever an identifier is entered. It returns “No exact match” instead of pricing a semantically similar but unrelated result. Product-name-only searches must pass a strict word-overlap check before Ollama summarizes the surviving listings.

Market refresh keeps exact-product offers separate from alternative products. It extracts published specifications such as pressure, voltage, airflow, battery capacity, power source, auto-stop, and LED lighting when available, then labels alternatives with a specification-match score and the measurable differences. Alternative prices never enter the exact-product low, median, high, or conservative price.

Retail asking prices and wholesale sourcing quotes are also kept separate. Pack prices are converted to a unit basis, while a wholesale MOQ is used to show the minimum merchandise commitment instead of being mistaken for a pack quantity. A large multiplicative price gap is disclosed under **Excluded price anomalies** and does not affect retail statistics. Wholesale prices may still exclude freight, duties, taxes, samples, and negotiation.

## Security

The market agent uses constant-time bearer-token authentication, authenticated health checks, request and concurrency limits, private-address and redirect blocking, peer-IP verification, download-size limits, disabled API documentation, and container privilege restrictions. The hosted Worker adds same-origin checks, API throttling, body-size limits, restrictive browser security headers, and no-store API responses.

The hosted app should remain owner-only while it accepts a browser-provided Quick Tunnel address. Stop the Quick Tunnel when market lookup is not needed. See [SECURITY.md](SECURITY.md) for private vulnerability reporting and the operating boundaries.

## Run locally

Open `dist/index.html` directly for the calculator-only version. The live market-refresh route requires the Worker build plus the self-hosted agent described above.

## License

MIT

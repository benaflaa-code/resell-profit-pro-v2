# Resell Profit Pro v2

An open-source, decision-first resale profitability calculator designed for sourcing small products and offering free shipping to U.S. buyers.

## Live app

https://resell-profit-pro-v2.amineben.chatgpt.site

## Included

- Maximum safe buying price using profit, margin, and ROI guardrails
- Six-marketplace comparison with editable planning assumptions
- Conservative, expected, and optimistic outcomes
- Seller-paid U.S. shipping estimate
- Product research links and manually verified comparable sales
- Refreshable market snapshots from a self-hosted open-source price agent
- Browser-persistent Product Idea Book
- Actual-versus-forecast post-sale review
- Responsive, accessible single-page interface

## Data and pricing

Ideas and fee settings are stored in the browser using local storage. Marketplace fees and shipping amounts are estimates and must be checked before purchasing inventory. When the optional market agent is connected, the entered product identifier and name are sent to that self-hosted service to retrieve current public listings. The app labels asking prices separately from verified sales and never invents sold history.

## Open-source market agent

The included Docker setup runs three local services:

- SearXNG for metasearch
- Ollama with `qwen3:4b` for match validation and description cleanup
- A small FastAPI service that extracts public listing prices and returns structured sources

1. Install Docker Desktop.
2. Copy `.env.example` to `.env` and replace the example token with a long random value.
3. Run `docker compose up -d --build`.
4. Verify the local service at `http://127.0.0.1:8787/health`.
5. Place the agent behind an authenticated HTTPS endpoint. Do not expose Ollama or SearXNG directly.
6. Configure the hosted app's private `PRICE_AGENT_URL` and `PRICE_AGENT_TOKEN` environment variables.

The hosted app remains usable without the agent: manual marketplace links and comparable-sale entry continue to work. Public sites can restrict or block automated access, so every result includes its source and must be checked before buying.

## Run locally

Open `dist/index.html` directly for the calculator-only version. The live market-refresh route requires the Worker build plus the self-hosted agent described above.

## License

MIT

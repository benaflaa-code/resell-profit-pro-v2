# Security policy

## Supported version

Security fixes are applied to the current `main` branch. Use the newest published release and rebuild the local market agent after security updates.

## Reporting a vulnerability

Do not publish a working exploit, private tunnel address, token, or personal information in a public issue. Report vulnerabilities privately through GitHub's **Report a vulnerability** security-advisory feature when it is available for this repository.

If private reporting is unavailable, open a public issue containing only a short, non-sensitive request for a private contact channel. Rotate any credential that may have been disclosed.

## Trust boundaries

- The GitHub source is public; `.env` and real credentials must remain local.
- The hosted app is intended to remain owner-only while it accepts a browser-provided Quick Tunnel address.
- Only the FastAPI market agent may be exposed through the tunnel. Never expose SearXNG, Ollama, Docker Desktop, or other Windows services.
- Marketplace pages and search results are untrusted. Results are decision support, not guaranteed prices or verified inventory.

## Local operational requirements

- Use different random values for `AGENT_TOKEN` and `SEARXNG_SECRET`.
- Rotate `AGENT_TOKEN` after accidental disclosure.
- Keep Docker Desktop, Windows, the browser, and container images updated.
- Stop the Cloudflare Quick Tunnel when live market lookup is not needed.

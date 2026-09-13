import asyncio
import ipaddress
import json
import os
import re
import socket
from datetime import datetime, timezone
from statistics import median
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Resell Profit Pro Market Agent", version="1.0.0")

SEARXNG_URL = os.getenv("SEARXNG_URL", "http://searxng:8080").rstrip("/")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:4b")
AGENT_TOKEN = os.getenv("AGENT_TOKEN", "")
MAX_RESULTS = min(10, max(3, int(os.getenv("MAX_RESULTS", "7"))))
PRICE_RE = re.compile(r"(?:US\s*)?\$\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{2})?)")


class LookupRequest(BaseModel):
    identifier: str = Field(default="", max_length=120)
    product_name: str = Field(default="", max_length=180)


def identifier_type(value: str) -> str:
    compact = re.sub(r"[\s-]", "", value).upper()
    if compact.isdigit() and len(compact) in {8, 12, 13, 14}:
        return "UPC"
    if re.fullmatch(r"[A-Z0-9]{10}", compact) and any(ch.isalpha() for ch in compact):
        return "ASIN"
    return "MODEL" if compact else "NAME"


def authorized(header: str | None) -> bool:
    return bool(AGENT_TOKEN) and header == f"Bearer {AGENT_TOKEN}"


def public_web_url(raw: str) -> bool:
    try:
        parsed = urlparse(raw)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        if parsed.hostname in {"localhost", "localhost.localdomain"}:
            return False
        try:
            address = ipaddress.ip_address(socket.gethostbyname(parsed.hostname))
            return not (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved)
        except (ValueError, OSError):
            return False
    except ValueError:
        return False


def first_price(text: str) -> float | None:
    match = PRICE_RE.search(text or "")
    if not match:
        return None
    value = float(match.group(1).replace(",", ""))
    return value if 0.5 <= value <= 100000 else None


def jsonld_products(value):
    if isinstance(value, list):
        for item in value:
            yield from jsonld_products(item)
    elif isinstance(value, dict):
        kind = value.get("@type")
        if kind == "Product" or (isinstance(kind, list) and "Product" in kind):
            yield value
        for key in ("@graph", "mainEntity", "itemListElement"):
            if key in value:
                yield from jsonld_products(value[key])


def offer_price(offers) -> float | None:
    if isinstance(offers, list):
        values = [offer_price(x) for x in offers]
        values = [x for x in values if x is not None]
        return min(values) if values else None
    if not isinstance(offers, dict):
        return None
    for key in ("price", "lowPrice", "highPrice"):
        try:
            value = float(str(offers.get(key, "")).replace(",", ""))
            if 0.5 <= value <= 100000:
                return value
        except ValueError:
            pass
    return None


async def inspect_result(client: httpx.AsyncClient, result: dict, identifier: str) -> dict | None:
    url = str(result.get("url") or "")
    if not public_web_url(url):
        return None
    title = str(result.get("title") or "").strip()
    snippet = str(result.get("content") or "").strip()
    price = first_price(f"{title} {snippet}")
    image = None
    description = snippet
    try:
        response = await client.get(url, follow_redirects=True)
        if response.status_code < 400 and "text/html" in response.headers.get("content-type", ""):
            soup = BeautifulSoup(response.text[:900000], "html.parser")
            meta_title = soup.select_one('meta[property="og:title"]')
            meta_description = soup.select_one('meta[property="og:description"], meta[name="description"]')
            meta_image = soup.select_one('meta[property="og:image"]')
            if meta_title and meta_title.get("content"):
                title = meta_title["content"].strip()
            if meta_description and meta_description.get("content"):
                description = meta_description["content"].strip()
            if meta_image and meta_image.get("content"):
                image = meta_image["content"].strip()
            for script in soup.select('script[type="application/ld+json"]'):
                try:
                    data = json.loads(script.string or "")
                    for product in jsonld_products(data):
                        title = str(product.get("name") or title).strip()
                        description = str(product.get("description") or description).strip()
                        candidate_image = product.get("image")
                        if isinstance(candidate_image, list):
                            candidate_image = candidate_image[0] if candidate_image else None
                        if isinstance(candidate_image, dict):
                            candidate_image = candidate_image.get("url")
                        image = str(candidate_image or image or "").strip() or None
                        price = offer_price(product.get("offers")) or price
                        break
                except (json.JSONDecodeError, TypeError):
                    continue
    except (httpx.HTTPError, UnicodeError):
        pass
    if price is None:
        return None
    identifier_match = bool(identifier and identifier.lower().replace("-", "") in f"{title} {snippet}".lower().replace("-", ""))
    return {
        "title": title[:220] or urlparse(url).netloc,
        "description": description[:420],
        "url": url,
        "source": urlparse(url).netloc.removeprefix("www."),
        "price": round(price, 2),
        "total_price": round(price, 2),
        "shipping_included": False,
        "image_url": image,
        "identifier_match": identifier_match,
    }


async def ollama_summary(query: str, listings: list[dict]) -> dict | None:
    if not listings:
        return None
    compact = [{"title": x["title"], "description": x["description"], "source": x["source"], "price": x["price"], "identifier_match": x["identifier_match"]} for x in listings]
    prompt = (
        "You validate resale product matches. Based only on the JSON listings, return strict JSON with "
        'keys title, description, match_confidence (0-100). Do not invent specifications or prices. '
        f"Target: {query}\nListings: {json.dumps(compact)}"
    )
    try:
        async with httpx.AsyncClient(timeout=18) as client:
            response = await client.post(f"{OLLAMA_URL}/api/chat", json={
                "model": OLLAMA_MODEL,
                "stream": False,
                "format": "json",
                "messages": [{"role": "user", "content": prompt}],
                "options": {"temperature": 0}
            })
            response.raise_for_status()
            content = response.json().get("message", {}).get("content", "{}")
            parsed = json.loads(content)
            return {
                "title": str(parsed.get("title") or "")[:220],
                "description": str(parsed.get("description") or "")[:420],
                "match_confidence": max(0, min(100, int(parsed.get("match_confidence") or 0)))
            }
    except (httpx.HTTPError, json.JSONDecodeError, TypeError, ValueError):
        return None


@app.get("/health")
async def health():
    return {"status": "ok", "model": OLLAMA_MODEL, "token_configured": bool(AGENT_TOKEN)}


@app.post("/lookup")
async def lookup(body: LookupRequest, authorization: str | None = Header(default=None)):
    if not authorized(authorization):
        raise HTTPException(status_code=401, detail="Unauthorized")
    identifier = body.identifier.strip()
    product_name = body.product_name.strip()
    if not identifier and not product_name:
        raise HTTPException(status_code=400, detail="A product identifier or name is required")
    query = " ".join(x for x in (identifier, product_name, "price") if x)

    async with httpx.AsyncClient(timeout=10, headers={"user-agent": "Mozilla/5.0 ResellProfitPro/2.1"}) as client:
        try:
            search = await client.get(f"{SEARXNG_URL}/search", params={"q": query, "format": "json", "language": "en-US", "safesearch": 1})
            search.raise_for_status()
            raw_results = search.json().get("results", [])[:MAX_RESULTS]
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=502, detail="Search service unavailable") from exc
        inspected = await asyncio.gather(*(inspect_result(client, item, identifier) for item in raw_results))

    listings = [item for item in inspected if item]
    exact = [item for item in listings if item["identifier_match"]]
    if exact:
        listings = exact
    listings.sort(key=lambda item: item["price"])
    values = [item["price"] for item in listings]
    q1_index = max(0, round((len(values) - 1) * 0.25)) if values else 0
    summary = await ollama_summary(query, listings)
    lead = listings[0] if listings else {}
    confidence = summary["match_confidence"] if summary else (88 if exact else 58 if listings else 0)
    return {
        "identifier_type": identifier_type(identifier),
        "query": query,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "match_confidence": confidence,
        "product": {
            "title": (summary or {}).get("title") or lead.get("title") or product_name or identifier,
            "description": (summary or {}).get("description") or lead.get("description") or "",
            "image_url": lead.get("image_url")
        },
        "prices": {
            "low": values[0] if values else None,
            "median": round(median(values), 2) if values else None,
            "high": values[-1] if values else None,
            "conservative": values[q1_index] if values else None,
            "currency": "USD"
        },
        "listings": listings,
        "sold_history_available": False,
        "sold_history": [],
        "warnings": ["Shipping is included only when the source explicitly reports it.", "Asking prices are not completed sales."]
    }

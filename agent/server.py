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
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

AGENT_VERSION = "1.3.0"
app = FastAPI(title="Resell Profit Pro Market Agent", version=AGENT_VERSION)

SEARXNG_URL = os.getenv("SEARXNG_URL", "http://searxng:8080").rstrip("/")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:4b")
AGENT_TOKEN = os.getenv("AGENT_TOKEN", "")
MAX_RESULTS = min(10, max(3, int(os.getenv("MAX_RESULTS", "7"))))
PRICE_RE = re.compile(r"(?:US\s*)?\$\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{2})?)")
WORD_RE = re.compile(r"[a-z0-9]+")
NAME_STOPWORDS = {"a", "an", "and", "at", "by", "for", "from", "in", "new", "of", "on", "or", "price", "sale", "the", "to", "with"}
WHOLESALE_DOMAINS = ("alibaba.com", "dhgate.com", "made-in-china.com", "globalsources.com")
SOLD_EVIDENCE_RE = re.compile(r"\b(?:sold(?!\s+by\b)|completed(?:\s+listing)?|listing\s+ended|ended\s+listing)\b", re.I)
PACK_PATTERNS = (
    re.compile(r"\bpack\s+of\s+(\d{1,4})\b", re.I),
    re.compile(r"\b(\d{1,4})[ -]pack\b", re.I),
    re.compile(r"\b(?:lot|set|case)\s+of\s+(\d{1,4})\b", re.I),
)
MOQ_PATTERNS = (
    re.compile(r"\bMOQ\s*[:=-]?\s*(\d{1,6})\b", re.I),
    re.compile(r"\bminimum\s+(?:order(?:\s+quantity)?|purchase)\s*[:=-]?\s*(\d{1,6})\b", re.I),
    re.compile(r"\b(\d{1,6})\s*(?:pieces?|pcs?|units?)\s+(?:minimum|min\.?\s*order)\b", re.I),
)
SPEC_PATTERNS = (
    ("Max pressure", re.compile(r"\b(\d{2,3})\s*PSI\b", re.I), " PSI"),
    ("Voltage", re.compile(r"\b(\d{1,3}(?:\.\d+)?)\s*V(?:OLT(?:S)?)?\b", re.I), " V"),
    ("Airflow", re.compile(r"\b(\d{1,3}(?:\.\d+)?)\s*L\s*/\s*MIN\b", re.I), " L/min"),
    ("Battery", re.compile(r"\b(\d{3,6})\s*MAH\b", re.I), " mAh"),
    ("Power", re.compile(r"\b(\d{1,5})\s*W(?:ATT(?:S)?)?\b", re.I), " W"),
    ("Capacity", re.compile(r"\b(\d+(?:\.\d+)?)\s*(GB|TB|ML|L)\b(?!\s*/)", re.I), None),
)


class LookupRequest(BaseModel):
    identifier: str = Field(default="", max_length=120)
    product_name: str = Field(default="", max_length=180)
    reference_url: str = Field(default="", max_length=1000)


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


def compact_identifier(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def contains_identifier(identifier: str, text: str) -> bool:
    target = compact_identifier(identifier)
    return bool(target and target in compact_identifier(text))


def product_name_score(product_name: str, text: str) -> float:
    target_tokens = [token for token in WORD_RE.findall(product_name.lower()) if token not in NAME_STOPWORDS]
    if not target_tokens:
        return 0.0
    candidate_tokens = set(WORD_RE.findall(text.lower()))
    matches = sum(1 for token in set(target_tokens) if token in candidate_tokens)
    return matches / len(set(target_tokens))


def reliable_name_match(product_name: str, text: str) -> bool:
    target_count = len({token for token in WORD_RE.findall(product_name.lower()) if token not in NAME_STOPWORDS})
    if target_count == 0:
        return False
    threshold = 1.0 if target_count == 1 else 0.66 if target_count <= 3 else 0.5
    return product_name_score(product_name, text) >= threshold


def fallback_category(value: str) -> str:
    lowered = (value or "").lower()
    known_categories = (
        "portable tire inflator", "tire inflator", "air compressor", "portable charger",
        "wireless headphones", "bluetooth speaker", "phone mount", "security camera",
        "robot vacuum", "coffee maker", "gaming mouse", "mechanical keyboard",
    )
    for category in known_categories:
        if category in lowered:
            return category
    tokens = [token for token in WORD_RE.findall(lowered) if token not in NAME_STOPWORDS and not any(ch.isdigit() for ch in token)]
    return " ".join(tokens[-4:])[:90]


def extract_specs(text: str) -> dict[str, str]:
    specs: dict[str, str] = {}
    for label, pattern, suffix in SPEC_PATTERNS:
        match = pattern.search(text or "")
        if not match:
            continue
        if suffix is None:
            specs[label] = f"{match.group(1)} {match.group(2).upper()}"
        else:
            specs[label] = f"{match.group(1)}{suffix}"
    lowered = (text or "").lower()
    if "Battery" not in specs and ("power bank" in lowered or "battery pack" in lowered):
        shorthand = re.search(r"\b(\d{1,3})\s*k\b", lowered)
        if shorthand:
            specs["Battery"] = f"{int(shorthand.group(1)) * 1000} mAh"
    if "rechargeable" in lowered or "cordless" in lowered:
        specs["Power source"] = "Rechargeable battery"
    elif re.search(r"\b12\s*v(?:olt)?\s*dc\b", lowered) or "cigarette lighter" in lowered or "corded" in lowered:
        specs["Power source"] = "12 V DC / corded"
    if re.search(r"\bauto(?:matic)?\s+(?:shut[- ]?off|stop)\b", lowered):
        specs["Auto stop"] = "Yes"
    if "led light" in lowered or "led flashlight" in lowered:
        specs["LED light"] = "Yes"
    return dict(list(specs.items())[:8])


def offer_details(url: str, text: str, price: float) -> dict:
    host = (urlparse(url).hostname or "").lower()
    wholesale = any(host == domain or host.endswith(f".{domain}") for domain in WHOLESALE_DOMAINS)
    alibaba = host == "alibaba.com" or host.endswith(".alibaba.com")
    pack_quantity = 1
    for pattern in PACK_PATTERNS:
        match = pattern.search(text or "")
        if match:
            pack_quantity = max(1, int(match.group(1)))
            break
    minimum_order_quantity = 1
    for pattern in MOQ_PATTERNS:
        match = pattern.search(text or "")
        if match:
            minimum_order_quantity = max(1, int(match.group(1)))
            break
    per_unit = bool(re.search(r"(?:/|\bper\s+)(?:piece|pc|unit|item)\b|\beach\b", text or "", re.I))
    unit_price = price if per_unit or pack_quantity == 1 else price / pack_quantity
    price_basis = "per unit" if per_unit else (f"pack of {pack_quantity}" if pack_quantity > 1 else "listed item")
    return {
        "offer_type": "wholesale" if wholesale else "retail",
        "pack_quantity": pack_quantity,
        "minimum_order_quantity": minimum_order_quantity,
        "unit_price": round(unit_price, 2),
        "minimum_order_cost": round(unit_price * minimum_order_quantity, 2),
        "price_basis": price_basis,
        "supplier_verified": bool(re.search(r"\bverified\s+supplier\b", text or "", re.I)) if alibaba else None,
    }


def filter_price_outliers(listings: list[dict]) -> tuple[list[dict], list[dict]]:
    """Keep a coherent low-price cluster and disclose extreme high-price records."""
    if len(listings) < 2:
        return listings[:], []
    ordered = sorted(listings, key=lambda item: float(item.get("unit_price") or item.get("price") or 0))
    values = [float(item.get("unit_price") or item.get("price") or 0) for item in ordered]
    split_at = None
    largest_ratio = 1.0
    for index in range(len(values) - 1):
        if values[index] <= 0:
            continue
        ratio = values[index + 1] / values[index]
        if ratio >= 4.0 and ratio > largest_ratio:
            largest_ratio = ratio
            split_at = index + 1
    if split_at is None:
        return ordered, []
    kept = ordered[:split_at]
    excluded = ordered[split_at:]
    anchor = median([float(item.get("unit_price") or item["price"]) for item in kept])
    for item in excluded:
        item["outlier_reason"] = f"Unit price is more than {largest_ratio:.1f}× above the nearest coherent offer cluster (around ${anchor:.2f})."
    return kept, excluded


def clean_specifications(value) -> list[dict[str, str]]:
    if isinstance(value, dict):
        value = [{"label": key, "value": item} for key, item in value.items()]
    if not isinstance(value, list):
        return []
    cleaned = []
    for item in value[:8]:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or item.get("key") or "").strip()[:50]
        spec_value = str(item.get("value") or "").strip()[:80]
        if label and spec_value:
            cleaned.append({"label": label, "value": spec_value})
    return cleaned


def spec_dict(value: list[dict[str, str]]) -> dict[str, str]:
    return {item["label"]: item["value"] for item in value if item.get("label") and item.get("value")}


def numeric_spec(value: str) -> float | None:
    match = re.search(r"\d+(?:\.\d+)?", value or "")
    return float(match.group()) if match else None


def compare_specs(reference: dict[str, str], candidate: dict[str, str], name_score: float) -> tuple[int, list[str]]:
    shared = sorted(set(reference) & set(candidate))
    matches = 0
    differences = []
    for label in shared:
        reference_value = reference[label]
        candidate_value = candidate[label]
        reference_number = numeric_spec(reference_value)
        candidate_number = numeric_spec(candidate_value)
        if reference_number is not None and candidate_number is not None:
            tolerance = max(abs(reference_number), 1) * 0.08
            same = abs(reference_number - candidate_number) <= tolerance
        else:
            same = reference_value.lower() == candidate_value.lower()
        if same:
            matches += 1
        else:
            differences.append(f"{label}: {candidate_value} vs {reference_value}")
    spec_score = matches / len(shared) if shared else 0
    similarity = round(name_score * 55 + spec_score * 40 + min(len(shared), 3) * 2)
    return max(0, min(95, similarity)), differences[:4]


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


async def inspect_result(client: httpx.AsyncClient, result: dict, identifier: str, product_name: str) -> dict | None:
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
    evidence = f"{title} {snippet} {description} {url}"
    identifier_match = contains_identifier(identifier, evidence)
    name_score = product_name_score(product_name, evidence) if product_name else 0.0
    details = offer_details(url, evidence, price)
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
        "name_match_score": round(name_score, 3),
        "specifications": extract_specs(evidence),
        "sold_evidence": bool(SOLD_EVIDENCE_RE.search(f"{title} {snippet}")),
        **details,
    }


async def ollama_summary(query: str, listings: list[dict]) -> dict | None:
    if not listings:
        return None
    compact = [{"title": x["title"], "description": x["description"], "source": x["source"], "price": x["price"], "identifier_match": x["identifier_match"], "name_match_score": x["name_match_score"], "specifications": x["specifications"]} for x in listings]
    prompt = (
        "You validate resale product matches. Every listing has already passed deterministic identity checks. Based only on the JSON listings, return strict JSON with "
        "keys title, description, match_confidence (0-100), category, comparison_search, and specifications. "
        "Specifications must be an array of up to 8 objects with label and value, using only facts stated in the listings. "
        "comparison_search must describe the generic product type and its important specifications without a store name, price, brand, or model number. "
        "Do not invent specifications or prices. "
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
                "match_confidence": max(0, min(100, int(parsed.get("match_confidence") or 0))),
                "category": str(parsed.get("category") or "")[:90],
                "comparison_search": str(parsed.get("comparison_search") or "")[:180],
                "specifications": clean_specifications(parsed.get("specifications")),
            }
    except (httpx.HTTPError, json.JSONDecodeError, TypeError, ValueError):
        return None


@app.get("/health")
async def health():
    return {"status": "ok", "model": OLLAMA_MODEL, "agent_version": AGENT_VERSION, "token_configured": bool(AGENT_TOKEN)}


@app.post("/lookup")
async def lookup(body: LookupRequest, authorization: str | None = Header(default=None)):
    if not authorized(authorization):
        raise HTTPException(status_code=401, detail="Unauthorized")
    identifier = body.identifier.strip()
    product_name = body.product_name.strip()
    reference_url = body.reference_url.strip()
    if not identifier and not product_name and not reference_url:
        raise HTTPException(status_code=400, detail="A product identifier, name, or listing URL is required")
    if reference_url and not public_web_url(reference_url):
        raise HTTPException(status_code=400, detail="The product listing URL must be a public HTTP or HTTPS page")

    async with httpx.AsyncClient(timeout=10, headers={"user-agent": "Mozilla/5.0 ResellProfitPro/2.1"}) as client:
        reference_listing = await inspect_result(client, {"url": reference_url}, identifier, product_name) if reference_url else None
        search_name = product_name or (reference_listing or {}).get("title", "")
        query = " ".join(x for x in ((f'"{identifier}"' if identifier else ""), search_name, "price") if x)
        try:
            search = await client.get(f"{SEARXNG_URL}/search", params={"q": query, "format": "json", "language": "en-US", "safesearch": 1})
            search.raise_for_status()
            raw_results = search.json().get("results", [])[:MAX_RESULTS * 2]
            if search_name:
                supplier_search = await client.get(f"{SEARXNG_URL}/search", params={"q": f'(site:alibaba.com "verified supplier" OR site:dhgate.com) "{search_name}" price MOQ', "format": "json", "language": "en-US", "safesearch": 1})
                if supplier_search.status_code < 400:
                    raw_results += supplier_search.json().get("results", [])[:MAX_RESULTS]
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=502, detail="Search service unavailable") from exc
        inspected = await asyncio.gather(*(inspect_result(client, item, identifier, search_name) for item in raw_results))

        listings = [item for item in ([reference_listing] + list(inspected)) if item]
        unique_listings = []
        seen_urls = set()
        for item in listings:
            normalized_url = item["url"].split("?", 1)[0].rstrip("/")
            if normalized_url not in seen_urls:
                seen_urls.add(normalized_url)
                unique_listings.append(item)
        listings = unique_listings
        exact = [item for item in listings if item["identifier_match"]]
        if reference_listing and reference_listing not in exact and (not search_name or reliable_name_match(search_name, f'{reference_listing["title"]} {reference_listing["description"]}')):
            exact.insert(0, reference_listing)
        if identifier:
            if not exact:
                return JSONResponse(status_code=422, content={
                    "error": "no_exact_match",
                    "message": f'No reliable listing contained the exact {identifier_type(identifier).lower()} “{identifier}”. Add the product name or a direct product URL.'
                })
            listings = exact
        elif search_name:
            listings = [item for item in listings if reliable_name_match(search_name, f'{item["title"]} {item["description"]}')]
            if not listings:
                return JSONResponse(status_code=422, content={
                    "error": "no_exact_match",
                    "message": "No reliable listing matched enough of the product name. Add a UPC, ASIN, model number, or direct product URL."
                })
        listings = listings[:MAX_RESULTS]

        summary = await ollama_summary(query, listings)
        lead = reference_listing or (listings[0] if listings else {})
        reference_specs = dict(lead.get("specifications") or {})
        for listing in listings:
            for label, value in listing.get("specifications", {}).items():
                reference_specs.setdefault(label, value)
        for item in (summary or {}).get("specifications", []):
            reference_specs.setdefault(item["label"], item["value"])
        category = (summary or {}).get("category") or fallback_category(search_name)
        comparison_query = (summary or {}).get("comparison_search") or category
        alternatives = []
        if comparison_query:
            try:
                comparison_search = await client.get(f"{SEARXNG_URL}/search", params={"q": f'{comparison_query} price', "format": "json", "language": "en-US", "safesearch": 1})
                comparison_search.raise_for_status()
                comparison_results = comparison_search.json().get("results", [])[:MAX_RESULTS * 2]
                inspected_alternatives = await asyncio.gather(*(inspect_result(client, item, identifier, category) for item in comparison_results))
                exact_urls = {item["url"].split("?", 1)[0].rstrip("/") for item in listings}
                for item in inspected_alternatives:
                    if not item:
                        continue
                    normalized_url = item["url"].split("?", 1)[0].rstrip("/")
                    if normalized_url in exact_urls or item["identifier_match"]:
                        continue
                    name_score = product_name_score(category, f'{item["title"]} {item["description"]}')
                    if not reliable_name_match(category, f'{item["title"]} {item["description"]}'):
                        continue
                    similarity, differences = compare_specs(reference_specs, item["specifications"], name_score)
                    if similarity < 55:
                        continue
                    item["match_type"] = "alternative"
                    item["spec_similarity"] = similarity
                    item["differences"] = differences
                    alternatives.append(item)
                    exact_urls.add(normalized_url)
                    if len(alternatives) >= MAX_RESULTS:
                        break
            except (httpx.HTTPError, json.JSONDecodeError):
                alternatives = []

        sold_history = []
        sold_target = identifier or search_name
        if sold_target:
            try:
                sold_search = await client.get(f"{SEARXNG_URL}/search", params={"q": f'site:ebay.com "{sold_target}" sold completed price', "format": "json", "language": "en-US", "safesearch": 1})
                sold_search.raise_for_status()
                sold_results = sold_search.json().get("results", [])[:MAX_RESULTS * 2]
                inspected_sales = await asyncio.gather(*(inspect_result(client, item, identifier, search_name) for item in sold_results))
                seen_sales = set()
                for item in inspected_sales:
                    if not item or "ebay." not in item["source"] or not item.get("sold_evidence"):
                        continue
                    evidence = f'{item["title"]} {item["description"]}'
                    identity_ok = item["identifier_match"] if identifier else reliable_name_match(search_name, evidence)
                    if not identity_ok:
                        continue
                    normalized_url = item["url"].split("?", 1)[0].rstrip("/")
                    if normalized_url in seen_sales:
                        continue
                    seen_sales.add(normalized_url)
                    item["offer_type"] = "completed_sale"
                    sold_history.append(item)
                sold_history, sold_outliers = filter_price_outliers(sold_history)
            except (httpx.HTTPError, json.JSONDecodeError):
                sold_history, sold_outliers = [], []
        else:
            sold_outliers = []

    retail_listings = [item for item in listings if item.get("offer_type") == "retail"]
    wholesale_all = [item for item in listings if item.get("offer_type") == "wholesale"]
    unverified_wholesale = [item for item in wholesale_all if "alibaba." in item.get("source", "") and not item.get("supplier_verified")]
    for item in unverified_wholesale:
        item["outlier_reason"] = "Excluded because the public Alibaba result did not show a Verified Supplier designation."
    wholesale_offers = [item for item in wholesale_all if item not in unverified_wholesale]
    retail_listings, retail_outliers = filter_price_outliers(retail_listings)
    wholesale_offers, wholesale_outliers = filter_price_outliers(wholesale_offers)
    excluded_outliers = retail_outliers + wholesale_outliers + sold_outliers + unverified_wholesale
    listings = retail_listings
    listings.sort(key=lambda item: item["unit_price"])
    wholesale_offers.sort(key=lambda item: item["unit_price"])
    sold_history.sort(key=lambda item: item["unit_price"])
    for item in listings:
        item["match_type"] = "exact"
        item["spec_similarity"] = 100
        item["differences"] = []
    values = [item["unit_price"] for item in listings]
    q1_index = max(0, round((len(values) - 1) * 0.25)) if values else 0
    confidence = max(80, summary["match_confidence"]) if summary else (92 if identifier else 82)
    product_specs = clean_specifications(reference_specs)
    return {
        "identifier_type": identifier_type(identifier),
        "query": query,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "match_confidence": confidence,
        "product": {
            "title": (summary or {}).get("title") or lead.get("title") or product_name or identifier,
            "description": (summary or {}).get("description") or lead.get("description") or "",
            "image_url": lead.get("image_url"),
            "category": category,
            "specifications": product_specs,
        },
        "prices": {
            "low": values[0] if values else None,
            "median": round(median(values), 2) if values else None,
            "high": values[-1] if values else None,
            "conservative": values[q1_index] if values else None,
            "currency": "USD"
        },
        "listings": listings,
        "wholesale_offers": wholesale_offers,
        "excluded_outliers": excluded_outliers,
        "best_retail_deal": listings[0] if listings else None,
        "best_wholesale_deal": wholesale_offers[0] if wholesale_offers else None,
        "alternatives": alternatives,
        "sold_history_available": bool(sold_history),
        "sold_history": sold_history,
        "warnings": ["Retail and wholesale prices are calculated separately.", "Wholesale unit prices can require a minimum order and exclude shipping, duties, and taxes.", "Only records with explicit sold, completed, or ended evidence appear in Sale history."]
    }

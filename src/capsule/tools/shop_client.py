"""Shop MCP client, pool fetcher, candidate selector, and live size checker."""

from __future__ import annotations

import concurrent.futures
import json
import math
import re
import sys
import time
from typing import Any

import requests
from requests.adapters import HTTPAdapter

ENDPOINT = "https://mcp.shop.com/"
SHOPS = ["fashionnova.com", "everlane.com", "stevemadden.com", "kith.com"]

# Strictly read-only Shop MCP tools used by the capsule pipeline.
# The store rule "no cart, checkout or payment tool" holds inside the sandbox too.
ALLOWED_MCP_TOOLS: frozenset[str] = frozenset({"search_catalog", "get_product"})

ALLOWED_DOMAINS: dict[str, str] = {
    "fnova.myshopify.com": "Fashion Nova",
    "m34kzg-ke.myshopify.com": "Everlane",
    "stevemadden.myshopify.com": "Steve Madden",
    "kithnyc.myshopify.com": "Kith",
}

STORE_PREF_ORDER = [
    "m34kzg-ke.myshopify.com",
    "stevemadden.myshopify.com",
    "kithnyc.myshopify.com",
    "fnova.myshopify.com",
]

RAW_TO_CANONICAL_SLOT: dict[str, str] = {
    "shirts": "top",
    "tees": "top",
    "tops": "top",
    "shorts": "bottom",
    "trousers": "bottom",
    "bottoms": "bottom",
    "swim_shorts": "swim_shorts",
    "swim": "swim_shorts",
    "dress": "dress",
    "dresses": "dress",
    "formal_dress": "dress",
    "sneakers": "shoes",
    "sandals": "shoes",
    "heels": "shoes",
    "shoes": "shoes",
    "overshirt": "layer",
    "layer": "layer",
    "formal_layer": "layer",
    "formal_bottom": "bottom",
    "formal_shoes": "shoes",
    "formal_top": "top",
    "tie": "tie",
    "sunglasses": "sunglasses",
    "belt": "belt",
    "bag": "bag",
    "hat": "hat",
    "jewelry": "jewelry",
    "accessory": "accessory",
}

FORMAL_RAW_SLOTS = {"formal_layer", "formal_bottom", "formal_shoes", "formal_top", "formal_dress", "tie"}

MEN_EXCLUDES = [
    "women", "woman", "womens", "women's", "ladies", "lady", "girl", "girls",
    "kids", "kid", "youth", "toddler", "baby", "infant", "boy", "boys",
    "bikini", "bra", "bralette", "skirt", "heels", "heel", "stiletto", "pump",
    "maternity", "romper", "jumpsuit", "legging", "bodysuit", "crop top",
    "lingerie", "handbag", "clutch", "purse", "ballet flat", "wedge",
]

WOMEN_EXCLUDES = [
    "men's", "mens", "boys", "boy", "kids", "kid", "youth", "toddler", "baby", "infant", "boxer",
]

COLOR_LIST = [
    "black", "brown", "tan", "cognac", "espresso", "chocolate", "camel",
    "chestnut", "mahogany", "walnut", "navy", "midnight", "blue", "cobalt", "indigo",
    "white", "off-white", "cream", "ivory", "ecru", "beige", "khaki",
    "stone", "sand", "oatmeal", "taupe", "olive", "sage", "green", "forest",
    "grey", "gray", "charcoal", "heather", "silver", "gold", "burgundy",
    "maroon", "wine", "red", "rust", "terracotta", "orange", "yellow",
    "mustard", "pink", "coral", "purple", "lavender", "multi", "tortoise",
]

# US -> (EU, UK) mappings for men's and women's shoes
MEN_US_TO_EU = {
    7: 40, 7.5: 40.5, 8: 41, 8.5: 41.5, 9: 42, 9.5: 42.5,
    10: 43, 10.5: 43.5, 11: 44, 11.5: 44.5, 12: 45, 13: 46,
}
WOMEN_US_TO_EU = {
    5: 35.5, 5.5: 36, 6: 36.5, 6.5: 37, 7: 37.5, 7.5: 38,
    8: 38.5, 8.5: 39, 9: 39.5, 9.5: 40, 10: 40.5, 11: 41.5,
}

_SESSION: requests.Session | None = None


def get_session() -> requests.Session:
    global _SESSION
    if _SESSION is None:
        s = requests.Session()
        adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=0)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        _SESSION = s
    return _SESSION


def call_mcp(tool_name: str, arguments: dict[str, Any], req_id: int = 1, retries: int = 1) -> dict[str, Any]:
    if not isinstance(tool_name, str) or tool_name not in ALLOWED_MCP_TOOLS:
        raise ValueError(f"Disallowed Shop MCP tool in capsule sandbox: {tool_name!r}")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool_name,
    }
    body = {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments,
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {"name": "alice", "version": "0.1.0"},
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    }
    session = get_session()
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = session.post(ENDPOINT, headers=headers, json=body, timeout=20)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(0.35 * (attempt + 1))
                continue
            resp.raise_for_status()
            ct = resp.headers.get("Content-Type", "")
            text = resp.text.strip()
            if "text/event-stream" in ct or text.startswith("event:") or text.startswith("data:"):
                data_lines = [
                    line[len("data:"):].strip()
                    for line in text.splitlines()
                    if line.startswith("data:")
                ]
                payload = json.loads(data_lines[-1])
            else:
                payload = resp.json()
            if "error" in payload:
                raise RuntimeError(f"MCP error: {payload['error']}")
            result = payload.get("result", {})
            if "structuredContent" in result and result["structuredContent"] is not None:
                return result["structuredContent"]
            content = result.get("content", [])
            if content and isinstance(content[0], dict) and "text" in content[0]:
                return json.loads(content[0]["text"])
            return result if isinstance(result, dict) else {}
        except Exception as err:
            last_err = err
            if attempt < retries:
                time.sleep(0.3 * (attempt + 1))
    raise RuntimeError(f"MCP call {tool_name} failed: {last_err}")


def extract_items(res: Any) -> list[dict[str, Any]]:
    if isinstance(res, list):
        return [x for x in res if isinstance(x, dict)]
    if isinstance(res, dict):
        for k in ("products", "offers", "items", "results", "variants", "edges"):
            if k in res and isinstance(res[k], list):
                return [x for x in res[k] if isinstance(x, dict)]
        for v in res.values():
            if isinstance(v, dict):
                sub = extract_items(v)
                if sub:
                    return sub
    return []


def normalize_dress_code(dc: str | None) -> str:
    raw = re.sub(r"[\s\-]+", "_", (dc or "casual").strip().lower())
    if raw in ("black_tie_optional", "black_tie", "formal", "tuxedo"):
        return "formal"
    if raw in ("beach", "swim", "pool", "resort"):
        return "beach"
    if raw in ("smart_casual", "dinner", "cocktail", "business_casual", "evening"):
        return "smart_casual"
    return "casual"


def build_query_plan(spec: dict[str, Any]) -> list[tuple[str, str, int]]:
    """Return list of (raw_slot, query, max_price_cents) based on spec."""
    gender = (spec.get("gender") or "men").strip().lower()
    budget_usd = float(spec.get("budget_usd") or 450)
    # Per-piece max price cap (generous enough for quality items, bounded by budget)
    base_max = int(min(max(budget_usd * 0.55, 140), 260) * 100)
    formal_max = int(min(max(budget_usd * 0.65, 180), 300) * 100)

    days = spec.get("days") or []
    dress_codes = {normalize_dress_code(d.get("dress_code")) for d in days}
    all_needs: set[str] = set()
    has_beach = False
    for d in days:
        for s in d.get("needs") or []:
            all_needs.add(str(s).lower())
        if d.get("allow_swim_bottom") or normalize_dress_code(d.get("dress_code")) == "beach":
            has_beach = True
        if "beach" in (d.get("name") or "").lower() or "beach" in (d.get("notes") or "").lower():
            has_beach = True

    has_formal = "formal" in dress_codes or "tie" in all_needs
    has_non_formal = any(normalize_dress_code(d.get("dress_code")) != "formal" for d in days) or not has_formal

    plan: list[tuple[str, str, int]] = []
    custom_queries = spec.get("queries") or {}

    if custom_queries and isinstance(custom_queries, dict):
        for raw_slot, q_val in custom_queries.items():
            q_list = [q_val] if isinstance(q_val, str) else list(q_val or [])
            cap = formal_max if raw_slot in FORMAL_RAW_SLOTS else base_max
            for q in q_list:
                if isinstance(q, str) and q.strip():
                    plan.append((str(raw_slot), q.strip(), cap))

    existing_slots = {r for r, _, _ in plan}

    def add_default(raw_slot: str, query: str, max_cents: int) -> None:
        if raw_slot not in existing_slots:
            plan.append((raw_slot, query, max_cents))
            existing_slots.add(raw_slot)

    if gender == "women":
        if has_non_formal:
            add_default("tops", "women's linen blouse shirt", base_max)
            add_default("bottoms", "women's linen trousers pants", base_max)
            add_default("dresses", "women's midi sundress", base_max)
            add_default("sneakers", "women's sneakers", base_max)
            add_default("layer", "women's blazer cardigan jacket", base_max)
            add_default("bag", "women's crossbody tote bag", int(min(base_max, 14000)))
            add_default("sunglasses", "women's sunglasses", 8000)
        if has_beach:
            add_default("sandals", "women's sandals", base_max)
        if has_formal:
            add_default("formal_dress", "women's black formal evening gown midi dress", formal_max)
            add_default("formal_shoes", "women's black heels dress shoes", formal_max)
    else:
        if has_non_formal:
            add_default("shirts", "men's linen button shirt", base_max)
            add_default("tees", "men's polo crewneck shirt", base_max)
            add_default("shorts", "men's chino shorts", base_max)
            add_default("trousers", "men's chino linen trousers pants", base_max)
            add_default("sneakers", "men's leather canvas sneakers", base_max)
            add_default("overshirt", "men's overshirt jacket blazer", base_max)
            add_default("belt", "men's leather belt", 9000)
            add_default("sunglasses", "men's sunglasses", 9000)
            add_default("bag", "men's tote crossbody bag", 12000)
        if has_beach:
            add_default("swim_shorts", "men's swim shorts trunks", base_max)
            add_default("sandals", "men's sandals slides", base_max)
        if has_formal:
            add_default("formal_layer", "men's black blazer tuxedo suit jacket", formal_max)
            add_default("formal_bottom", "men's black dress pants trousers", formal_max)
            add_default("formal_shoes", "men's black leather oxford dress shoe", formal_max)
            add_default("tie", "men's tie bow tie necktie", 9000)

    return plan


def extract_colors(text: str) -> list[str]:
    low = text.lower()
    found = [c for c in COLOR_LIST if re.search(r"\b" + re.escape(c) + r"\b", low)]
    return sorted(set(found))


def detect_leather(text: str) -> bool:
    low = text.lower()
    if "non-leather" in low or "no leather" in low:
        return False
    return bool(re.search(r"\b(leather|suede|nubuck|patent)\b", low))


def is_gender_appropriate(item: dict[str, Any], gender: str, extra_excludes: list[str]) -> bool:
    title = (item.get("title") or "").lower()
    handle = (item.get("handle") or "").lower()
    text = f"{title} {handle}"
    excludes = list(MEN_EXCLUDES if gender == "men" else WOMEN_EXCLUDES) + [
        w.lower() for w in (extra_excludes or []) if isinstance(w, str) and w.strip()
    ]
    for kw in excludes:
        if re.search(r"\b" + re.escape(kw) + r"\b", text):
            return False
    # For men, exclude standalone "dress" unless followed by menswear garment noun
    if gender == "men":
        if re.search(r"\bdress\b(?!\s+(pant|trouser|shoe|shirt|slack|loafer|oxford|derby|belt|sock))", text):
            return False
    return True


def slot_relevant(raw_slot: str, item: dict[str, Any]) -> bool:
    title = (item.get("title") or "").lower()
    handle = (item.get("handle") or "").lower()
    text = f"{title} {handle}"

    if raw_slot in ("formal_layer",):
        if any(w in title for w in ("hoodie", "fleece", "puffer", "bomber", "track", "denim", "short", "tee")):
            return False
        return any(w in title for w in ("blazer", "tuxedo", "suit jacket", "suit", "dinner jacket")) and any(
            c in text for c in ("black", "navy", "midnight", "charcoal", "dark")
        )
    if raw_slot in ("formal_bottom",):
        if any(w in title for w in ("jogger", "sweatpant", "cargo", "short", "jean", "denim", "track")):
            return False
        return any(w in title for w in ("trouser", "pant", "slack", "suit", "tuxedo")) and any(
            c in text for c in ("black", "charcoal", "midnight", "navy")
        )
    if raw_slot in ("formal_shoes",):
        if any(w in title for w in ("sneaker", "slide", "sandal", "boot", "clog", "flip")):
            return False
        return any(
            w in title for w in ("oxford", "derby", "loafer", "dress", "monk", "brogue", "wingtip", "tuxedo", "patent", "heel", "pump")
        ) and any(c in text for c in ("black", "patent"))
    if raw_slot == "tie":
        return any(w in title for w in ("necktie", "neck tie", "bowtie", "bow tie", "silk tie")) or (
            re.search(r"\btie\b", title) is not None
            and not any(
                w in title
                for w in (
                    "pant", "trouser", "belted", "shirt", "jacket", "short", "shoe",
                    "tee", "hoodie", "dye", "waist", "front", "back", "side", "strap", "belt", "bag",
                )
            )
        )
    if raw_slot == "swim_shorts":
        return any(w in title for w in ("swim", "trunk", "boardshort", "board short"))
    if raw_slot == "belt":
        return "belt" in title and not any(w in title for w in ("pant", "short", "jacket", "coat", "dress", "jean", "bag"))
    if raw_slot == "sunglasses":
        return any(w in title for w in ("sunglass", "shades", "eyewear", "aviator", "wayfarer", "glasses"))
    if raw_slot == "hat":
        return any(w in title for w in ("hat", "cap", "beanie", "bucket", "visor", "fedora", "snapback", "trucker"))
    if raw_slot == "bag":
        if "baggy" in title:
            return False
        return any(w in title for w in ("bag", "tote", "backpack", "duffel", "crossbody", "sling", "pouch", "messenger", "weekender"))
    if raw_slot == "sneakers":
        return any(w in title for w in ("sneaker", "shoe", "runner", "trainer", "low top", "low-top", "court", "canvas", "slip-on", "slip on", "loafer"))
    if raw_slot == "sandals":
        return any(w in title for w in ("sandal", "slide", "flip flop", "flip-flop", "mule", "clog", "espadrille"))
    if raw_slot in ("overshirt", "layer"):
        return any(w in title for w in ("overshirt", "shacket", "jacket", "chore", "blazer", "cardigan", "coat", "bomber", "trucker", "linen"))
    if raw_slot == "shorts":
        return "short" in title and not any(w in title for w in ("shirt", "sleeve", "swim", "trunk", "boxer", "brief", "underwear"))
    if raw_slot in ("trousers", "bottoms"):
        return any(w in title for w in ("pant", "trouser", "chino", "slack", "jean", "linen")) and "short" not in title
    if raw_slot == "tees":
        return any(w in title for w in ("tee", "t-shirt", "tshirt", "crewneck", "henley", "polo", "knit"))
    if raw_slot in ("shirts", "tops"):
        return any(w in title for w in ("shirt", "polo", "button", "camp", "linen", "oxford", "resort", "blouse", "top"))
    if raw_slot in ("dress", "dresses", "formal_dress"):
        return any(w in title for w in ("dress", "gown", "midi", "maxi"))
    return True


def _item_rating_tuple(item: dict[str, Any]) -> tuple[float | None, int | None]:
    r_obj = item.get("rating") or {}
    val = r_obj.get("value") if isinstance(r_obj, dict) else None
    cnt = r_obj.get("count") if isinstance(r_obj, dict) else None
    try:
        r_val = float(val) if val is not None else None
    except (TypeError, ValueError):
        r_val = None
    try:
        r_cnt = int(cnt) if cnt is not None else None
    except (TypeError, ValueError):
        r_cnt = None
    return r_val, r_cnt


def _candidate_pre_score(price_cents: int, rating: float | None, rating_count: int | None, budget_usd: float) -> float:
    """Prefer well-rated, mid-range items over bottom-tier junk during candidate selection."""
    price_usd = price_cents / 100.0
    target = max(35.0, min(95.0, budget_usd * 0.16))
    # Distance from sweet-spot price (penalize ultra-cheap < $15 heavily)
    if price_usd < 15.0:
        price_score = -40.0
    else:
        price_score = 30.0 - abs(price_usd - target) * 0.35
    if rating is not None and rating > 0:
        qual = rating * math.log(1.0 + max(1, rating_count or 0))
    else:
        qual = 4.2 * math.log(1.0 + 15)
    return qual * 2.5 + price_score


def select_candidates(
    raw_by_key: dict[str, dict[str, Any]],
    query_keys: list[tuple[str, str]],
    spec: dict[str, Any],
    already_checked_pids: set[str],
    target_total: int = 56,
) -> list[tuple[str, dict[str, Any]]]:
    gender = (spec.get("gender") or "men").strip().lower()
    budget_usd = float(spec.get("budget_usd") or 450)
    excludes = spec.get("excludes") or []

    per_slot_limits = {
        "shirts": 6,
        "tees": 5,
        "tops": 6,
        "shorts": 5,
        "trousers": 6,
        "bottoms": 6,
        "swim_shorts": 5,
        "sneakers": 6,
        "sandals": 4,
        "overshirt": 5,
        "layer": 5,
        "belt": 4,
        "sunglasses": 3,
        "bag": 3,
        "hat": 2,
        "formal_layer": 6,
        "formal_bottom": 6,
        "formal_shoes": 6,
        "formal_dress": 6,
        "tie": 5,
    }

    selected: list[tuple[str, dict[str, Any]]] = []
    seen_pids = set(already_checked_pids)

    for raw_slot, qkey in query_keys:
        entry = raw_by_key.get(qkey) or {}
        items = entry.get("items") or []
        limit = per_slot_limits.get(raw_slot, 5)
        max_cents = int(entry.get("max_cents") or 20000)

        by_store: dict[str, list[tuple[float, dict[str, Any]]]] = {}
        for it in items:
            pid = it.get("id")
            if not pid or pid in seen_pids:
                continue
            v0 = (it.get("variants") or [{}])[0]
            dom = (v0.get("seller") or {}).get("domain")
            if dom not in ALLOWED_DOMAINS:
                continue
            price_cents = (v0.get("price") or {}).get("amount")
            if price_cents is None or price_cents <= 0 or price_cents > max_cents:
                continue
            if not is_gender_appropriate(it, gender, excludes):
                continue
            if not slot_relevant(raw_slot, it):
                continue
            r_val, r_cnt = _item_rating_tuple(it)
            score = _candidate_pre_score(price_cents, r_val, r_cnt, budget_usd)
            by_store.setdefault(dom, []).append((score, it))

        for dom in by_store:
            by_store[dom].sort(key=lambda x: -x[0])

        picked: list[tuple[str, dict[str, Any]]] = []
        idx = 0
        while len(picked) < limit:
            added_any = False
            for dom in STORE_PREF_ORDER:
                lst = by_store.get(dom, [])
                if idx < len(lst) and len(picked) < limit:
                    _, it = lst[idx]
                    pid = it["id"]
                    if pid not in seen_pids:
                        seen_pids.add(pid)
                        picked.append((raw_slot, it))
                        added_any = True
            if not added_any:
                break
            idx += 1
        selected.extend(picked)

    return selected[:target_total]


def _letter_patterns(letter: str) -> list[str]:
    l = letter.strip().lower()
    mapping = {
        "xs": [r"^xs$", r"^x-?small$", r"^extra\s*small$", r"^xs\s*\(.*\)$", r"^x-?small\s*\(xs\)$"],
        "s": [r"^s$", r"^small$", r"^sm$", r"^us\s*s$", r"^small\s*\(s\)$", r"^s\s*\(small\)$"],
        "m": [r"^m$", r"^medium$", r"^md$", r"^us\s*m$", r"^medium\s*\(m\)$", r"^m\s*\(medium\)$"],
        "l": [r"^l$", r"^large$", r"^lg$", r"^us\s*l$", r"^large\s*\(l\)$", r"^l\s*\(large\)$"],
        "xl": [r"^xl$", r"^x-?large$", r"^extra\s*large$", r"^xl\s*\(.*\)$", r"^x-?large\s*\(xl\)$"],
        "xxl": [r"^xxl$", r"^2xl$", r"^xx-?large$"],
    }
    aliases = {"small": "s", "medium": "m", "large": "l", "xsmall": "xs", "xlarge": "xl", "2xl": "xxl"}
    l = aliases.get(l, l)
    return mapping.get(l, [r"^" + re.escape(l) + r"$"])


def _waist_to_letter(waist: int) -> str:
    if waist <= 29:
        return "s"
    if waist <= 33:
        return "m"
    if waist <= 36:
        return "l"
    return "xl"


def match_size_label(
    canonical_slot: str,
    raw_slot: str,
    target_size: str,
    labels: list[str],
    gender: str = "men",
) -> str | None:
    def norm(s: str) -> str:
        return re.sub(r"\s+", " ", s.strip().lower())

    target = (target_size or "").strip()

    if canonical_slot in ("sunglasses", "belt", "bag", "hat", "tie", "accessory", "jewelry"):
        acc_pats = [
            r"^one\s*size$", r"^os$", r"^o/s$", r"^osfa$", r"^one\s*size\s*fits\s*all$",
            r"^default(\s*title)?$",
        ]
        if target:
            acc_pats.extend(_letter_patterns(target))
            m_num = re.search(r"\d+", target)
            if m_num:
                n = int(m_num.group(0))
                acc_pats.extend([rf"^{n}$", rf"^{n+2}$", rf"^{n}-{n+2}$", rf"^{n-2}-{n}$"])
        acc_pats.extend([r"^m$", r"^medium$", r"^m/l$", r"^s/m$"])
        for pat in acc_pats:
            for lbl in labels:
                if re.match(pat, norm(lbl)):
                    return lbl
        return None

    if canonical_slot in ("top", "layer", "dress"):
        pats = _letter_patterns(target or "M")
        # Also allow numeric blazer sizes if letter M/L/etc.
        t_low = (target or "m").strip().lower()
        if canonical_slot == "layer" and gender == "men":
            chest_map = {"s": ["36", "38"], "m": ["38", "40"], "l": ["42", "44"], "xl": ["44", "46"]}
            for c in chest_map.get(t_low[0] if t_low else "m", []):
                pats.append(rf"^{c}[rsl]?$")
        for pat in pats:
            for lbl in labels:
                if re.match(pat, norm(lbl)):
                    return lbl
        return None

    if canonical_slot in ("bottom", "swim_shorts"):
        m_num = re.search(r"(\d{2})", target)
        pats: list[str] = []
        if m_num:
            w = int(m_num.group(1))
            pats.extend([
                rf"^{w}$", rf"^{w}w$", rf"^w{w}$", rf"^us\s*{w}$", rf"^size\s*{w}$",
                rf"^{w}\s*[x/]\s*30$", rf"^{w}\s*[x/]\s*32$",
                rf"^{w}w\s*[x/]\s*30l$", rf"^{w}w\s*[x/]\s*32l$",
                rf"^{w}\s*-\s*30$", rf"^{w}\s*-\s*32$",
                rf"^{w}\s*\(.*\)$",
            ])
            # Allow letter equivalent on shorts, swim shorts, or S/M/L trousers
            if raw_slot in ("shorts", "swim_shorts", "formal_bottom") or canonical_slot == "swim_shorts":
                pats.extend(_letter_patterns(_waist_to_letter(w)))
        else:
            pats.extend(_letter_patterns(target or "M"))
        for pat in pats:
            for lbl in labels:
                if re.match(pat, norm(lbl)):
                    return lbl
        return None

    if canonical_slot == "shoes":
        m_num = re.search(r"(\d+(?:\.\d+)?)", target)
        if not m_num:
            return None
        us_val = float(m_num.group(1))
        us_str = str(int(us_val)) if us_val.is_integer() else str(us_val)
        esc = re.escape(us_str)
        pats = [
            rf"^{esc}$",
            rf"^{esc}\.0$",
            rf"^us\s*{esc}$",
            rf"^{esc}\s*us$",
            rf"^{esc}\s*[mdw]$",
            rf"^{esc}[mdw]$",
            rf"^men'?s?\s*{esc}$",
            rf"^women'?s?\s*{esc}$",
            rf"^[mw]\s*{esc}$",
            rf"^{esc}\s*\(us\)$",
            rf"^us\s*{esc}\s*/.*$",
            rf"^{esc}\s*/.*$",
        ]
        eu_map = MEN_US_TO_EU if gender == "men" else WOMEN_US_TO_EU
        if us_val in eu_map:
            eu = eu_map[us_val]
            eu_str = str(int(eu)) if float(eu).is_integer() else str(eu)
            pats.extend([rf"^eu\s*{re.escape(eu_str)}$", rf"^{re.escape(eu_str)}$"])
        if gender == "men" and us_val >= 6:
            uk = us_val - 1
            uk_str = str(int(uk)) if float(uk).is_integer() else str(uk)
            pats.extend([rf"^uk\s*{re.escape(uk_str)}$", rf"^{re.escape(uk_str)}\s*uk$"])
        for pat in pats:
            for lbl in labels:
                if re.match(pat, norm(lbl)):
                    return lbl
        return None

    return None


def target_size_for_slot(canonical_slot: str, sizes: dict[str, str]) -> str:
    if canonical_slot in ("top", "layer", "dress"):
        return str(sizes.get(canonical_slot) or sizes.get("top") or "M")
    if canonical_slot in ("bottom", "swim_shorts"):
        return str(sizes.get(canonical_slot) or sizes.get("bottom") or "32")
    if canonical_slot == "shoes":
        return str(sizes.get("shoes") or "10")
    return str(sizes.get(canonical_slot) or sizes.get("bottom") or sizes.get("top") or "One Size")


def check_one_candidate(
    idx: int,
    raw_slot: str,
    item: dict[str, Any],
    spec: dict[str, Any],
) -> tuple[dict[str, Any] | None, int]:
    calls = 0
    pid = item["id"]
    canonical_slot = RAW_TO_CANONICAL_SLOT.get(raw_slot, raw_slot)
    gender = (spec.get("gender") or "men").strip().lower()
    sizes = spec.get("sizes") or {}
    target_sz = target_size_for_slot(canonical_slot, sizes)
    budget_usd = float(spec.get("budget_usd") or 450)
    max_price = max(budget_usd * 0.7, 180.0)

    res1 = call_mcp(
        "get_product",
        {"catalog": {"id": pid, "context": {"currency": "USD", "address_country": "US"}}},
        req_id=1000 + idx * 2,
    )
    calls += 1
    prod1 = res1.get("product", res1)
    if not isinstance(prod1, dict) or not prod1.get("id"):
        return None, calls

    prod_id = prod1["id"]
    options = prod1.get("options") or []
    variants1 = prod1.get("variants") or []
    if not variants1:
        return None, calls
    v1 = variants1[0]

    size_opt = None
    for opt in options:
        oname = (opt.get("name") or "").lower()
        if any(k in oname for k in ("size", "waist", "shoe")):
            size_opt = opt
            break

    existing_v_opts = v1.get("options") or []
    matched_size_label = "One Size"

    if size_opt is not None:
        avail_labels: list[str] = []
        for val in (size_opt.get("values") or []):
            if isinstance(val, dict):
                if val.get("available") is False or val.get("exists") is False:
                    continue
                lbl = val.get("label") or val.get("value")
                if lbl:
                    avail_labels.append(str(lbl))
            elif isinstance(val, str):
                avail_labels.append(val)

        matched = match_size_label(canonical_slot, raw_slot, target_sz, avail_labels, gender)
        if not matched:
            return None, calls
        matched_size_label = matched

        selected_opts = [
            {"name": evo["name"], "label": evo["label"]}
            for evo in existing_v_opts
            if evo.get("name") != size_opt.get("name")
        ]
        selected_opts.append({"name": size_opt["name"], "label": matched_size_label})

        res2 = call_mcp(
            "get_product",
            {
                "catalog": {
                    "id": prod_id,
                    "context": {"currency": "USD", "address_country": "US"},
                    "selected": selected_opts,
                }
            },
            req_id=1000 + idx * 2 + 1,
        )
        calls += 1
        prod2 = res2.get("product", res2)
        variants2 = prod2.get("variants") or []
        if not variants2:
            return None, calls
        v_final = variants2[0]
        v_opts = {o.get("name"): o.get("label") for o in (v_final.get("options") or [])}
        if size_opt.get("name") in v_opts and v_opts[size_opt["name"]] != matched_size_label:
            return None, calls
    else:
        if canonical_slot not in ("sunglasses", "belt", "bag", "hat", "tie", "accessory", "jewelry"):
            return None, calls
        v_final = v1

    if (v_final.get("availability") or {}).get("available") is not True:
        return None, calls

    price_cents = (v_final.get("price") or {}).get("amount")
    if price_cents is None or price_cents <= 0:
        return None, calls
    price_usd = round(price_cents / 100.0, 2)
    if price_usd > max_price:
        return None, calls

    seller = v_final.get("seller") or v1.get("seller") or {}
    store_domain = seller.get("domain")
    if store_domain not in ALLOWED_DOMAINS:
        return None, calls
    store = ALLOWED_DOMAINS[store_domain]

    title = prod1.get("title") or item.get("title") or ""
    v_title = v_final.get("title") or ""
    desc = (prod1.get("description") or {}).get("plain") or ""
    handle = prod1.get("handle") or ""
    url = v_final.get("url") or v1.get("url") or ""
    variant_id = v_final.get("id")
    if not variant_id or not url:
        return None, calls

    r_val, r_cnt = _item_rating_tuple(prod1)
    if r_val is None:
        r_val, r_cnt = _item_rating_tuple(item)

    color_source = " ".join(
        [title, v_title, handle]
        + [o.get("label", "") for o in (v_final.get("options") or []) if "color" in (o.get("name") or "").lower()]
    )
    color_words = extract_colors(color_source)
    is_leather = detect_leather(f"{title} {v_title} {desc[:400]}")
    is_formal = raw_slot in FORMAL_RAW_SLOTS

    # Grab first clean image URL if present
    image_url = ""
    for media_list in (v_final.get("media"), prod1.get("media")):
        if isinstance(media_list, list):
            for m in media_list:
                if isinstance(m, dict) and m.get("url"):
                    image_url = str(m["url"])
                    break
        if image_url:
            break

    return {
        "slot": canonical_slot,
        "raw_slot": raw_slot,
        "formal": is_formal,
        "title": title,
        "store": store,
        "store_domain": store_domain,
        "price_usd": price_usd,
        "url": url,
        "image": image_url,
        "id": prod_id,
        "variant_id": variant_id,
        "size_label": matched_size_label,
        "target_size": target_sz,
        "color_words": color_words,
        "is_leather": is_leather,
        "rating": r_val,
        "rating_count": r_cnt,
    }, calls


def fetch_and_check_pool(
    spec: dict[str, Any],
    existing_raw: dict[str, Any] | None = None,
    existing_filtered: dict[str, Any] | None = None,
    reuse: bool = False,
) -> dict[str, Any]:
    """Fetch catalog queries (skipping cached ones when reuse=True) and verify sizes."""
    gender = (spec.get("gender") or "men").strip().lower()
    target_gender_val = "Male" if gender == "men" else "Female"
    query_plan = build_query_plan(spec)

    raw_by_key: dict[str, dict[str, Any]] = {}
    if reuse and existing_raw and isinstance(existing_raw.get("by_key"), dict):
        raw_by_key = dict(existing_raw["by_key"])

    to_fetch: list[tuple[str, str, str, int]] = []
    query_keys: list[tuple[str, str]] = []
    for raw_slot, query, max_cents in query_plan:
        qkey = f"{gender}|{raw_slot}|{query.lower()}|{max_cents}"
        query_keys.append((raw_slot, qkey))
        if not reuse or qkey not in raw_by_key:
            to_fetch.append((raw_slot, qkey, query, max_cents))

    t0 = time.time()
    search_calls = 0

    def do_search(idx: int, raw_slot: str, qkey: str, query: str, max_cents: int):
        args = {
            "catalog": {
                "query": query,
                "filters": {
                    "shops": SHOPS,
                    "attributes": [{"name": "Target gender", "values": [target_gender_val]}],
                    "available": True,
                    "price": {"max": max_cents},
                },
                "context": {"currency": "USD", "address_country": "US"},
                "pagination": {"limit": 24},
            }
        }
        res = call_mcp("search_catalog", args, req_id=idx + 1)
        return raw_slot, qkey, query, max_cents, extract_items(res)

    if to_fetch:
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
            futs = [
                ex.submit(do_search, i, rs, qk, q, mc)
                for i, (rs, qk, q, mc) in enumerate(to_fetch)
            ]
            for f in concurrent.futures.as_completed(futs):
                try:
                    rs, qk, q, mc, items = f.result()
                    search_calls += 1
                    raw_by_key[qk] = {"raw_slot": rs, "query": q, "max_cents": mc, "items": items}
                except Exception:
                    search_calls += 1

    fetch_s = round(time.time() - t0, 3)

    # Count unique products across active queries
    unique_ids: set[str] = set()
    for _, qkey in query_keys:
        for it in (raw_by_key.get(qkey) or {}).get("items") or []:
            pid = it.get("id") or it.get("url")
            if pid:
                unique_ids.add(str(pid))

    if to_fetch:
        print(f"STEP: searched {len(unique_ids)} products ({search_calls} queries, {fetch_s:.1f}s)", flush=True)
    else:
        print(f"STEP: reused {len(unique_ids)} searched products from disk", flush=True)

    # Reuse previously size-checked items that match current gender & requested sizes
    sizes = spec.get("sizes") or {}
    kept_items: list[dict[str, Any]] = []
    already_checked_pids: set[str] = set()
    if reuse and existing_filtered and isinstance(existing_filtered.get("items"), list):
        for rec in existing_filtered["items"]:
            slot = rec.get("slot", "")
            expected_sz = target_size_for_slot(slot, sizes)
            if rec.get("target_size") == expected_sz:
                kept_items.append(rec)
                if rec.get("id"):
                    already_checked_pids.add(rec["id"])

    # Only select candidates for newly fetched queries (or all queries on fresh run)
    keys_for_selection = [(rs, qk) for rs, qk, _, _ in to_fetch] if (reuse and kept_items) else query_keys
    target_candidates = 24 if (reuse and kept_items) else 56
    candidates = select_candidates(
        raw_by_key,
        keys_for_selection,
        spec,
        already_checked_pids,
        target_total=target_candidates,
    )

    t1 = time.time()
    size_calls = 0
    size_errors = 0
    newly_filtered: list[dict[str, Any]] = []

    if candidates:
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
            futs = [
                ex.submit(check_one_candidate, i, rs, it, spec)
                for i, (rs, it) in enumerate(candidates)
            ]
            for f in concurrent.futures.as_completed(futs):
                try:
                    rec, calls = f.result()
                    size_calls += calls
                    if rec is not None:
                        newly_filtered.append(rec)
                except Exception:
                    size_errors += 1

    size_check_s = round(time.time() - t1, 3)

    # Merge kept + newly filtered, deduplicating by variant_id (preferring formal=True if both)
    merged: dict[str, dict[str, Any]] = {}
    for rec in kept_items + newly_filtered:
        vid = rec["variant_id"]
        if vid in merged and merged[vid].get("formal") and not rec.get("formal"):
            continue
        merged[vid] = rec
    all_filtered = list(merged.values())

    if candidates:
        print(
            f"STEP: checked {len(candidates)} pieces in your sizes ({len(newly_filtered)} in stock, {size_check_s:.1f}s)",
            flush=True,
        )
    else:
        print(
            f"STEP: reused {len(all_filtered)} size-verified pieces from disk",
            flush=True,
        )

    return {
        "raw_state": {"by_key": raw_by_key, "total_unique": len(unique_ids)},
        "filtered_state": {"items": all_filtered},
        "searched": len(unique_ids),
        "candidates_checked": len(candidates),
        "size_errors": size_errors,
        "fetch_s": fetch_s,
        "size_check_s": size_check_s,
        "search_calls": search_calls,
        "size_check_calls": size_calls,
    }


def run_self_test() -> dict[str, Any]:
    """Verify call_mcp strictly enforces the read-only tool allowlist before any HTTP call."""
    global _SESSION
    assert ALLOWED_MCP_TOOLS == frozenset({"search_catalog", "get_product"}), (
        f"unexpected ALLOWED_MCP_TOOLS: {ALLOWED_MCP_TOOLS}"
    )

    class _FailSession:
        def post(self, *args: Any, **kwargs: Any) -> Any:
            raise AssertionError("HTTP request attempted for disallowed MCP tool")

    prev_session = _SESSION
    _SESSION = _FailSession()  # type: ignore[assignment]
    disallowed = [
        "create_cart",
        "get_cart",
        "update_cart",
        "create_checkout",
        "update_checkout",
        "get_checkout",
        "complete_checkout",
        "create_spend_request",
        "complete_spend_request",
        "lookup_catalog",
        "pay_order",
        "",
    ]
    try:
        for bad_tool in disallowed:
            try:
                call_mcp(bad_tool, {})
            except ValueError:
                pass
            else:
                raise AssertionError(f"call_mcp did not reject disallowed tool: {bad_tool!r}")
    finally:
        _SESSION = prev_session

    return {"shop_client_self_test": "ok", "allowed_tools": sorted(ALLOWED_MCP_TOOLS)}


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        print(json.dumps(run_self_test()))

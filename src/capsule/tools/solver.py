"""Spec-driven OR-Tools CP-SAT capsule solver with quality & taste scoring."""

from __future__ import annotations

import json
import math
import re
import sys
import time
from typing import Any

from ortools.sat.python import cp_model

ACCESSORY_SLOTS = ["sunglasses", "belt", "bag", "hat", "tie", "accessory", "jewelry"]

COLOR_WORDS_FOR_STEM = {
    "black", "white", "off-white", "cream", "ivory", "ecru", "navy", "blue", "indigo",
    "cobalt", "brown", "tan", "cognac", "espresso", "camel", "khaki", "beige", "sand",
    "stone", "oatmeal", "taupe", "olive", "sage", "green", "hunter", "forest", "teal",
    "grey", "gray", "charcoal", "heather", "silver", "gold", "burgundy", "maroon",
    "wine", "red", "rust", "terracotta", "orange", "yellow", "mustard", "pink", "coral",
    "purple", "lavender", "multi", "combo", "dark", "light", "washed", "vintage",
}


def normalize_dress_code(dc: str | None) -> str:
    raw = re.sub(r"[\s\-]+", "_", (dc or "casual").strip().lower())
    if raw in ("black_tie_optional", "black_tie", "formal", "tuxedo"):
        return "formal"
    if raw in ("beach", "swim", "pool", "resort"):
        return "beach"
    if raw in ("smart_casual", "dinner", "cocktail", "business_casual", "evening"):
        return "smart_casual"
    return "casual"


def get_color_family(piece: dict[str, Any]) -> str:
    words = {str(w).lower() for w in (piece.get("color_words") or [])}
    title_low = (piece.get("title") or "").lower()
    for w in ("brown", "tan", "cognac", "espresso", "chocolate", "camel", "chestnut", "mahogany", "walnut"):
        if w in words or re.search(r"\b" + w + r"\b", title_low):
            return "brown"
    for w in ("black", "charcoal"):
        if w in words or re.search(r"\b" + w + r"\b", title_low):
            return "black"
    for w in ("white", "off-white", "cream", "ivory", "ecru"):
        if w in words or re.search(r"\b" + w + r"\b", title_low):
            return "white"
    return "other"


def is_beach_shoe(piece: dict[str, Any]) -> bool:
    if piece.get("slot") != "shoes":
        return False
    raw = (piece.get("raw_slot") or "").lower()
    title_low = (piece.get("title") or "").lower()
    if raw == "sandals":
        return True
    return any(w in title_low for w in ("sandal", "slide", "espadrille", "flip flop", "flip-flop"))


def is_dress_or_loafer_shoe(piece: dict[str, Any]) -> bool:
    if piece.get("slot") != "shoes":
        return False
    title_low = (piece.get("title") or "").lower()
    return any(w in title_low for w in ("loafer", "oxford", "derby", "brogue", "monk", "wingtip", "dress shoe", "tuxedo"))


def owned_satisfies_day(piece: dict[str, Any], dc: str, allow_swim: bool) -> bool:
    """Return True if an owned piece is appropriate for a day's dress code."""
    if not piece.get("owned"):
        return False
    slot = piece.get("slot", "")
    title_low = (piece.get("title") or "").lower()
    if dc == "formal":
        return bool(piece.get("formal"))
    if dc == "beach" or allow_swim:
        if slot == "layer":
            return False
        if slot == "shoes" and not is_beach_shoe(piece):
            return False
        if slot == "top" and "dress shirt" in title_low:
            return False
        return True
    if dc == "smart_casual":
        if slot == "swim_shorts":
            return False
        if slot == "shoes" and is_beach_shoe(piece):
            return False
        return True
    # casual
    return slot != "swim_shorts"


def title_stem(title: str) -> str:
    """Normalize a product title into a style stem so near-duplicate items are capped."""
    s = (title or "").lower()
    # Cut color/variant suffixes after " - ", " | ", " / "
    s = re.split(r"\s[-|/]\s", s)[0]
    # Remove measurements like 4", 7", 5.5"
    s = re.sub(r'\b\d+(?:\.\d+)?\s*(?:"|\'\'|in|inch|cm)?\b', " ", s)
    tokens = re.findall(r"[a-z]+", s)
    core = [t for t in tokens if t not in COLOR_WORDS_FOR_STEM and len(t) > 1]
    if not core:
        core = tokens
    return " ".join(core[:4])


def build_owned_pieces(spec: dict[str, Any]) -> list[dict[str, Any]]:
    owned_raw = spec.get("owned") or []
    sizes = spec.get("sizes") or {}
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def make_slug(text: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:48]
        base = f"owned:{slug or 'piece'}"
        cand = base
        k = 2
        while cand in seen_ids:
            cand = f"{base}_{k}"
            k += 1
        seen_ids.add(cand)
        return cand

    for entry in owned_raw:
        if isinstance(entry, str):
            desc = entry.strip()
            slot = "layer" if "jacket" in desc.lower() else (
                "shoes" if any(w in desc.lower() for w in ("shoe", "loafer", "sneaker", "oxford", "boot", "sandal"))
                else ("bottom" if any(w in desc.lower() for w in ("trouser", "pant", "jean", "short"))
                      else ("suit" if "suit" in desc.lower() else "top"))
            )
            entry = {"slot": slot, "description": desc}

        if not isinstance(entry, dict):
            continue

        slot = str(entry.get("slot") or "top").strip().lower()
        desc = str(entry.get("description") or entry.get("title") or slot).strip()
        colour = str(entry.get("colour") or entry.get("color") or "").strip().lower()
        low = f"{desc} {colour}".lower()

        # Automatically split a suit into jacket (layer) + trousers (bottom)
        if slot == "suit":
            sub_entries = [
                {**entry, "slot": "layer", "description": f"{desc} jacket"},
                {**entry, "slot": "bottom", "description": f"{desc} trousers"},
            ]
        else:
            sub_entries = [entry]

        for sub in sub_entries:
            s = str(sub.get("slot") or "top").strip().lower()
            d = str(sub.get("description") or sub.get("title") or s).strip()
            c = str(sub.get("colour") or sub.get("color") or "").strip().lower()
            sub_low = f"{d} {c}".lower()

            pid = str(sub.get("id") or "")
            if pid and not pid.startswith("owned:"):
                pid = f"owned:{pid}"
            if not pid or pid in seen_ids:
                pid = make_slug(d)
            else:
                seen_ids.add(pid)

            is_leather = bool(sub.get("leather") or sub.get("is_leather") or re.search(r"\b(leather|suede|patent)\b", sub_low))
            if "formal" in sub and sub["formal"] is not None:
                is_formal = bool(sub["formal"])
            else:
                # White dress shirt, black tuxedo/suit, black oxford/derby are formal; linen/brown loafers are not
                if s == "top" and "dress shirt" in sub_low:
                    is_formal = True
                elif "tuxedo" in sub_low:
                    is_formal = True
                elif "black" in sub_low and any(w in sub_low for w in ("suit", "blazer", "oxford", "derby", "trouser", "gown")):
                    is_formal = "linen" not in sub_low
                else:
                    is_formal = False

            color_words = [w for w in re.findall(r"[a-z-]+", f"{c} {d}".lower()) if w in COLOR_WORDS_FOR_STEM]
            title_display = d if "(owned)" in d.lower() else f"{d.title()} (Owned)"
            sz = str(sizes.get(s) or sizes.get("top" if s == "layer" else s) or "Owned")
            out.append({
                "id": pid,
                "variant_id": pid,
                "slot": s,
                "raw_slot": s,
                "title": title_display,
                "store": "Owned",
                "store_domain": "owned",
                "price_usd": 0.0,
                "url": "",
                "image": "",
                "size_label": sz,
                "color_words": sorted(set(color_words)),
                "is_leather": is_leather,
                "formal": is_formal,
                "owned": True,
                "rating": None,
                "rating_count": None,
            })

    return out


def _percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    idx = min(len(sorted_vals) - 1, max(0, int(math.floor(p * (len(sorted_vals) - 1)))))
    return sorted_vals[idx]


def compute_quality_scores(new_pieces: list[dict[str, Any]], budget_usd: float) -> list[int]:
    """Compute per-candidate quality score:
    - rating * log(1 + review_count)
    - mid-range price bonus within slot
    - penalty for cheapest decile within slot (and ultra-cheap junk items)
    """
    prices_by_slot: dict[str, list[float]] = {}
    for p in new_pieces:
        prices_by_slot.setdefault(p["slot"], []).append(float(p["price_usd"]))
    for s in prices_by_slot:
        prices_by_slot[s].sort()

    scores: list[int] = []
    for p in new_pieces:
        slot = p["slot"]
        price = float(p["price_usd"])
        slot_prices = prices_by_slot.get(slot, [price])

        # 1. Rating * log(1 + review_count)
        rating = p.get("rating")
        rc = p.get("rating_count")
        if isinstance(rating, (int, float)) and rating > 0:
            rating_term = float(rating) * math.log(1.0 + max(1, int(rc or 0)))
        else:
            # Neutral baseline when store omits rating metadata (e.g. Everlane/Kith)
            rating_term = 4.3 * math.log(1.0 + 18)

        # 2. Price tier within slot: bonus for mid-range, penalty for cheapest decile
        distinct_prices = sorted(set(slot_prices))
        p10 = _percentile(slot_prices, 0.10)
        p25 = _percentile(slot_prices, 0.25)
        p50 = _percentile(slot_prices, 0.50)
        p80 = _percentile(slot_prices, 0.80)

        tier_score = 0.0
        is_core_garment = slot in ("top", "bottom", "shoes", "layer", "dress", "swim_shorts")
        is_cheapest_decile = (len(distinct_prices) >= 3 and price <= p10) or (
            is_core_garment and budget_usd >= 200 and price < 15.0
        )

        if is_cheapest_decile:
            tier_score = -420.0
        elif p25 <= price <= p80:
            # Small bonus peaking near median..p65
            dist = abs(price - p50) / max(1.0, p80 - p25)
            tier_score = 220.0 - 60.0 * min(1.0, dist)
        elif price > p80:
            tier_score = 120.0
        else:
            tier_score = 20.0

        # Small store-tier nudge so non-fast-fashion stores get fair consideration alongside Fashion Nova
        store_bonus = 40.0 if p.get("store") in ("Everlane", "Steve Madden", "Kith") else 0.0

        total = int(round(rating_term * 22.0 + tier_score + store_bonus))
        scores.append(total)

    return scores


def solve_capsule(
    spec: dict[str, Any],
    filtered_items: list[dict[str, Any]],
    previous_solution: dict[str, Any] | None = None,
) -> dict[str, Any]:
    t0 = time.time()

    days = spec.get("days") or []
    if not days:
        return {"ok": False, "infeasible": True, "reason": "spec has no days", "solve_s": 0.0}

    n_days = len(days)
    budget_usd = float(spec.get("budget_usd") or 450)
    budget_cents = int(round(budget_usd * 100))
    max_stores = int(spec.get("max_stores", 2))
    max_new_pieces = int(spec.get("max_new_pieces", 9))

    owned_pieces = build_owned_pieces(spec)
    new_pieces: list[dict[str, Any]] = []
    seen_ids: set[str] = {p["id"] for p in owned_pieces}

    # Include any previous fixed-day new pieces so fixed_days are always resolvable
    fixed_day_indices: set[int] = set()
    raw_fixed = spec.get("fixed_days") or []
    for fd in raw_fixed:
        if isinstance(fd, int) and 0 <= fd < n_days:
            fixed_day_indices.add(fd)
        elif isinstance(fd, str):
            for idx, d in enumerate(days):
                if (d.get("name") or "").lower() == fd.lower():
                    fixed_day_indices.add(idx)

    if previous_solution and fixed_day_indices:
        for p in previous_solution.get("pieces") or []:
            pid = p.get("id")
            if pid and pid not in seen_ids:
                rec = dict(p)
                rec["owned"] = False
                new_pieces.append(rec)
                seen_ids.add(pid)

    for it in filtered_items:
        pid = it.get("id")
        if not pid or pid in seen_ids:
            continue
        if it.get("slot") == "bag" and "baggy" in (it.get("title") or "").lower():
            continue
        rec = dict(it)
        rec["owned"] = False
        new_pieces.append(rec)
        seen_ids.add(pid)

    pool_stores = sorted({p["store"] for p in new_pieces if p.get("store")})
    all_pieces = owned_pieces + new_pieces
    n_owned = len(owned_pieces)
    n_all = len(all_pieces)
    new_indices = list(range(n_owned, n_all))
    id_to_idx = {p["id"]: i for i, p in enumerate(all_pieces)}

    # Slot index lists
    tops = [i for i, p in enumerate(all_pieces) if p["slot"] == "top"]
    reg_bottoms = [i for i, p in enumerate(all_pieces) if p["slot"] == "bottom"]
    swim_bottoms = [i for i, p in enumerate(all_pieces) if p["slot"] == "swim_shorts"]
    all_bottoms = reg_bottoms + swim_bottoms
    dresses = [i for i, p in enumerate(all_pieces) if p["slot"] == "dress"]
    shoes = [i for i, p in enumerate(all_pieces) if p["slot"] == "shoes"]
    layers = [i for i, p in enumerate(all_pieces) if p["slot"] == "layer"]
    acc_by_slot = {
        s: [i for i, p in enumerate(all_pieces) if p["slot"] == s]
        for s in ACCESSORY_SLOTS
    }

    stores = sorted({all_pieces[i]["store"] for i in new_indices})
    store_to_idx = {s: idx for idx, s in enumerate(stores)}

    model = cp_model.CpModel()
    chosen = [model.NewBoolVar(f"chosen_{i}") for i in range(n_all)]
    used = [[model.NewBoolVar(f"used_{d}_{i}") for i in range(n_all)] for d in range(n_days)]
    store_used = [model.NewBoolVar(f"store_{s}") for s in range(len(stores))]

    # Link used and chosen; every chosen piece must be used on >= 1 day
    for i in range(n_all):
        for d in range(n_days):
            model.Add(used[d][i] <= chosen[i])
        model.Add(sum(used[d][i] for d in range(n_days)) >= chosen[i])

    # Max new pieces
    model.Add(sum(chosen[i] for i in new_indices) <= max_new_pieces)

    # Budget ceiling (no spend floor: quality term drives taste without forcing purchases)
    prices_cents = [int(round(float(p["price_usd"]) * 100)) for p in all_pieces]
    total_cost_cents = model.NewIntVar(0, max(0, budget_cents), "total_cost_cents")
    model.Add(total_cost_cents == sum(prices_cents[i] * chosen[i] for i in new_indices))

    # Max distinct stores
    for i in new_indices:
        s_idx = store_to_idx[all_pieces[i]["store"]]
        model.Add(chosen[i] <= store_used[s_idx])
    if stores:
        model.Add(sum(store_used) <= max_stores)

    # Title-stem diversity cap: at most 2 new pieces with the same title stem
    stems: dict[str, list[int]] = {}
    for i in new_indices:
        st = title_stem(all_pieces[i].get("title", ""))
        if st:
            stems.setdefault(st, []).append(i)
    for idxs in stems.values():
        if len(idxs) > 2:
            model.Add(sum(chosen[i] for i in idxs) <= 2)

    # Cap optional new accessories (slots not explicitly required in any day's needs) to at most 2
    all_required_slots: set[str] = set()
    for day in days:
        for s in (day.get("needs") or []):
            all_required_slots.add(str(s).lower())
    optional_acc_new = [
        i for i in new_indices
        if all_pieces[i]["slot"] in ACCESSORY_SLOTS and all_pieces[i]["slot"] not in all_required_slots
    ]
    if len(optional_acc_new) > 2:
        model.Add(sum(chosen[i] for i in optional_acc_new) <= 2)

    # Fixed days from previous solution
    prev_outfits = (previous_solution or {}).get("outfits") or []
    for d in fixed_day_indices:
        if d < len(prev_outfits):
            fixed_pids = set(prev_outfits[d].get("piece_ids") or [])
            # Verify all fixed pieces exist in all_pieces
            missing = [pid for pid in fixed_pids if pid not in id_to_idx]
            if missing:
                return {
                    "ok": False,
                    "infeasible": True,
                    "reason": f"fixed day {d} references missing pieces: {missing}",
                    "solve_s": round(time.time() - t0, 3),
                    "pool_stores": pool_stores,
                }
            for i, p in enumerate(all_pieces):
                model.Add(used[d][i] == (1 if p["id"] in fixed_pids else 0))

    # Per-day slot & dress code constraints (for non-fixed days)
    for d, day in enumerate(days):
        if d in fixed_day_indices:
            continue

        dc = normalize_dress_code(day.get("dress_code"))
        needs = {str(s).lower() for s in (day.get("needs") or ["top", "bottom", "shoes"])}
        allow_swim = bool(
            day.get("allow_swim_bottom")
            or dc == "beach"
            or "swim_shorts" in needs
            or "beach" in (day.get("name") or "").lower()
            or "beach" in (day.get("notes") or "").lower()
        )
        is_formal_day = dc == "formal"

        if is_formal_day:
            # Disallow non-formal items on formal / black-tie-optional days
            for i, p in enumerate(all_pieces):
                if not p.get("formal"):
                    model.Add(used[d][i] == 0)

        if "dress" in needs:
            if not dresses:
                return {"ok": False, "infeasible": True, "reason": f"no dresses available for day {d+1}", "solve_s": round(time.time() - t0, 3), "pool_stores": pool_stores}
            model.Add(sum(used[d][i] for i in dresses) == 1)
            for i in tops + all_bottoms:
                model.Add(used[d][i] == 0)
        else:
            if "top" in needs:
                if not tops:
                    return {"ok": False, "infeasible": True, "reason": f"no tops available for day {d+1}", "solve_s": round(time.time() - t0, 3), "pool_stores": pool_stores}
                model.Add(sum(used[d][i] for i in tops) == 1)
            if "bottom" in needs or "swim_shorts" in needs:
                if allow_swim:
                    if not all_bottoms:
                        return {"ok": False, "infeasible": True, "reason": f"no bottoms available for day {d+1}", "solve_s": round(time.time() - t0, 3), "pool_stores": pool_stores}
                    model.Add(sum(used[d][i] for i in all_bottoms) == 1)
                else:
                    if not reg_bottoms:
                        return {"ok": False, "infeasible": True, "reason": f"no regular bottoms available for day {d+1}", "solve_s": round(time.time() - t0, 3), "pool_stores": pool_stores}
                    model.Add(sum(used[d][i] for i in reg_bottoms) == 1)
                    for i in swim_bottoms:
                        model.Add(used[d][i] == 0)

        if "shoes" in needs:
            if not shoes:
                return {"ok": False, "infeasible": True, "reason": f"no shoes available for day {d+1}", "solve_s": round(time.time() - t0, 3), "pool_stores": pool_stores}
            model.Add(sum(used[d][i] for i in shoes) == 1)
            # Taste rule (a): on a beach day, shoes MUST be sandals/slides/espadrilles when any exist in pool;
            # loafers and dress shoes are excluded for beach days.
            if dc == "beach" or allow_swim:
                beach_shoes = [i for i in shoes if is_beach_shoe(all_pieces[i])]
                if beach_shoes:
                    for i in shoes:
                        if i not in beach_shoes:
                            model.Add(used[d][i] == 0)
                else:
                    non_dress_shoes = [i for i in shoes if not is_dress_or_loafer_shoe(all_pieces[i])]
                    if non_dress_shoes:
                        for i in shoes:
                            if is_dress_or_loafer_shoe(all_pieces[i]):
                                model.Add(used[d][i] == 0)

        # Taste rule (b): never buy a piece in a slot where an OWNED piece already satisfies
        # that day's dress code, unless the day/spec explicitly asks for a new one in that slot.
        buy_new_slots = {
            str(s).lower()
            for s in (list(spec.get("buy_new_slots") or []) + list(day.get("buy_new_slots") or []))
        }
        day_notes_low = f"{day.get('name') or ''} {day.get('notes') or ''}".lower()
        for slot_check, slot_indices in (
            ("layer", layers),
            ("dress", dresses),
            ("shoes", shoes),
            ("top", tops),
            ("bottom", reg_bottoms),
        ):
            if slot_check not in needs or slot_check in buy_new_slots:
                continue
            if f"new {slot_check}" in day_notes_low or (slot_check == "layer" and "new jacket" in day_notes_low):
                continue
            # For top/bottom on casual days, multiple days require distinct (top, bottom) pairs,
            # so only lock owned top/bottom on smart_casual/formal days; always lock owned layer/dress/shoes
            # whenever an owned piece satisfies that day's dress code.
            if slot_check in ("top", "bottom") and dc not in ("smart_casual", "formal"):
                continue
            eligible_owned = [
                i for i in slot_indices
                if all_pieces[i].get("owned") and owned_satisfies_day(all_pieces[i], dc, allow_swim)
            ]
            if eligible_owned:
                for i in slot_indices:
                    if not all_pieces[i].get("owned"):
                        model.Add(used[d][i] == 0)

        if "layer" in needs:
            if not layers:
                return {"ok": False, "infeasible": True, "reason": f"no layers available for day {d+1}", "solve_s": round(time.time() - t0, 3), "pool_stores": pool_stores}
            model.Add(sum(used[d][i] for i in layers) == 1)
        elif layers:
            if dc in ("beach", "casual"):
                # Don't pile extra jackets/blazers onto warm daytime or beach days unless requested
                for i in layers:
                    model.Add(used[d][i] == 0)
            else:
                model.Add(sum(used[d][i] for i in layers) <= 1)

        if dc == "beach":
            # Avoid dress shirts on beach days when casual tops exist
            non_dress_tops = [i for i in tops if "dress shirt" not in (all_pieces[i].get("title") or "").lower()]
            if non_dress_tops:
                for i in tops:
                    if "dress shirt" in (all_pieces[i].get("title") or "").lower():
                        model.Add(used[d][i] == 0)

        # Keep a tie on men's black-tie / black-tie-optional dinners whenever a real formal tie is in the pool
        gender_low = (spec.get("gender") or "men").strip().lower()
        formal_ties = [i for i in acc_by_slot["tie"] if all_pieces[i].get("formal")]
        require_tie_for_formal = is_formal_day and gender_low == "men" and len(formal_ties) > 0

        for acc_slot in ACCESSORY_SLOTS:
            idxs = acc_by_slot[acc_slot]
            if acc_slot in needs or (acc_slot == "tie" and require_tie_for_formal):
                if not idxs:
                    return {"ok": False, "infeasible": True, "reason": f"no {acc_slot} available for day {d+1}", "solve_s": round(time.time() - t0, 3), "pool_stores": pool_stores}
                model.Add(sum(used[d][i] for i in idxs) == 1)
            elif idxs:
                # Only pack accessories explicitly requested in a day's needs (or owned accessories)
                for i in idxs:
                    if not all_pieces[i].get("owned"):
                        model.Add(used[d][i] == 0)

    # No two days repeat the same (top, bottom) pair
    for d1 in range(n_days):
        for d2 in range(d1 + 1, n_days):
            for t_i in tops:
                for b_i in all_bottoms:
                    model.Add(used[d1][t_i] + used[d1][b_i] + used[d2][t_i] + used[d2][b_i] <= 3)

    # Leather shoes + leather belt color family match on every day
    leather_shoes = [i for i in shoes if all_pieces[i].get("is_leather")]
    leather_belts = [i for i in acc_by_slot["belt"] if all_pieces[i].get("is_leather")]
    for d in range(n_days):
        for s_i in leather_shoes:
            sf = get_color_family(all_pieces[s_i])
            for b_i in leather_belts:
                bf = get_color_family(all_pieces[b_i])
                if sf != bf or sf == "other":
                    model.Add(used[d][s_i] + used[d][b_i] <= 1)

    # Mix-and-match count = max(0, n_T * n_B * n_S - n_days)
    if tops and all_bottoms and shoes:
        n_T = model.NewIntVar(0, len(tops), "n_T")
        n_B = model.NewIntVar(0, len(all_bottoms), "n_B")
        n_S = model.NewIntVar(0, len(shoes), "n_S")
        model.Add(n_T == sum(chosen[i] for i in tops))
        model.Add(n_B == sum(chosen[i] for i in all_bottoms))
        model.Add(n_S == sum(chosen[i] for i in shoes))

        prod_TB = model.NewIntVar(0, len(tops) * len(all_bottoms), "prod_TB")
        model.AddMultiplicationEquality(prod_TB, [n_T, n_B])
        prod_TBS = model.NewIntVar(0, len(tops) * len(all_bottoms) * len(shoes), "prod_TBS")
        model.AddMultiplicationEquality(prod_TBS, [prod_TB, n_S])

        mix_and_match = model.NewIntVar(0, max(0, len(tops) * len(all_bottoms) * len(shoes)), "mix_and_match")
        model.AddMaxEquality(mix_and_match, [0, prod_TBS - n_days])
    else:
        mix_and_match = model.NewIntVar(0, 0, "mix_and_match")

    # Quality + style coherence objective (no spend floor; quality drives taste)
    quality_scores = compute_quality_scores(new_pieces, budget_usd)
    obj_terms = [8 * mix_and_match]
    for k, i in enumerate(new_indices):
        slot = all_pieces[i]["slot"]
        # Unrequested optional accessories should not displace core garments or fill piece slots
        luggage_pen = 950 if (slot in ACCESSORY_SLOTS and slot not in all_required_slots) else 360
        obj_terms.append((quality_scores[k] - luggage_pen) * chosen[i])

    for d, day in enumerate(days):
        if d in fixed_day_indices:
            continue
        dc = normalize_dress_code(day.get("dress_code"))
        for i, p in enumerate(all_pieces):
            title_low = (p.get("title") or "").lower()
            slot = p["slot"]
            if dc == "beach":
                if slot == "swim_shorts":
                    obj_terms.append(160 * used[d][i])
                if slot == "shoes" and any(w in title_low for w in ("sandal", "slide", "espadrille")):
                    obj_terms.append(120 * used[d][i])
                if slot in ("sunglasses", "hat"):
                    obj_terms.append(60 * used[d][i])
            elif dc == "casual":
                if slot == "top" and any(w in title_low for w in ("linen", "oxford", "polo", "camp", "button")):
                    obj_terms.append(110 * used[d][i])
                if slot == "shoes" and any(w in title_low for w in ("sneaker", "loafer", "runner", "court")):
                    obj_terms.append(100 * used[d][i])
                if slot == "shoes" and any(w in title_low for w in ("slide", "mule", "flip")):
                    obj_terms.append(-120 * used[d][i])
            elif dc == "smart_casual":
                if p.get("owned") and slot in ("layer", "bottom", "shoes", "top"):
                    obj_terms.append(160 * used[d][i])
                if slot == "layer" and any(w in title_low for w in ("linen", "blazer", "suit", "overshirt", "jacket")):
                    obj_terms.append(120 * used[d][i])
                if slot == "shoes" and any(w in title_low for w in ("loafer", "oxford", "derby", "sneaker")):
                    obj_terms.append(90 * used[d][i])
                if slot == "shoes" and any(w in title_low for w in ("slide", "sandal", "flip")):
                    obj_terms.append(-200 * used[d][i])
                if slot == "bottom" and any(w in title_low for w in ("trouser", "chino", "pant", "suit")):
                    obj_terms.append(100 * used[d][i])
            elif dc == "formal":
                if p.get("formal"):
                    obj_terms.append(150 * used[d][i])

    model.Maximize(sum(obj_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10.0
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    solve_s = round(time.time() - t0, 3)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            "ok": False,
            "infeasible": True,
            "reason": f"CP-SAT {solver.StatusName(status)} (budget=${budget_usd:.2f}, max_stores={max_stores}, max_new_pieces={max_new_pieces})",
            "solve_s": solve_s,
            "solver_used": "ortools-cpsat",
            "pool_stores": pool_stores,
        }

    chosen_new_pieces: list[dict[str, Any]] = []
    chosen_owned_pieces: list[dict[str, Any]] = []
    for i, p in enumerate(all_pieces):
        if solver.Value(chosen[i]) == 1:
            if p.get("owned"):
                chosen_owned_pieces.append(p)
            else:
                chosen_new_pieces.append({
                    "slot": p["slot"],
                    "raw_slot": p.get("raw_slot", p["slot"]),
                    "formal": bool(p.get("formal", False)),
                    "title": p["title"],
                    "store": p["store"],
                    "store_domain": p["store_domain"],
                    "price_usd": p["price_usd"],
                    "url": p["url"],
                    "image": p.get("image", ""),
                    "id": p["id"],
                    "variant_id": p["variant_id"],
                    "size_label": p["size_label"],
                    "color_words": p.get("color_words", []),
                    "is_leather": bool(p.get("is_leather", False)),
                    "rating": p.get("rating"),
                    "rating_count": p.get("rating_count"),
                })

    outfits: list[dict[str, Any]] = []
    for d, day in enumerate(days):
        if d in fixed_day_indices and d < len(prev_outfits):
            day_pids = list(prev_outfits[d]["piece_ids"])
            day_new_usd = round(
                sum(float(all_pieces[id_to_idx[pid]]["price_usd"]) for pid in day_pids if not all_pieces[id_to_idx[pid]].get("owned")),
                2,
            )
        else:
            day_pids = []
            day_new_usd = 0.0
            for i, p in enumerate(all_pieces):
                if solver.Value(used[d][i]) == 1:
                    day_pids.append(p["id"])
                    if not p.get("owned"):
                        day_new_usd += float(p["price_usd"])
            day_new_usd = round(day_new_usd, 2)
        outfits.append({
            "day": day.get("name") or f"Day {d + 1}",
            "dress_code": day.get("dress_code") or "casual",
            "notes": day.get("notes") or "",
            "piece_ids": day_pids,
            "total_new_usd": day_new_usd,
        })

    total_usd = round(sum(float(p["price_usd"]) for p in chosen_new_pieces), 2)
    chosen_stores = sorted({p["store"] for p in chosen_new_pieces})
    mix_val = int(solver.Value(mix_and_match))

    print(
        f"STEP: solved: {len(chosen_new_pieces)} pieces, {len(outfits)} outfits (${total_usd:.2f}, {len(chosen_stores)} store(s), {solve_s:.2f}s)",
        flush=True,
    )

    return {
        "ok": True,
        "infeasible": False,
        "pieces": chosen_new_pieces,
        "owned_pieces_used": chosen_owned_pieces,
        "outfits": outfits,
        "total_usd": total_usd,
        "stores": chosen_stores,
        "mix_and_match_count": mix_val,
        "solve_s": solve_s,
        "solver_used": "ortools-cpsat",
        "solver_status": solver.StatusName(status),
        "pool_stores": pool_stores,
    }


def run_self_test() -> dict[str, Any]:
    """Local unit self-test for CP-SAT solver without any network calls."""
    spec = {
        "gender": "men",
        "sizes": {"top": "M", "bottom": "32", "shoes": "10"},
        "days": [
            {"name": "Day 1 - City", "dress_code": "casual", "needs": ["top", "bottom", "shoes"]},
            {"name": "Day 2 - Beach", "dress_code": "beach", "needs": ["top", "bottom", "shoes"], "allow_swim_bottom": True},
            {"name": "Day 3 - Dinner", "dress_code": "smart_casual", "needs": ["top", "bottom", "shoes", "layer"]},
        ],
        "owned": [
            {"slot": "layer", "description": "navy linen suit jacket", "colour": "navy", "formal": False},
            {"slot": "bottom", "description": "navy linen suit trousers", "colour": "navy", "formal": False},
            {"slot": "shoes", "description": "brown leather loafers", "colour": "brown", "leather": True, "formal": False},
            {"slot": "top", "description": "white dress shirt", "colour": "white", "formal": True},
        ],
        "budget_usd": 350,
        "max_stores": 2,
        "max_new_pieces": 6,
    }
    pool = [
        # Three cheap tees with identical stem (must be capped at <=2 and penalized)
        {"id": "p1", "variant_id": "v1", "slot": "top", "title": "Everyday Classic Tee - White", "store": "Fashion Nova", "store_domain": "fnova.myshopify.com", "price_usd": 7.0, "url": "https://fashionnova.com/1", "size_label": "M", "color_words": ["white"], "is_leather": False, "rating": 3.5, "rating_count": 5},
        {"id": "p2", "variant_id": "v2", "slot": "top", "title": "Everyday Classic Tee - Black", "store": "Fashion Nova", "store_domain": "fnova.myshopify.com", "price_usd": 7.0, "url": "https://fashionnova.com/2", "size_label": "M", "color_words": ["black"], "is_leather": False, "rating": 3.5, "rating_count": 5},
        {"id": "p3", "variant_id": "v3", "slot": "top", "title": "Everyday Classic Tee - Grey", "store": "Fashion Nova", "store_domain": "fnova.myshopify.com", "price_usd": 7.0, "url": "https://fashionnova.com/3", "size_label": "M", "color_words": ["grey"], "is_leather": False, "rating": 3.5, "rating_count": 5},
        # Quality mid-range shirts
        {"id": "p4", "variant_id": "v4", "slot": "top", "title": "Organic Linen Camp Shirt - Ecru", "store": "Everlane", "store_domain": "m34kzg-ke.myshopify.com", "price_usd": 68.0, "url": "https://everlane.com/4", "size_label": "M", "color_words": ["ecru"], "is_leather": False, "rating": 4.8, "rating_count": 140},
        {"id": "p5", "variant_id": "v5", "slot": "top", "title": "Pique Knit Polo - Navy", "store": "Everlane", "store_domain": "m34kzg-ke.myshopify.com", "price_usd": 58.0, "url": "https://everlane.com/5", "size_label": "M", "color_words": ["navy"], "is_leather": False, "rating": 4.7, "rating_count": 90},
        # Bottoms & swim
        {"id": "p6", "variant_id": "v6", "slot": "bottom", "title": "Slim Chino Pant - Khaki", "store": "Everlane", "store_domain": "m34kzg-ke.myshopify.com", "price_usd": 78.0, "url": "https://everlane.com/6", "size_label": "32", "color_words": ["khaki"], "is_leather": False, "rating": 4.7, "rating_count": 210},
        {"id": "p7", "variant_id": "v7", "slot": "swim_shorts", "title": "Recycled Swim Trunk - Olive", "store": "Everlane", "store_domain": "m34kzg-ke.myshopify.com", "price_usd": 48.0, "url": "https://everlane.com/7", "size_label": "M", "color_words": ["olive"], "is_leather": False, "rating": 4.6, "rating_count": 55},
        # High-rated loafer vs lower-rated slide -> rule (a) must force slide on beach day
        {"id": "p8", "variant_id": "v8", "slot": "shoes", "title": "Italian Leather Loafer - Tan", "store": "Steve Madden", "store_domain": "stevemadden.myshopify.com", "price_usd": 89.0, "url": "https://stevemadden.com/8", "size_label": "10", "color_words": ["tan"], "is_leather": True, "rating": 4.9, "rating_count": 500},
        {"id": "p11", "variant_id": "v11", "slot": "shoes", "raw_slot": "sandals", "title": "Resort Leather Slides - Black", "store": "Steve Madden", "store_domain": "stevemadden.myshopify.com", "price_usd": 45.0, "url": "https://stevemadden.com/11", "size_label": "10", "color_words": ["black"], "is_leather": False, "rating": 4.3, "rating_count": 30},
        # High-rated new blazer -> rule (b) must NOT buy it because owned navy linen jacket satisfies smart_casual dinner
        {"id": "p12", "variant_id": "v12", "slot": "layer", "title": "Tailored Wool Blazer - Charcoal", "store": "Everlane", "store_domain": "m34kzg-ke.myshopify.com", "price_usd": 120.0, "url": "https://everlane.com/12", "size_label": "M", "color_words": ["charcoal"], "is_leather": False, "rating": 4.9, "rating_count": 400},
        # Formal pieces for BTO test
        {"id": "p13", "variant_id": "v13", "slot": "layer", "formal": True, "title": "Black Tuxedo Blazer - Black", "store": "Everlane", "store_domain": "m34kzg-ke.myshopify.com", "price_usd": 120.0, "url": "https://everlane.com/13", "size_label": "M", "color_words": ["black"], "is_leather": False, "rating": 4.8, "rating_count": 120},
        {"id": "p14", "variant_id": "v14", "slot": "bottom", "formal": True, "title": "Black Dress Trousers - Black", "store": "Everlane", "store_domain": "m34kzg-ke.myshopify.com", "price_usd": 75.0, "url": "https://everlane.com/14", "size_label": "32", "color_words": ["black"], "is_leather": False, "rating": 4.7, "rating_count": 80},
        {"id": "p15", "variant_id": "v15", "slot": "shoes", "formal": True, "title": "Black Leather Oxford - Black", "store": "Steve Madden", "store_domain": "stevemadden.myshopify.com", "price_usd": 85.0, "url": "https://stevemadden.com/15", "size_label": "10", "color_words": ["black"], "is_leather": True, "rating": 4.8, "rating_count": 95},
        {"id": "p16", "variant_id": "v16", "slot": "tie", "formal": True, "title": "Silk Neck Tie - Black", "store": "Everlane", "store_domain": "m34kzg-ke.myshopify.com", "price_usd": 45.0, "url": "https://everlane.com/16", "size_label": "OS", "color_words": ["black"], "is_leather": False, "rating": 4.7, "rating_count": 60},
    ]
    res = solve_capsule(spec, pool)
    assert res["ok"], f"self-test solve failed: {res}"
    assert res["total_usd"] <= 350.0, f"exceeded budget: {res['total_usd']}"
    assert len(res["stores"]) <= 2, f"too many stores: {res['stores']}"
    chosen_ids = {p["id"] for p in res["pieces"]}
    # Taste rule (a): beach day MUST wear slides (p11), NEVER loafers
    beach_pids = set(res["outfits"][1]["piece_ids"])
    assert "p11" in beach_pids, f"beach day must pick slides p11, got {beach_pids}"
    assert "p8" not in beach_pids and "owned:brown_leather_loafers" not in beach_pids, f"beach day must not wear loafers: {beach_pids}"
    # Taste rule (b): dinner day MUST use owned navy linen jacket, NEVER buy p12
    assert "p12" not in chosen_ids, f"should not buy new blazer p12 when owned jacket satisfies dinner: {chosen_ids}"
    dinner_pids = set(res["outfits"][2]["piece_ids"])
    assert "owned:navy_linen_suit_jacket" in dinner_pids, f"dinner must use owned jacket: {dinner_pids}"
    # Quality & stem diversity
    assert "p4" in chosen_ids, f"expected quality linen shirt p4 in {chosen_ids}"
    assert not ({"p1", "p2", "p3"}.issubset(chosen_ids)), "stem cap failed: picked all 3 identical tees"

    # Rule (b) formal check + tie check: when dinner becomes black_tie_optional, owned casual jacket (formal=False) does NOT
    # satisfy formal, so solver MUST buy formal blazer p13 + formal tie p16 while STILL using owned formal white dress shirt!
    formal_spec = dict(spec)
    formal_spec["budget_usd"] = 500
    formal_spec["max_new_pieces"] = 9
    formal_spec["days"] = [
        spec["days"][0],
        spec["days"][1],
        {"name": "Day 3 - Dinner", "dress_code": "black_tie_optional", "needs": ["top", "bottom", "shoes", "layer"]},
    ]
    formal_res = solve_capsule(formal_spec, pool)
    assert formal_res["ok"], f"formal self-test failed: {formal_res}"
    formal_dinner_pids = set(formal_res["outfits"][2]["piece_ids"])
    assert "p13" in formal_dinner_pids, f"formal dinner must buy formal blazer p13: {formal_dinner_pids}"
    assert "p16" in formal_dinner_pids, f"formal dinner must keep real tie p16 when in pool: {formal_dinner_pids}"
    assert "owned:white_dress_shirt" in formal_dinner_pids, f"formal dinner must keep owned formal white dress shirt: {formal_dinner_pids}"

    return {"self_test": "ok", "total_usd": res["total_usd"], "pieces": len(res["pieces"]), "solve_s": res["solve_s"]}


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        print(json.dumps(run_self_test()))

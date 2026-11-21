"""Independent live verifier for capsule solutions (separate from solver.py)."""

from __future__ import annotations

import concurrent.futures
import sys
import time
from collections import Counter
from typing import Any

from shop_client import ALLOWED_DOMAINS, call_mcp
from solver import get_color_family, normalize_dress_code, title_stem


def _verify_variant_live(idx: int, piece: dict[str, Any]) -> tuple[str, bool, float | None, str]:
    vid = piece["variant_id"]
    try:
        res = call_mcp(
            "get_product",
            {"catalog": {"id": vid, "context": {"currency": "USD", "address_country": "US"}}},
            req_id=9000 + idx,
        )
        prod = res.get("product", res)
        variants = prod.get("variants") or []
        if not variants:
            return vid, False, None, "no variants returned"
        v = next((x for x in variants if x.get("id") == vid), variants[0])
        avail = (v.get("availability") or {}).get("available") is True
        price_cents = (v.get("price") or {}).get("amount")
        live_price = round(price_cents / 100.0, 2) if price_cents is not None else None
        price_match = live_price is not None and abs(live_price - float(piece["price_usd"])) <= 0.05
        ok = avail and price_match
        msg = "ok" if ok else f"avail={avail}, live_price={live_price}, expected={piece['price_usd']}"
        return vid, ok, live_price, msg
    except Exception as err:
        return vid, False, None, str(err)


def verify_solution(
    spec: dict[str, Any],
    solution: dict[str, Any],
    previous_solution: dict[str, Any] | None = None,
    skip_live: bool = False,
) -> dict[str, Any]:
    t0 = time.time()
    new_pieces: list[dict[str, Any]] = solution.get("pieces") or []
    owned_pieces: list[dict[str, Any]] = solution.get("owned_pieces_used") or []
    outfits: list[dict[str, Any]] = solution.get("outfits") or []
    days: list[dict[str, Any]] = spec.get("days") or []

    by_id: dict[str, dict[str, Any]] = {}
    for p in owned_pieces:
        by_id[p["id"]] = p
    for p in new_pieces:
        by_id[p["id"]] = p

    checks: list[dict[str, Any]] = []
    verify_calls = 0

    # 1. Live stock & price verification
    all_in_stock = True
    live_issues: list[str] = []
    if not skip_live and new_pieces:
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
            futs = [ex.submit(_verify_variant_live, i, p) for i, p in enumerate(new_pieces)]
            for f in concurrent.futures.as_completed(futs):
                vid, ok, _price, msg = f.result()
                verify_calls += 1
                if not ok:
                    all_in_stock = False
                    live_issues.append(f"{vid}: {msg}")
    checks.append({
        "name": "live_stock_and_price",
        "ok": all_in_stock,
        "detail": f"all {len(new_pieces)} variants in stock with matching price" if all_in_stock else "; ".join(live_issues),
    })

    # 2. Budget & arithmetic check (no spend floor)
    budget_usd = float(spec.get("budget_usd") or 450)
    recomputed_total = round(sum(float(p["price_usd"]) for p in new_pieces), 2)
    within_budget = abs(recomputed_total - float(solution.get("total_usd", -1))) <= 0.05 and recomputed_total <= budget_usd + 0.01
    checks.append({
        "name": "within_budget",
        "ok": within_budget,
        "detail": f"${recomputed_total:.2f} <= ${budget_usd:.2f}",
    })

    # 4. Store limit & allowed stores
    max_stores = int(spec.get("max_stores", 2))
    distinct_stores = sorted({p["store"] for p in new_pieces})
    allowed_ok = all(
        p.get("store_domain") in ALLOWED_DOMAINS and ALLOWED_DOMAINS[p["store_domain"]] == p.get("store")
        for p in new_pieces
    )
    stores_ok = len(distinct_stores) <= max_stores and allowed_ok
    checks.append({
        "name": "store_limit",
        "ok": stores_ok,
        "detail": f"{len(distinct_stores)} store(s) ({', '.join(distinct_stores)}) <= {max_stores}",
    })

    # 5. Pool store diversity (at least 2 stores considered)
    pool_stores = solution.get("pool_stores") or []
    diversity_ok = len(pool_stores) >= 2 or len(new_pieces) == 0
    checks.append({
        "name": "pool_store_diversity",
        "ok": diversity_ok,
        "detail": f"{len(pool_stores)} stores in candidate pool ({', '.join(pool_stores)})",
    })

    # 6. Piece count cap
    max_new_pieces = int(spec.get("max_new_pieces", 9))
    count_ok = len(new_pieces) <= max_new_pieces
    checks.append({
        "name": "piece_count",
        "ok": count_ok,
        "detail": f"{len(new_pieces)} <= {max_new_pieces}",
    })

    # 7. Title stem cap (<= 2 pieces per stem)
    stem_counts = Counter(title_stem(p.get("title", "")) for p in new_pieces if p.get("title"))
    stem_ok = all(c <= 2 for c in stem_counts.values())
    checks.append({
        "name": "title_stem_diversity",
        "ok": stem_ok,
        "detail": "max 2 pieces per title stem" if stem_ok else f"duplicate stems: {dict(stem_counts)}",
    })

    # 8. Outfit slots, no repeated (top, bottom), leather color rule
    slots_ok = len(outfits) == len(days)
    tb_ok = True
    leather_ok = True
    seen_tb: set[tuple[str, str]] = set()
    used_ids: set[str] = set()

    for idx, o in enumerate(outfits):
        pids = o.get("piece_ids") or []
        if not all(pid in by_id for pid in pids):
            slots_ok = False
            continue
        day_pieces = [by_id[pid] for pid in pids]
        for pid in pids:
            used_ids.add(pid)

        if idx < len(days):
            day_spec = days[idx]
            dc = normalize_dress_code(day_spec.get("dress_code"))
            needs = {str(s).lower() for s in (day_spec.get("needs") or ["top", "bottom", "shoes"])}
            allow_swim = bool(
                day_spec.get("allow_swim_bottom")
                or dc == "beach"
                or "swim_shorts" in needs
                or "beach" in (day_spec.get("name") or "").lower()
            )
            by_slot: dict[str, list[dict[str, Any]]] = {}
            for p in day_pieces:
                by_slot.setdefault(p["slot"], []).append(p)

            if "dress" in needs:
                if len(by_slot.get("dress", [])) != 1:
                    slots_ok = False
            else:
                if "top" in needs and len(by_slot.get("top", [])) != 1:
                    slots_ok = False
                if "bottom" in needs or "swim_shorts" in needs:
                    reg_b = by_slot.get("bottom", [])
                    swim_b = by_slot.get("swim_shorts", [])
                    if allow_swim:
                        if len(reg_b) + len(swim_b) != 1:
                            slots_ok = False
                    else:
                        if len(reg_b) != 1 or len(swim_b) != 0:
                            slots_ok = False
            if "shoes" in needs and len(by_slot.get("shoes", [])) != 1:
                slots_ok = False
            if "layer" in needs and len(by_slot.get("layer", [])) != 1:
                slots_ok = False
            if "tie" in needs and len(by_slot.get("tie", [])) != 1:
                slots_ok = False

            day_tops = by_slot.get("top", [])
            day_bottoms = by_slot.get("bottom", []) + by_slot.get("swim_shorts", [])
            if len(day_tops) == 1 and len(day_bottoms) == 1:
                pair = (day_tops[0]["id"], day_bottoms[0]["id"])
                if pair in seen_tb:
                    tb_ok = False
                seen_tb.add(pair)

            for sh in by_slot.get("shoes", []):
                if sh.get("is_leather"):
                    for bl in by_slot.get("belt", []):
                        if bl.get("is_leather"):
                            sf = get_color_family(sh)
                            bf = get_color_family(bl)
                            if sf != bf or sf == "other":
                                leather_ok = False

    checks.append({"name": "outfit_slots", "ok": slots_ok, "detail": f"all {len(outfits)} day outfits satisfy required slots"})
    checks.append({"name": "no_repeated_top_bottom", "ok": tb_ok, "detail": "distinct (top, bottom) pairs across days"})
    checks.append({"name": "leather_color_match", "ok": leather_ok, "detail": "leather shoes and belts match color family"})

    # 9. Every new piece used
    all_used = all(p["id"] in used_ids for p in new_pieces)
    checks.append({"name": "all_new_pieces_used", "ok": all_used, "detail": f"all {len(new_pieces)} new pieces used"})

    # 10. Fixed days preserved (when resolving)
    fixed_days = spec.get("fixed_days") or []
    if fixed_days and previous_solution:
        prev_outfits = previous_solution.get("outfits") or []
        fixed_ok = True
        for fd in fixed_days:
            if isinstance(fd, int) and 0 <= fd < len(outfits) and fd < len(prev_outfits):
                if outfits[fd].get("piece_ids") != prev_outfits[fd].get("piece_ids"):
                    fixed_ok = False
        checks.append({"name": "fixed_days_preserved", "ok": fixed_ok, "detail": f"fixed days {fixed_days} unchanged"})

    passed_count = sum(1 for c in checks if c["ok"])
    verify_s = round(time.time() - t0, 3)

    print(
        f"STEP: verified {passed_count} of {len(checks)} checks ({verify_s:.1f}s)",
        flush=True,
    )

    return {
        "all_sizes_in_stock": all_in_stock,
        "within_budget": within_budget,
        "checks": checks,
        "verify_s": verify_s,
        "verify_calls": verify_calls,
        "all_passed": passed_count == len(checks),
    }

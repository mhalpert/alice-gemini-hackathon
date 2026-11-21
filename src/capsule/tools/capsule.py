#!/usr/bin/env python3
"""Spec-driven capsule packing pipeline: fetch -> size check -> CP-SAT solve -> live verify.

Usage:
  python3 capsule.py run spec.json [--state-dir /workspace/capsule_state]
  python3 capsule.py resolve spec.json [--state-dir /workspace/capsule_state]
  python3 capsule.py self-test
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

# Ensure sibling modules are importable regardless of cwd
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from shop_client import fetch_and_check_pool
from solver import run_self_test, solve_capsule
from verifier import verify_solution


def _read_json(path: str) -> dict[str, Any] | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def run_pipeline(mode: str, spec_path: str, state_dir: str) -> dict[str, Any]:
    t_total = time.time()
    spec = _read_json(spec_path)
    if not spec:
        return {"ok": False, "infeasible": False, "error": f"Could not read spec file: {spec_path}"}

    os.makedirs(state_dir, exist_ok=True)
    raw_path = os.path.join(state_dir, "pool_raw.json")
    filtered_path = os.path.join(state_dir, "pool_filtered.json")
    sol_path = os.path.join(state_dir, "solution.json")
    cert_path = os.path.join(state_dir, "certificate.json")
    last_spec_path = os.path.join(state_dir, "last_spec.json")

    reuse = mode == "resolve"
    existing_raw = _read_json(raw_path) if reuse else None
    existing_filtered = _read_json(filtered_path) if reuse else None
    prev_solution = _read_json(sol_path) if reuse else None

    pool_res = fetch_and_check_pool(
        spec,
        existing_raw=existing_raw,
        existing_filtered=existing_filtered,
        reuse=reuse,
    )
    _write_json(raw_path, pool_res["raw_state"])
    _write_json(filtered_path, pool_res["filtered_state"])

    sol = solve_capsule(
        spec,
        pool_res["filtered_state"]["items"],
        previous_solution=prev_solution,
    )

    if not sol.get("ok"):
        fail_payload = {
            "ok": False,
            "infeasible": bool(sol.get("infeasible")),
            "error": sol.get("reason", "solver failed"),
            "searched": pool_res["searched"],
            "candidates_checked": pool_res["candidates_checked"],
            "timings": {
                "fetch_s": pool_res["fetch_s"],
                "size_check_s": pool_res["size_check_s"],
                "solve_s": sol.get("solve_s", 0.0),
                "verify_s": 0.0,
                "total_s": round(time.time() - t_total, 3),
            },
            "mcp_calls": {
                "search": pool_res["search_calls"],
                "size_check": pool_res["size_check_calls"],
                "verify": 0,
                "total": pool_res["search_calls"] + pool_res["size_check_calls"],
            },
        }
        _write_json(os.path.join(state_dir, "final_output.json"), fail_payload)
        return fail_payload

    cert = verify_solution(spec, sol, previous_solution=prev_solution)
    _write_json(sol_path, sol)
    _write_json(cert_path, cert)
    _write_json(last_spec_path, spec)

    total_s = round(time.time() - t_total, 3)
    search_calls = pool_res["search_calls"]
    size_calls = pool_res["size_check_calls"]
    verify_calls = cert["verify_calls"]

    final_payload = {
        "ok": bool(cert["all_passed"]),
        "infeasible": False,
        "pieces": [
            {
                "slot": p["slot"],
                "title": p["title"],
                "store": p["store"],
                "store_domain": p["store_domain"],
                "price_usd": p["price_usd"],
                "url": p["url"],
                "id": p["id"],
                "variant_id": p["variant_id"],
                "size_label": p["size_label"],
            }
            for p in sol["pieces"]
        ],
        "owned_pieces_used": [
            {
                "id": p["id"],
                "slot": p["slot"],
                "title": p["title"],
                "size_label": p.get("size_label", ""),
            }
            for p in sol["owned_pieces_used"]
        ],
        "outfits": sol["outfits"],
        "total_usd": sol["total_usd"],
        "stores": sol["stores"],
        "mix_and_match_count": sol["mix_and_match_count"],
        "certificate": {
            "all_sizes_in_stock": cert["all_sizes_in_stock"],
            "within_budget": cert["within_budget"],
            "checks": [{"name": c["name"], "ok": c["ok"]} for c in cert["checks"]],
        },
        "searched": pool_res["searched"],
        "candidates_checked": pool_res["candidates_checked"],
        "solver_used": sol["solver_used"],
        "timings": {
            "fetch_s": pool_res["fetch_s"],
            "size_check_s": pool_res["size_check_s"],
            "solve_s": sol["solve_s"],
            "verify_s": cert["verify_s"],
            "total_s": total_s,
        },
        "mcp_calls": {
            "search": search_calls,
            "size_check": size_calls,
            "verify": verify_calls,
            "total": search_calls + size_calls + verify_calls,
        },
    }
    _write_json(os.path.join(state_dir, "final_output.json"), final_payload)
    return final_payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Spec-driven capsule packing pipeline")
    parser.add_argument("command", choices=["run", "resolve", "self-test"])
    parser.add_argument("spec", nargs="?", help="Path to spec.json")
    parser.add_argument(
        "--state-dir",
        default="/workspace/capsule_state",
        help="Directory for cached pool and previous solution",
    )
    parser.add_argument(
        "--print-json",
        action="store_true",
        help="Print full JSON to stdout instead of concise summary (full JSON is always saved to <state-dir>/final_output.json)",
    )
    args = parser.parse_args()

    if args.command == "self-test":
        out = run_self_test()
        print(json.dumps(out))
        return

    if not args.spec:
        print(json.dumps({"ok": False, "error": "Missing spec.json argument"}))
        sys.exit(1)

    result = run_pipeline(args.command, args.spec, args.state_dir)
    if args.print_json:
        print(json.dumps(result, separators=(",", ":")))
    else:
        if result.get("ok"):
            checks = result.get("certificate", {}).get("checks", [])
            passed = sum(1 for c in checks if c.get("ok"))
            pieces_summary = "; ".join(
                f"{p['slot']}: {p['title']} ({p['store']} ${p['price_usd']:.2f})"
                for p in result.get("pieces", [])
            )
            print(
                f"SUMMARY: ok=true total_usd={result['total_usd']} stores={result['stores']} "
                f"pieces={len(result.get('pieces', []))} outfits={len(result.get('outfits', []))} "
                f"checks={passed}/{len(checks)} saved={os.path.join(args.state_dir, 'final_output.json')}"
            )
            print(f"PIECES: {pieces_summary}")
        else:
            print(
                f"SUMMARY: ok=false infeasible={bool(result.get('infeasible'))} "
                f"error={result.get('error', 'unknown')} saved={os.path.join(args.state_dir, 'final_output.json')}"
            )


if __name__ == "__main__":
    main()

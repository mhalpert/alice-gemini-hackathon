# Capsule Packing Pipeline (`/workspace/capsule`)

Run one command to fetch live Shop MCP candidates, verify sizes, solve with OR-Tools CP-SAT, and independently live-verify every chosen piece.

## Commands

- Full pack (fresh fetch + size check + solve + live verify):
  ```bash
  python3 /workspace/capsule/capsule.py run spec.json
  ```
- Re-solve (reuses on-disk pool; fetches only new queries/slots needed by updated spec):
  ```bash
  python3 /workspace/capsule/capsule.py resolve spec.json
  ```

Progress lines print to `stderr`/`stdout` (`STEP: ...`), a short `SUMMARY:` line prints to `stdout`, and the full JSON result is always saved to `/workspace/capsule_state/final_output.json`.

## `spec.json` Schema

```json
{
  "gender": "men",
  "sizes": { "top": "M", "bottom": "32", "shoes": "US 10", "layer": "M" },
  "days": [
    { "name": "Day 1 - Daytime City", "dress_code": "casual", "needs": ["top", "bottom", "shoes"], "notes": "city" },
    { "name": "Day 2 - Daytime City", "dress_code": "casual", "needs": ["top", "bottom", "shoes"], "notes": "city" },
    { "name": "Day 3 - Beach Day", "dress_code": "beach", "needs": ["top", "bottom", "shoes"], "allow_swim_bottom": true, "notes": "beach" },
    { "name": "Day 4 - Dinner", "dress_code": "smart_casual", "needs": ["top", "bottom", "shoes", "layer"], "notes": "dinner" }
  ],
  "owned": [
    { "slot": "layer", "description": "navy linen suit jacket", "colour": "navy", "formal": false },
    { "slot": "bottom", "description": "navy linen suit trousers", "colour": "navy", "formal": false },
    { "slot": "shoes", "description": "brown leather loafers", "colour": "brown", "leather": true, "formal": false },
    { "slot": "top", "description": "white dress shirt", "colour": "white", "formal": true }
  ],
  "budget_usd": 450,
  "max_stores": 2,
  "max_new_pieces": 9,
  "queries": {},
  "excludes": [],
  "fixed_days": []
}
```

### If Infeasible
If `SUMMARY:` shows `ok=false infeasible=true`, relax in this exact order and re-run `resolve`:
1. Increase `max_new_pieces` by `+2`.
2. Increase `max_stores` by `+1`.
State what you relaxed in your two-sentence explanation.

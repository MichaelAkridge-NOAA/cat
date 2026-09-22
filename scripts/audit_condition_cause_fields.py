#!/usr/bin/env python3
"""Audit real-world values of rdcause1-3 and con_1-3 before converting them
to dropdowns (docs/team-lead-config-plan.md, Phase 4).

Both fields are described as "Cause"/"Condition" but are currently
FREE-TEXT, max-10-char inputs with no validation against any list
(annotation.html; annotation-runtime-annotations.js's inline table editor
and edit modal). Converting them to an enum without first seeing what
analysts have actually been typing would silently reject or corrupt
whatever doesn't match the guessed option list on the next edit of an
existing record — this script is that "look first" step, read-only,
touches nothing.

Usage:
    python scripts/audit_condition_cause_fields.py [--project-id ID]

Requires Oracle backend configured (same env as the running app).
"""
import argparse
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

FIELDS = ["rdcause1", "rdcause2", "rdcause3", "con_1", "con_2", "con_3"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-id", type=int, default=None, help="Limit to one project")
    args = ap.parse_args()

    from cat.db.config import is_oracle_backend_enabled
    from cat.db.oracle import fetch_all

    if not is_oracle_backend_enabled():
        print("Oracle backend not enabled (CAT_STORAGE_BACKEND=oracle) - nothing to audit.", file=sys.stderr)
        return 1

    where = "WHERE deleted_at IS NULL"
    params = {}
    if args.project_id is not None:
        where += " AND project_id = :pid"
        params["pid"] = args.project_id

    rows = fetch_all(f"SELECT properties_json FROM cat_annotations {where}", params)
    if not rows:
        print("No annotations found" + (f" for project {args.project_id}" if args.project_id else "") + ".")
        print("This audit needs real production data to be useful - run it against a live deployment.")
        return 0

    import json

    counters = {f: Counter() for f in FIELDS}
    total = 0
    for r in rows:
        total += 1
        try:
            props = json.loads(r["properties_json"]) if r.get("properties_json") else {}
        except (TypeError, ValueError):
            continue
        for f in FIELDS:
            v = props.get(f)
            if v is not None and str(v).strip() != "":
                counters[f][str(v).strip()] += 1

    print(f"Audited {total} annotation(s).\n")
    for f in FIELDS:
        c = counters[f]
        if not c:
            print(f"{f}: no values used")
            continue
        print(f"{f}: {len(c)} distinct value(s), {sum(c.values())} non-blank total")
        for value, count in c.most_common(30):
            print(f"    {value!r:>15}  x{count}")
        if len(c) > 30:
            print(f"    ... and {len(c) - 30} more distinct values")
        print()

    print(
        "Next step: turn each field's list above into a team-lead-configured\n"
        "option set the same way morph_code etc. work (cat_annotation_field_options),\n"
        "seeded with exactly these values so nothing already typed is rejected."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

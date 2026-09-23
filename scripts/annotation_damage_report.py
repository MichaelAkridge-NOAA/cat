#!/usr/bin/env python3
"""Read-only damage report for the pre-v17 annotation data-loss bugs.

Before cat_db_v17, two paths could destroy annotation data:

1. POST /annotations/bulk-replace (the tab-close save beacon and "Clear all")
   hard-DELETEd every annotation in a project — every user's, plus
   soft-deleted history — and re-inserted only the closing tab's copy, with
   new ids and created_by_user_id set to whoever closed the tab. Each call
   logged `annotations_bulk_replaced` with the resulting row count.
2. install_cat.sh wiped oracle-data/ if the Oracle container wasn't running
   when it was re-run (e.g. after a reboot).

This script touches nothing. It prints:
  - the earliest user/project/annotation rows (if these are newer than when
    the team started using CAT here, the database was wiped and re-created);
  - every bulk-replace event, per project, with the row count before/after
    where it can be inferred, and who triggered it;
  - whether Oracle Flashback can still see older rows for affected projects
    (only works inside the undo-retention window — usually hours, so run
    this as soon as possible).

Usage (inside the cat-app container, same env as the app):
    python scripts/annotation_damage_report.py [--project-id ID] [--flashback-minutes N]
"""
import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))


def _count_as_of(fetch_one, project_id, minutes):
    try:
        row = fetch_one(
            f"""
            SELECT COUNT(*) AS cnt
            FROM cat_annotations AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '{int(minutes)}' MINUTE)
            WHERE project_id = :project_id
            """,
            {"project_id": project_id},
        )
        return (row or {}).get("cnt"), None
    except Exception as exc:  # ORA-01555 / ORA-08180 = beyond retention
        return None, str(exc).splitlines()[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-id", type=int, default=None, help="Limit to one project")
    ap.add_argument(
        "--flashback-minutes",
        type=int,
        nargs="*",
        default=[60, 360, 1440],
        help="How far back to probe Flashback Query (default: 60 360 1440)",
    )
    args = ap.parse_args()

    from cat.db.config import is_oracle_backend_enabled
    from cat.db.oracle import fetch_all, fetch_one

    if not is_oracle_backend_enabled():
        print("Oracle backend not enabled (CAT_STORAGE_BACKEND=oracle).", file=sys.stderr)
        return 1

    print("=== Was the database re-initialised? ===")
    # v$database.created is useless here: the Oracle image ships a pre-built
    # database, so it shows the image build date. The CAT tables are created
    # on first app start, so the earliest CAT rows date the current database.
    first = fetch_one(
        """
        SELECT (SELECT MIN(created_at) FROM cat_users) AS first_user,
               (SELECT MIN(created_at) FROM cat_projects) AS first_project,
               (SELECT MIN(created_at) FROM cat_annotations) AS first_annotation
        FROM dual
        """
    ) or {}
    print(f"  first user row       = {first.get('first_user')}")
    print(f"  first project row    = {first.get('first_project')}")
    print(f"  first annotation row = {first.get('first_annotation')}")
    print("  If these are newer than when your team started using CAT on this")
    print("  machine, the database was wiped and re-created (install_cat.sh).")
    print("  The Oracle container log also says 'first database startup' each time")
    print("  it initialises an empty data directory:")
    print("    docker logs database-oracle-free 2>&1 | grep -i 'first database startup'\n")

    print("=== bulk-replace events (hard delete + reinsert) ===")
    params = {}
    where = "l.action IN ('annotations_bulk_replaced', 'annotations_bulk_replace_refused')"
    if args.project_id is not None:
        where += " AND l.project_id = :project_id"
        params["project_id"] = args.project_id
    events = fetch_all(
        f"""
        SELECT l.project_id, p.project_name, l.action, l.details_json, l.created_at,
               u.username, u.display_name
        FROM cat_project_activity_log l
        LEFT JOIN cat_projects p ON p.project_id = l.project_id
        LEFT JOIN cat_users u ON u.user_id = l.user_id
        WHERE {where}
        ORDER BY l.project_id, l.created_at
        """,
        params,
    )
    if not events:
        print("  none logged.\n")

    affected = []
    last_project = None
    for ev in events:
        pid = ev["project_id"]
        if pid != last_project:
            print(f"\n  Project {pid} — {ev.get('project_name') or '(unnamed)'}")
            last_project = pid
            affected.append(pid)
        try:
            details = json.loads(ev.get("details_json") or "{}")
        except (TypeError, ValueError):
            details = {}
        who = ev.get("display_name") or ev.get("username") or "unknown user"
        tag = "REFUSED (v17+)" if ev["action"].endswith("refused") else "WIPED + reinserted"
        print(f"    {ev['created_at']}  {tag:<20} rows after={details.get('count', '?'):<6} by {who}")

    for pid in affected:
        now = fetch_one(
            "SELECT COUNT(*) AS live FROM cat_annotations WHERE project_id = :p AND deleted_at IS NULL",
            {"p": pid},
        )
        print(f"\n  Project {pid}: {(now or {}).get('live')} live annotations now")
        for minutes in args.flashback_minutes:
            cnt, err = _count_as_of(fetch_one, pid, minutes)
            if err:
                print(f"    flashback {minutes:>5} min ago: unavailable ({err})")
            else:
                print(f"    flashback {minutes:>5} min ago: {cnt} rows (incl. soft-deleted)")

    print(
        "\nNotes:\n"
        "  - Rows re-inserted by bulk-replace have NEW annotation_ids, a new created_at,\n"
        "    and created_by_user_id = the person who closed the tab (authorship is wrong).\n"
        "  - If flashback still shows more rows than exist now, ask the DBA to copy them\n"
        "    out with SELECT ... AS OF TIMESTAMP before the undo window passes.\n"
        "  - Otherwise the only source is a backup (scripts/backup_to_gcs.sh)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

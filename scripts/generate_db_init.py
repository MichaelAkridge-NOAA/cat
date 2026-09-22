#!/usr/bin/env python3
"""Generate scripts/db-init/002_CAT_TABLES.sql from cat/db/schema.py.

cat/db/schema.py (DDL_BLOCKS) is the single source of truth for the CAT schema:
the app applies it on every start (CAT_DB_AUTO_BOOTSTRAP) and every block is
idempotent. The Oracle container's first-boot init script used to be a
hand-maintained copy of that schema which drifted (it had no users, sessions,
ownership, collaborators, overlay locks, ...). It is now generated so it can't.

    python scripts/generate_db_init.py            # rewrite the file
    python scripts/generate_db_init.py --check    # exit 1 if it is out of date
"""

import argparse
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from cat.db.schema import DDL_BLOCKS  # noqa: E402

TARGET = REPO / "scripts" / "db-init" / "002_CAT_TABLES.sql"

HEADER = """\
-- =============================================================================
-- CAT Schema Tables  --  GENERATED FILE, DO NOT EDIT BY HAND
-- =============================================================================
-- Source of truth: cat/db/schema.py (DDL_BLOCKS). Regenerate with:
--     python scripts/generate_db_init.py
-- A test (tests/test_db_init_sql.py) fails if this file is out of date.
--
-- Run as SYS on first container startup; creates the tables in CAT_USER's
-- schema. Every block is idempotent (the app re-applies the same blocks on
-- startup when CAT_DB_AUTO_BOOTSTRAP=true), so running this twice is harmless.
-- =============================================================================

-- Blocks contain '&' and blank lines: don't treat them as SQL*Plus syntax.
SET DEFINE OFF
SET SQLBLANKLINES ON

ALTER SESSION SET CONTAINER=FREEPDB1;
ALTER SESSION SET CURRENT_SCHEMA = cat_user;

PROMPT Creating CAT tables...

"""

FOOTER = """
PROMPT CAT tables ready.
"""


def render() -> str:
    parts = [HEADER]
    for i, ddl in enumerate(DDL_BLOCKS, 1):
        parts.append(f"-- block {i}\n{ddl.strip()}\n/\n\n")
    parts.append(FOOTER)
    return "".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if the file is out of date")
    args = ap.parse_args()

    expected = render()
    if args.check:
        current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if current.replace("\r\n", "\n") != expected:
            print(f"{TARGET} is out of date - run: python scripts/generate_db_init.py", file=sys.stderr)
            return 1
        print("db-init SQL is up to date")
        return 0

    TARGET.write_text(expected, encoding="utf-8", newline="\n")
    print(f"wrote {TARGET} ({len(DDL_BLOCKS)} blocks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

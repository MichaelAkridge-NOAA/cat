"""The Oracle first-boot init SQL must be generated from cat/db/schema.py."""

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _load_generator():
    spec = importlib.util.spec_from_file_location("generate_db_init", REPO / "scripts" / "generate_db_init.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_db_init_sql_is_up_to_date():
    gen = _load_generator()
    current = gen.TARGET.read_text(encoding="utf-8").replace("\r\n", "\n")
    assert current == gen.render(), "run: python scripts/generate_db_init.py"


def test_db_init_sql_has_the_tables_the_old_copy_was_missing():
    sql = _load_generator().TARGET.read_text(encoding="utf-8")
    for table in ("cat_users", "cat_sessions", "cat_project_collaborators", "cat_project_activity_log"):
        assert table in sql
    assert "owner_user_id" in sql

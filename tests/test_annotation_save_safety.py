"""Regression coverage for the annotation data-loss fixes (cat_db_v17, Phase 0).

Backend tests call the route functions directly with the DB helpers
monkeypatched (same pattern as test_annotation_deletion.py). The few source
checks at the bottom guard against the destructive code paths coming back.
"""

from pathlib import Path

import pytest
from fastapi import HTTPException

import cat.api.db_projects as dbp

REPO = Path(__file__).resolve().parent.parent
EDITOR = {"user_id": 7, "role": "annotator", "display_name": "Ed"}


@pytest.fixture
def editor(monkeypatch):
    monkeypatch.setattr(dbp, "_ensure_oracle_mode", lambda: None)
    monkeypatch.setattr(dbp, "_require_project_role", lambda project_id, user, role: "editor")
    monkeypatch.setattr(dbp, "_log_activity", lambda *a, **k: None)


def _live_row(**overrides):
    row = {
        "annotation_id": 42,
        "project_id": 3,
        "version": 5,
        "deleted_at": None,
        "properties_json": '{"spcode": "ACUR"}',
        "feature_geojson": '{"type": "Feature", "geometry": null, "properties": {}}',
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------- bulk-replace

def test_bulk_replace_is_refused_and_never_deletes(editor, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("bulk-replace must not touch the database")

    monkeypatch.setattr(dbp, "get_connection", boom)
    monkeypatch.setattr(dbp, "execute", boom)

    payload = dbp.AnnotationBulkReplace(annotations=[])
    with pytest.raises(HTTPException) as exc:
        dbp.bulk_replace_annotations(3, payload, current_user=EDITOR)
    assert exc.value.status_code == 410


# ----------------------------------------------------------- update_annotation

def test_update_on_soft_deleted_row_is_410_not_404(editor, monkeypatch):
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: _live_row(deleted_at="2026-09-22"))
    monkeypatch.setattr(dbp, "execute_rowcount", lambda sql, params=None: pytest.fail("must not write"))

    with pytest.raises(HTTPException) as exc:
        dbp.update_annotation(3, 42, dbp.AnnotationUpdate(properties={"spcode": "X"}, version=5), current_user=EDITOR)
    assert exc.value.status_code == 410


def test_update_version_check_is_part_of_the_update_statement(editor, monkeypatch):
    calls = []
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: _live_row())

    def rowcount(sql, params=None):
        calls.append((sql, params))
        return 1

    monkeypatch.setattr(dbp, "execute_rowcount", rowcount)

    result = dbp.update_annotation(
        3, 42, dbp.AnnotationUpdate(properties={"spcode": "PMEA"}, version=5), current_user=EDITOR
    )

    assert result["success"] is True
    assert len(calls) == 1
    sql, params = calls[0]
    assert "NVL(version, 1) = :expected_version" in sql
    assert "deleted_at IS NULL" in sql
    assert params["expected_version"] == 5


def test_update_with_stale_version_is_409(editor, monkeypatch):
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: _live_row(version=6))
    monkeypatch.setattr(dbp, "execute_rowcount", lambda sql, params=None: 0)

    with pytest.raises(HTTPException) as exc:
        dbp.update_annotation(3, 42, dbp.AnnotationUpdate(properties={"spcode": "X"}, version=5), current_user=EDITOR)
    assert exc.value.status_code == 409
    assert exc.value.detail["current_version"] == 6
    assert exc.value.detail["client_version"] == 5


def test_update_racing_a_delete_is_410(editor, monkeypatch):
    rows = iter([_live_row(), _live_row(deleted_at="2026-09-22")])
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: next(rows))
    monkeypatch.setattr(dbp, "execute_rowcount", lambda sql, params=None: 0)

    with pytest.raises(HTTPException) as exc:
        dbp.update_annotation(3, 42, dbp.AnnotationUpdate(properties={"spcode": "X"}, version=5), current_user=EDITOR)
    assert exc.value.status_code == 410


def test_update_refuses_to_blank_out_existing_properties(editor, monkeypatch):
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: _live_row())
    monkeypatch.setattr(dbp, "execute_rowcount", lambda sql, params=None: pytest.fail("must not write"))

    with pytest.raises(HTTPException) as exc:
        dbp.update_annotation(3, 42, dbp.AnnotationUpdate(properties={}, version=5), current_user=EDITOR)
    assert exc.value.status_code == 422


def test_update_refuses_to_overwrite_unreadable_stored_properties(editor, monkeypatch):
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: _live_row(properties_json='{"spcode": "AC'))
    monkeypatch.setattr(dbp, "execute_rowcount", lambda sql, params=None: pytest.fail("must not write"))

    with pytest.raises(HTTPException) as exc:
        dbp.update_annotation(3, 42, dbp.AnnotationUpdate(properties={"spcode": "X"}, version=5), current_user=EDITOR)
    assert exc.value.status_code == 422


# ------------------------------------------------------------------ geojson

def test_geojson_server_fields_win_over_stored_properties(editor, monkeypatch):
    row = _live_row(
        properties_json='{"spcode": "ACUR", "annotation_id": 999, "version": 1}',
        created_by_user_id=7,
        creator_display_name="Ed",
    )
    monkeypatch.setattr(dbp, "fetch_all", lambda sql, params=None: [row])

    fc = dbp.annotations_geojson(3, _current_user=EDITOR)
    feature = fc["features"][0]
    assert feature["id"] == 42
    assert feature["properties"]["annotation_id"] == 42
    assert feature["properties"]["version"] == 5
    assert feature["properties"]["spcode"] == "ACUR"


# --------------------------------------------------- destructive code stays gone

def _read(rel):
    return (REPO / rel).read_text(encoding="utf-8")


def test_live_page_has_no_bulk_replace_calls():
    live = [
        "cat/web/js/annotation-runtime-shell-init.js",
        "cat/web/js/annotation-runtime-operations.js",
        "cat/web/js/annotation-runtime-autosave.js",
        "cat/web/project_creator.html",
    ]
    for rel in live:
        for line in _read(rel).splitlines():
            code = line.split("//", 1)[0]
            assert "bulk-replace" not in code, f"{rel}: {line.strip()}"


def test_installer_never_wipes_oracle_data_without_explicit_opt_in():
    script = _read("install_cat.sh")
    wipe = 'sudo rm -rf "${ORACLE_DATA_DIR:?}"/*'
    assert script.count(wipe) == 1
    before = script[: script.index(wipe)]
    guard = before.rindex('CAT_RESET_ORACLE_DATA:-}" = "yes"')
    assert "tar -czf" in script[guard: script.index(wipe)], "backup must happen before the wipe"
    assert "down -v" not in script[guard: script.index(wipe)]


# ------------------------------------------------------ retry-safe creates

def _create_payload(uuid="u-1"):
    return dbp.AnnotationCreate(
        feature={"type": "Feature", "geometry": None, "properties": {}},
        properties={"spcode": "ACUR"},
        client_uuid=uuid,
    )


def test_create_retry_with_same_uuid_returns_existing_row(editor, monkeypatch):
    rows = {"project": {"project_id": 3}, "uuid": _live_row(client_uuid="u-1")}

    def fetch_one(sql, params=None):
        return rows["uuid"] if "client_uuid = :client_uuid" in sql else rows["project"]

    monkeypatch.setattr(dbp, "fetch_one", fetch_one)
    monkeypatch.setattr(dbp, "execute_returning_id", lambda *a, **k: pytest.fail("must not insert twice"))

    result = dbp.create_annotation(3, _create_payload(), current_user=EDITOR)
    assert result["duplicate"] is True
    assert result["annotation"]["annotation_id"] == 42


def test_create_retry_of_deleted_annotation_is_410(editor, monkeypatch):
    def fetch_one(sql, params=None):
        if "client_uuid = :client_uuid" in sql:
            return _live_row(client_uuid="u-1", deleted_at="2026-09-22")
        return {"project_id": 3}

    monkeypatch.setattr(dbp, "fetch_one", fetch_one)
    monkeypatch.setattr(dbp, "execute_returning_id", lambda *a, **k: pytest.fail("must not insert"))

    with pytest.raises(HTTPException) as exc:
        dbp.create_annotation(3, _create_payload(), current_user=EDITOR)
    assert exc.value.status_code == 410


def test_create_race_on_same_uuid_returns_the_winner(editor, monkeypatch):
    calls = {"uuid_lookups": 0}

    def fetch_one(sql, params=None):
        if "client_uuid = :client_uuid" in sql:
            calls["uuid_lookups"] += 1
            return None if calls["uuid_lookups"] == 1 else _live_row(client_uuid="u-1")
        return {"project_id": 3}

    def insert(*a, **k):
        raise Exception("ORA-00001: unique constraint (UX_CAT_ANNOTATIONS_CLIENT_UUID) violated")

    monkeypatch.setattr(dbp, "fetch_one", fetch_one)
    monkeypatch.setattr(dbp, "execute_returning_id", insert)

    result = dbp.create_annotation(3, _create_payload(), current_user=EDITOR)
    assert result["annotation"]["annotation_id"] == 42


def test_create_stores_client_uuid(editor, monkeypatch):
    seen = {}

    def insert(sql, params=None, id_column="id"):
        seen.update(params)
        return 42

    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: None if "client_uuid = :client_uuid" in sql else _live_row())
    monkeypatch.setattr(dbp, "execute_returning_id", insert)

    dbp.create_annotation(3, _create_payload("u-9"), current_user=EDITOR)
    assert seen["client_uuid"] == "u-9"


# ------------------------------------------------------------ history

def _history_block():
    from cat.db.schema import DDL_BLOCKS
    return next(b for b in DDL_BLOCKS if "CREATE OR REPLACE TRIGGER trg_cat_annotations_history" in b)


def test_history_trigger_covers_update_and_delete_without_driver_binds():
    block = _history_block()
    assert "BEFORE UPDATE OR DELETE ON cat_annotations" in block
    # The driver would treat ":OLD" (any colon + identifier) in the statement
    # text as a bind variable; PL/SQL ":=" is fine.
    import re
    assert not re.search(r":[A-Za-z_]", block)
    assert "CHR(58)" in block


def test_history_table_has_no_foreign_keys():
    from cat.db.schema import DDL_BLOCKS
    table = next(b for b in DDL_BLOCKS if "CREATE TABLE cat_annotation_history" in b)
    assert "FOREIGN KEY" not in table.upper()
    assert "REFERENCES" not in table.upper()


def test_restore_version_is_a_versioned_update(editor, monkeypatch):
    executed = []
    snap = {"history_id": 9, "project_id": 3, "annotation_id": 42,
            "feature_geojson": '{"type": "Feature"}', "properties_json": '{"spcode": "OLD"}'}

    def fetch_one(sql, params=None):
        if "FROM cat_annotation_history" in sql:
            return snap
        return _live_row()

    monkeypatch.setattr(dbp, "fetch_one", fetch_one)
    monkeypatch.setattr(dbp, "execute", lambda sql, params=None: executed.append((sql, params)))
    monkeypatch.setattr(dbp, "execute_returning_id", lambda *a, **k: pytest.fail("row exists — must update, not insert"))

    result = dbp.restore_annotation_version(3, 42, 9, current_user=EDITOR)
    sql, params = executed[0]
    assert "version = NVL(version, 1) + 1" in sql and "deleted_at = NULL" in sql
    assert params["properties_json"] == '{"spcode": "OLD"}'
    assert result["recreated"] is False


def test_restore_version_recreates_a_hard_deleted_annotation(editor, monkeypatch):
    snap = {"history_id": 9, "project_id": 3, "annotation_id": 42, "feature_geojson": "{}",
            "properties_json": '{"spcode": "OLD"}', "created_by": "Ann", "created_by_user_id": 5}

    def fetch_one(sql, params=None):
        if "FROM cat_annotation_history" in sql:
            return snap
        if "SELECT annotation_id FROM cat_annotations" in sql:
            return None  # row is gone entirely
        return _live_row(annotation_id=77)

    monkeypatch.setattr(dbp, "fetch_one", fetch_one)
    monkeypatch.setattr(dbp, "execute_returning_id", lambda *a, **k: 77)

    result = dbp.restore_annotation_version(3, 42, 9, current_user=EDITOR)
    assert result["recreated"] is True
    assert result["annotation"]["annotation_id"] == 77


# ------------------------------------------------------------ QC performance

def test_qc_reads_the_database_a_fixed_number_of_times(editor, monkeypatch):
    """The QC page used to run 3 queries per project plus a full re-read for
    the rollup. Now the query count doesn't grow with the number of projects."""
    ids = list(range(1, 31))
    calls = []

    def fetch_all(sql, params=None):
        calls.append(sql)
        if "FROM cat_projects" in sql:
            return [{"project_id": i, "project_name": f"P{i}", "region": None, "year_num": 2026} for i in ids]
        if "FROM cat_annotations" in sql:
            return [{"project_id": i, "feature_geojson": '{"type":"Feature","geometry":null}',
                     "properties_json": '{"spcode": "ACUR"}'} for i in ids]
        if "FROM cat_coral_species" in sql:
            return [{"spcode": "ACUR", "taxon_name": "Acropora", "genus": "Acropora"}]
        return []

    monkeypatch.setattr(dbp, "_resolve_export_project_ids", lambda *a, **k: ids)
    monkeypatch.setattr(dbp, "fetch_all", fetch_all)

    result = dbp.projects_qc(current_user=EDITOR)

    assert len(result["projects"]) == 30
    assert result["rollup"]["annotation_count"] == 30
    assert all(p["annotation_count"] == 1 for p in result["projects"])
    assert len(calls) <= 5, calls


def test_history_lists_rows_deleted_before_history_existed(monkeypatch, editor):
    """Rows soft-deleted under an older version have no DELETE history entry;
    they must still show up (restorable) in the deleted list."""
    def fake_fetch_all(sql, params=None):
        if "FROM cat_annotation_history h" in sql and "NOT EXISTS" not in sql:
            return [{"history_id": 7, "annotation_id": 1, "project_id": 1, "version": 2, "op": "DELETE",
                     "changed_at": "2026-09-22T10:00:00", "feature_geojson": None,
                     "properties_json": '{"spcode": "A"}', "current_state": "deleted"}]
        assert "NOT EXISTS" in sql and "deleted_at IS NOT NULL" in sql
        return [{"annotation_id": 5, "project_id": 1, "version": 1, "deleted_at": "2026-09-01T10:00:00",
                 "changed_at": "2026-09-01T10:00:00", "feature_geojson": None, "properties_json": '{"spcode": "B"}'}]

    monkeypatch.setattr(dbp, "fetch_all", fake_fetch_all)
    out = dbp.list_project_annotation_history(1, op="DELETE", limit=200, current_user=EDITOR)
    ids = [(e["annotation_id"], e["history_id"], e.get("legacy")) for e in out["history"]]
    assert ids == [(1, 7, None), (5, None, True)]  # newest first


def test_server_refuses_to_start_on_failed_migration():
    src = (Path(__file__).resolve().parents[1] / "cat" / "server.py").read_text(encoding="utf-8")
    block = src.split('logger.exception("Oracle schema auto-bootstrap failed: %s", exc)', 1)[1][:80]
    assert "raise" in block


def test_deleting_a_project_with_annotations_needs_its_name(monkeypatch, editor):
    """One OK click used to wipe a whole project. With live annotations the
    exact project name must be sent as confirm_name."""
    def fake_fetch_one(sql, params=None):
        if "FROM cat_projects" in sql:
            return {"project_id": 5, "project_name": "Reef A"}
        return {"n": 3}

    deleted = []
    monkeypatch.setattr(dbp, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(dbp, "execute", lambda sql, params=None: deleted.append(sql))
    for bad in (None, "", "reef a", "Reef"):
        with pytest.raises(HTTPException) as exc:
            dbp.delete_project(5, confirm_name=bad, current_user=EDITOR)
        assert exc.value.status_code == 400
    assert not deleted
    out = dbp.delete_project(5, confirm_name=" Reef A ", current_user=EDITOR)
    assert out["deleted_annotation_count"] == 3 and deleted

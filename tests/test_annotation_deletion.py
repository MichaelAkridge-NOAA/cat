"""Regression coverage for persisted annotation deletion."""

from pathlib import Path

import pytest
from fastapi import HTTPException

import cat.api.db_projects as dbp

REPO = Path(__file__).resolve().parent.parent
USER = {"user_id": 7, "role": "annotator"}


def test_active_runtime_persists_saved_annotation_before_local_removal():
    source = (REPO / "cat" / "web" / "js" / "annotation-runtime-annotations.js").read_text(encoding="utf-8")
    start = source.index("    async function deleteAnnotation(index)")
    end = source.index("    // Auto-save logic extracted", start)
    handler = source[start:end]

    assert handler.count("await deleteAnnotationFromDb(ann);") == 2
    assert handler.index("await deleteAnnotationFromDb(ann);") < handler.index("// Find and remove layer from map")
    assert "Failed to delete annotation" in handler
    assert "saveProject()" not in handler


def test_table_bulk_delete_confirms_once_and_persists_selected_annotations():
    source = (REPO / "cat" / "web" / "js" / "v2-table.js").read_text(encoding="utf-8")
    start = source.index("  async function deleteSelectedAnnotations()")
    end = source.index("  // ===================================================================", start)
    handler = source[start:end]

    assert 'id="v2BulkDeleteBtn"' in source
    assert handler.count("catConfirm(") == 1
    assert "for (const item of selected)" in handler
    assert "await deleteAnnotationFromDb(item.annotation);" in handler
    assert "failed.forEach(item =>" in handler
    assert "annotations.splice(item.index, 1)" in handler


def test_read_only_mode_hides_bulk_mutation_buttons():
    source = (REPO / "cat" / "web" / "js" / "annotation-readonly.js").read_text(encoding="utf-8")

    assert "body.cat-readonly #v2BulkUpdateBtn" in source
    assert "body.cat-readonly #v2BulkDeleteBtn" in source


def test_delete_annotation_soft_deletes_and_logs_activity(monkeypatch):
    executed = []
    activity = []

    monkeypatch.setattr(dbp, "_ensure_oracle_mode", lambda: None)
    monkeypatch.setattr(dbp, "_require_project_role", lambda project_id, user, role: "editor")
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: {"annotation_id": 42})
    monkeypatch.setattr(dbp, "execute", lambda sql, params=None: executed.append((sql, params)))
    monkeypatch.setattr(
        dbp,
        "_log_activity",
        lambda project_id, user_id, action, details=None: activity.append((project_id, user_id, action, details)),
    )

    result = dbp.delete_annotation(3, 42, current_user=USER)

    assert result == {"success": True, "deleted_annotation_id": 42}
    assert len(executed) == 1
    sql, params = executed[0]
    assert "SET deleted_at = CURRENT_TIMESTAMP" in sql
    assert params == {"project_id": 3, "annotation_id": 42}
    assert activity == [(3, 7, "annotation_deleted", {"annotation_id": 42})]


def test_delete_annotation_returns_404_when_not_live(monkeypatch):
    monkeypatch.setattr(dbp, "_ensure_oracle_mode", lambda: None)
    monkeypatch.setattr(dbp, "_require_project_role", lambda project_id, user, role: "editor")
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: None)

    with pytest.raises(HTTPException) as exc:
        dbp.delete_annotation(3, 42, current_user=USER)

    assert exc.value.status_code == 404
    assert exc.value.detail == "Annotation not found"

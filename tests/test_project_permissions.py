"""Viewer/editor permission checks and duplicate-project naming (no database needed)."""

import asyncio
import inspect

import pytest
from fastapi import HTTPException

import cat.api.db_projects as dbp

# Mutation routes that must require at least the 'editor' project role.
EDITOR_ROUTES = [
    "add_project_asset",
    "create_overlay_layer",
    "generate_transect_layers",
    "create_overlay_feature",
    "update_overlay_layer",
    "delete_overlay_layer",
    "update_overlay_feature",
    "reorder_overlay_layers",
    "start_session",
    "update_session",
    "end_session",
    "session_heartbeat",
]

USER = {"user_id": 7, "role": "annotator", "display_name": "Viewer Vic"}


@pytest.fixture
def as_role(monkeypatch):
    def _set(role):
        monkeypatch.setattr(dbp, "_ensure_oracle_mode", lambda: None)
        monkeypatch.setattr(dbp, "_get_effective_project_role", lambda pid, user: role)

    return _set


def _call_with_dummies(fn):
    """Call a route function with dummy args; the role check must fire first."""
    kwargs = {}
    for name, param in inspect.signature(fn).parameters.items():
        if name == "project_id":
            kwargs[name] = 1
        elif name in ("_current_user", "current_user"):
            kwargs[name] = USER
        elif param.default is not inspect.Parameter.empty:
            kwargs[name] = None
        else:
            kwargs[name] = None if name != "layer_id" else 1
    return fn(**kwargs)


@pytest.mark.parametrize("route", EDITOR_ROUTES)
def test_viewer_is_rejected_on_mutation_routes(route, as_role):
    as_role("viewer")
    with pytest.raises(HTTPException) as exc:
        _call_with_dummies(getattr(dbp, route))
    assert exc.value.status_code == 403


@pytest.mark.parametrize("route", EDITOR_ROUTES)
def test_editor_passes_the_role_check(route, as_role):
    """An editor must get past the role gate. The dummy args then blow up
    somewhere else (TypeError/AttributeError/etc.), which is fine - it just must
    not be a 403 from the role check."""
    as_role("editor")
    try:
        _call_with_dummies(getattr(dbp, route))
    except HTTPException as exc:
        assert exc.status_code != 403
    except Exception:
        pass


@pytest.mark.parametrize("route", ["upload_shapefile_to_layer", "upload_shapefile_loose_files"])
def test_viewer_is_rejected_on_shapefile_uploads(route, as_role):
    as_role("viewer")
    fn = getattr(dbp, route)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(_call_with_dummies_async(fn))
    assert exc.value.status_code == 403


async def _call_with_dummies_async(fn):
    kwargs = {}
    for name in inspect.signature(fn).parameters:
        kwargs[name] = 1 if name == "project_id" else (USER if name in ("_current_user", "current_user") else None)
    return await fn(**kwargs)


def test_pick_copy_name_skips_taken_names(monkeypatch):
    taken = [{"project_name": "Reef A"}, {"project_name": "Reef A (copy)"}]
    monkeypatch.setattr(dbp, "fetch_all", lambda sql, params=None: taken)
    assert dbp._pick_copy_name("Reef A", 7) == "Reef A (copy 2)"


def test_pick_copy_name_first_copy_when_free(monkeypatch):
    monkeypatch.setattr(dbp, "fetch_all", lambda sql, params=None: [])
    assert dbp._pick_copy_name("Reef A", 7) == "Reef A (copy)"


def test_pick_copy_name_truncates_to_255(monkeypatch):
    monkeypatch.setattr(dbp, "fetch_all", lambda sql, params=None: [])
    name = dbp._pick_copy_name("x" * 255, 7)
    assert len(name) == 255
    assert name.endswith(" (copy)")


def test_viewer_may_duplicate_but_missing_project_is_404(monkeypatch, as_role):
    as_role("viewer")
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: None)
    with pytest.raises(HTTPException) as exc:
        dbp.duplicate_project(1, dbp.ProjectDuplicate(), current_user=USER)
    assert exc.value.status_code == 404  # got past the viewer role check

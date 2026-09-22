"""Auth and behavior for /api/config/field-defaults/*."""

import asyncio
import inspect

import pytest
from fastapi import HTTPException

import cat.api.field_options as fo
from cat.api.auth import require_team_lead_or_admin

ANNOTATOR = {"user_id": 1, "role": "annotator"}
TEAM_LEAD = {"user_id": 2, "role": "team_lead"}


@pytest.mark.parametrize("route,requires_team_lead", [
    ("get_field_defaults", False),
    ("set_field_default", True),
])
def test_every_route_is_guarded(route, requires_team_lead):
    fn = getattr(fo, route)
    sig = inspect.signature(fn)
    dep_names = [p.name for p in sig.parameters.values() if "user" in p.name]
    assert dep_names, f"{route} has no auth dependency parameter"
    default = sig.parameters[dep_names[0]].default
    dep_fn = getattr(default, "dependency", None)
    assert dep_fn is not None
    if requires_team_lead:
        assert dep_fn is require_team_lead_or_admin


def test_check_default_field_rejects_unknown_field():
    with pytest.raises(HTTPException) as exc:
        fo._check_default_field("not_a_real_field")
    assert exc.value.status_code == 404


def test_check_default_field_accepts_every_known_default_field():
    for f in fo.KNOWN_DEFAULT_FIELDS:
        fo._check_default_field(f)


def test_empty_value_deletes_rather_than_upserts(monkeypatch):
    monkeypatch.setattr(fo, "is_oracle_backend_enabled", lambda: True)
    calls = []
    monkeypatch.setattr("cat.db.oracle.execute", lambda sql, params=None: calls.append(sql))
    result = asyncio.run(fo.set_field_default("morph_code", fo.DefaultValueUpdate(value="  "), TEAM_LEAD))
    assert result == {"success": True, "field": "morph_code", "value": None}
    assert len(calls) == 1
    assert "DELETE" in calls[0]


def test_nonempty_value_upserts(monkeypatch):
    monkeypatch.setattr(fo, "is_oracle_backend_enabled", lambda: True)
    calls = []
    monkeypatch.setattr("cat.db.oracle.execute", lambda sql, params=None: calls.append((sql, params)))
    result = asyncio.run(fo.set_field_default("spcode", fo.DefaultValueUpdate(value="PLOB"), TEAM_LEAD))
    assert result == {"success": True, "field": "spcode", "value": "PLOB"}
    assert "MERGE" in calls[0][0]
    assert calls[0][1]["v"] == "PLOB"


def test_get_field_defaults_returns_configured_values(monkeypatch):
    monkeypatch.setattr(fo, "is_oracle_backend_enabled", lambda: True)
    monkeypatch.setattr(
        "cat.db.oracle.fetch_all",
        lambda sql, params=None: [{"field_name": "morph_code", "default_value": "BR"}],
    )
    result = asyncio.run(fo.get_field_defaults(ANNOTATOR))
    assert result == {"defaults": {"morph_code": "BR"}}

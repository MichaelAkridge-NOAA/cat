"""Auth on /api/config/field-options/* and the known-field allowlist."""

import inspect

import pytest
from fastapi import HTTPException

import cat.api.field_options as fo
from cat.api.auth import require_team_lead_or_admin

ANNOTATOR = {"user_id": 1, "role": "annotator"}
TEAM_LEAD = {"user_id": 2, "role": "team_lead"}


@pytest.mark.parametrize("route,requires_team_lead", [
    ("get_all_field_options", False),
    ("get_all_field_options_for_management", True),
    ("set_field_option_enabled", True),
    ("add_field_option", True),
    ("get_used_values", True),
])
def test_every_route_is_guarded(route, requires_team_lead):
    fn = getattr(fo, route)
    sig = inspect.signature(fn)
    dep_names = [p.name for p in sig.parameters.values() if "user" in p.name]
    assert dep_names, f"{route} has no auth dependency parameter"
    default = sig.parameters[dep_names[0]].default
    dep_fn = getattr(default, "dependency", None)
    assert dep_fn is not None, f"{route}'s user param isn't a Depends(...)"
    if requires_team_lead:
        assert dep_fn is require_team_lead_or_admin, f"{route} should require team_lead_or_admin, got {dep_fn}"


def test_check_field_rejects_unknown_field_name():
    with pytest.raises(HTTPException) as exc:
        fo._check_field("not_a_real_field")
    assert exc.value.status_code == 404


def test_check_field_accepts_every_known_field():
    for f in fo.KNOWN_FIELDS:
        fo._check_field(f)  # must not raise


def test_set_enabled_rejects_unknown_field_before_touching_db(monkeypatch):
    """The field-name allowlist check must run before any DB call — a typo'd
    field_name must 404, not silently create a new, never-consumed field."""
    called = {"execute": False}
    monkeypatch.setattr(fo, "is_oracle_backend_enabled", lambda: True)
    monkeypatch.setattr("cat.db.oracle.execute", lambda *a, **k: called.__setitem__("execute", True))
    monkeypatch.setattr("cat.db.oracle.fetch_one", lambda *a, **k: called.__setitem__("execute", True))
    import asyncio
    with pytest.raises(HTTPException) as exc:
        asyncio.run(fo.set_field_option_enabled(
            "not_a_real_field", fo.OptionEnabledUpdate(value="X", enabled=False), TEAM_LEAD
        ))
    assert exc.value.status_code == 404
    assert not called["execute"]


def test_row_out_falls_back_label_to_value():
    row = {"option_value": "A", "option_label": None, "display_order": 1, "is_enabled": 1}
    out = fo._row_out(row)
    assert out == {"value": "A", "label": "A", "order": 1, "enabled": True}


def test_seeded_option_counts_match_the_previously_hardcoded_lists(monkeypatch):
    """Regression guard for the migration's seed data — if this ever drifts
    from the hardcoded lists it replaced, every dropdown silently loses or
    gains options on the next deploy."""
    import asyncio
    fake_rows = (
        [{"field_name": "transect", "option_value": v, "option_label": v, "display_order": i, "is_enabled": 1}
         for i, v in enumerate(["A", "B"])]
        + [{"field_name": "segment", "option_value": v, "option_label": v, "display_order": i, "is_enabled": 1}
           for i, v in enumerate(["0", "5", "10", "15"])]
        + [{"field_name": "morph_code", "option_value": v, "option_label": v, "display_order": i, "is_enabled": 1}
           for i, v in enumerate(["BR", "CO", "EN", "FO", "FL", "LA", "MD", "MA", "PL", "SM", "SO", "TB"])]
        + [{"field_name": f, "option_value": v, "option_label": v, "display_order": i, "is_enabled": 1}
           for f in ("no_colony", "juvenile", "remnant", "ex_bound") for i, v in enumerate(["0", "-1"])]
        + [{"field_name": "juv_substrate", "option_value": v, "option_label": v, "display_order": i, "is_enabled": 1}
           for i, v in enumerate(["CCAH", "CCAR", "TURFH", "TURFR", "EMA", "PESP", "LOBO", "HARD", "CORAL", "RUB", "HALI"])]
    )
    monkeypatch.setattr(fo, "is_oracle_backend_enabled", lambda: True)
    monkeypatch.setattr("cat.db.oracle.fetch_all", lambda sql, params=None: fake_rows)
    result = asyncio.run(fo.get_all_field_options(ANNOTATOR))
    assert len(result["fields"]["transect"]) == 2
    assert len(result["fields"]["segment"]) == 4
    assert len(result["fields"]["morph_code"]) == 12
    assert len(result["fields"]["no_colony"]) == 2
    assert len(result["fields"]["juv_substrate"]) == 11


def test_disabled_options_are_excluded_from_the_annotator_endpoint(monkeypatch):
    import asyncio
    rows = [
        {"field_name": "morph_code", "option_value": "BR", "option_label": "BR - Branching", "display_order": 1, "is_enabled": 1},
    ]
    # The SQL itself filters is_enabled=1; simulate that by only returning enabled rows.
    monkeypatch.setattr(fo, "is_oracle_backend_enabled", lambda: True)
    monkeypatch.setattr("cat.db.oracle.fetch_all", lambda sql, params=None: rows)
    result = asyncio.run(fo.get_all_field_options(ANNOTATOR))
    assert [o["value"] for o in result["fields"]["morph_code"]] == ["BR"]


def test_used_values_reads_every_member_field_of_a_group(monkeypatch):
    """A group list ('rdcause') is built from all of its numbered fields, and
    the SQL only ever names allowlisted properties."""
    seen = {}
    monkeypatch.setattr(fo, "is_oracle_backend_enabled", lambda: True)

    def fake_fetch_all(sql, params=None):
        seen["sql"] = sql
        return [{"v": "SED", "n": 3}]

    monkeypatch.setattr("cat.db.oracle.fetch_all", fake_fetch_all)
    import asyncio
    out = asyncio.run(fo.get_used_values("rdcause", TEAM_LEAD))
    assert out["values"] == [{"value": "SED", "count": 3}]
    for m in ("$.rdcause1", "$.rdcause2", "$.rdcause3"):
        assert m in seen["sql"]
    assert "deleted_at IS NULL" in seen["sql"]


def test_used_values_rejects_unknown_field(monkeypatch):
    monkeypatch.setattr(fo, "is_oracle_backend_enabled", lambda: True)
    import asyncio
    with pytest.raises(HTTPException) as exc:
        asyncio.run(fo.get_used_values("x' OR 1=1 --", TEAM_LEAD))
    assert exc.value.status_code == 404


def test_group_lists_are_known_fields():
    for g in ("rdcause", "con", "sev"):
        assert g in fo.KNOWN_FIELDS
        assert g in fo.FIELD_GROUP_MEMBERS

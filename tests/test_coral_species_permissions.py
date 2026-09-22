"""Auth on /api/coral/* and the deployment-wide species-disable floor."""

import pytest
from fastapi import HTTPException

import cat.api.coral_species as species_api
from cat.api.auth import require_admin, require_team_lead_or_admin

ANNOTATOR = {"user_id": 1, "role": "annotator"}
TEAM_LEAD = {"user_id": 2, "role": "team_lead"}
ADMIN = {"user_id": 3, "role": "admin"}


def test_require_team_lead_or_admin_rejects_annotator():
    with pytest.raises(HTTPException) as exc:
        require_team_lead_or_admin(ANNOTATOR)
    assert exc.value.status_code == 403


def test_require_team_lead_or_admin_accepts_team_lead():
    assert require_team_lead_or_admin(TEAM_LEAD) == TEAM_LEAD


def test_require_team_lead_or_admin_accepts_admin():
    assert require_team_lead_or_admin(ADMIN) == ADMIN


def test_require_admin_still_rejects_team_lead():
    """team_lead must stay a strict subset of admin's powers."""
    with pytest.raises(HTTPException) as exc:
        require_admin(TEAM_LEAD)
    assert exc.value.status_code == 403


@pytest.mark.parametrize("route,requires", [
    ("get_all_species", "auth"),
    ("search_species", "auth"),
    ("get_species_by_code", "auth"),
    ("get_available_filters", "auth"),
    ("import_species_from_csv", "team_lead"),
    ("list_species_for_management", "team_lead"),
    ("set_species_enabled", "team_lead"),
])
def test_every_coral_route_is_guarded(route, requires):
    import inspect
    fn = getattr(species_api, route)
    sig = inspect.signature(fn)
    dep_names = [p.name for p in sig.parameters.values() if "user" in p.name]
    assert dep_names, f"{route} has no auth dependency parameter"
    # The dependency's default is a fastapi Depends(...) wrapping our function;
    # just confirm SOME user dependency is wired, matching the required tier.
    default = sig.parameters[dep_names[0]].default
    dep_fn = getattr(default, "dependency", None)
    assert dep_fn is not None, f"{route}'s user param isn't a Depends(...)"
    if requires == "team_lead":
        assert dep_fn is require_team_lead_or_admin, f"{route} should require team_lead_or_admin, got {dep_fn}"


def test_org_wide_floor_excludes_disabled_species_by_default(monkeypatch):
    rows = [
        {"spcode": "AAAA", "inactive_flag": 0},
        {"spcode": "BBBB", "inactive_flag": 1},
    ]
    captured = {}

    def fake_fetch_all(sql, params=None):
        captured["sql"] = sql
        if "inactive_flag" in sql and "= 0" in sql:
            return [r for r in rows if r["inactive_flag"] == 0]
        return rows

    monkeypatch.setattr("cat.db.oracle.fetch_all", fake_fetch_all)
    result = species_api._load_species_from_db(None)
    assert [r["code"] for r in result] == ["AAAA"]
    assert "inactive_flag" in captured["sql"]


def test_null_string_columns_from_oracle_do_not_crash_scoring(monkeypatch):
    """Oracle stores '' as NULL: a row with blank taxon_name/genus/etc. comes
    back with those keys present but set to None, not missing. _score_species
    used to call .lower() on that unconditionally and crash on any row with a
    blank optional field — which is common, real data, not an edge case."""
    rows = [{"spcode": "ZZZZ", "taxon_name": None, "genus": None, "family": None,
             "scientific_name": None, "class_name": None, "gencode": None,
             "morphology_1": None, "morphology_2": None, "inactive_flag": 0}]
    monkeypatch.setattr("cat.db.oracle.fetch_all", lambda sql, params=None: rows)
    result = species_api._load_species_from_db(None)
    assert result[0]["taxon_name"] == ""
    assert species_api._score_species(result[0], "zzzz") > 0


def test_manage_endpoint_bypasses_the_floor(monkeypatch):
    rows = [
        {"spcode": "AAAA", "inactive_flag": 0},
        {"spcode": "BBBB", "inactive_flag": 1},
    ]
    monkeypatch.setattr("cat.db.oracle.fetch_all", lambda sql, params=None: rows)
    result = species_api._load_species_from_db({"include_inactive": True})
    assert {r["code"] for r in result} == {"AAAA", "BBBB"}


def test_species_manage_route_is_registered_before_species_code():
    """FastAPI matches path routes in registration order: GET /species/{code}
    would otherwise swallow a request for the literal path /species/manage."""
    get_paths = [r.path for r in species_api.router.routes if "GET" in getattr(r, "methods", ())]
    assert get_paths.index("/api/coral/species/manage") < get_paths.index("/api/coral/species/{code}")


def test_qc_species_lookup_is_untouched_by_the_floor():
    """The invariant in docs/team-lead-config-plan.md: QC's own species query
    in db_projects.py must not go through coral_species.py's filtered helpers,
    or disabling a species would make historical annotations using it show up
    as 'unrecognized'."""
    import cat.api.db_projects as dbp
    import inspect
    src = inspect.getsource(dbp.aggregate_annotations)
    assert "SELECT spcode, taxon_name, genus FROM cat_coral_species" in src
    assert "inactive_flag" not in src

from datetime import datetime

import pytest

import cat.api.sites as sites_api
import cat.db.oracle as oracle
from cat.db.sites import (
    _group_site_rows,
    build_sites_from_csv,
    load_site_list_csv,
    load_visit_info_csv,
    replace_site_assets,
    seed_sites_from_csv,
    update_cog_uris,
)


def test_bundled_2026_visits_are_grouped_without_data_loss():
    grouped = load_visit_info_csv()

    assert len(grouped) == 419
    assert sum(len(visits) for visits in grouped.values()) == 442
    assert len(grouped["PAL-11"]) == 2
    assert grouped["PAL-11"][0]["survey_date"] == "4/24/2026"
    assert grouped["PAL-11"][1]["survey_date"] == "4/20/2026"
    assert all(
        datetime.strptime(visit["survey_date"], "%m/%d/%Y").year == 2026
        for visits in grouped.values()
        for visit in visits
    )
    assert {
        visit["depth_bin"]
        for visits in grouped.values()
        for visit in visits
    } <= {"", "S", "M", "D"}
    flat_visits = [visit for visits in grouped.values() for visit in visits]
    assert sum(bool(visit["survey_type"]) for visit in flat_visits) == 440
    assert sum(bool(visit["camera_number"]) for visit in flat_visits) == 442
    assert sum(bool(visit["occ_site_id"]) for visit in flat_visits) == 47
    assert sum(bool(visit["processing_status"]) for visit in flat_visits) == 395
    assert all(visit["color_correct"] for visit in flat_visits)
    assert all(visit["exposure_correct"] for visit in flat_visits)


def test_sites_are_derived_from_2026_visits_and_keep_asset_overlays():
    sites = build_sites_from_csv(gcs_asset_map={
        "PAL-11": {
            "cog_uri": "gs://test/2026_PAL-11_mos_cog.tif",
            "dem_uri": "gs://test/2026_PAL-11_dem_cog.tif",
        }
    })
    pal = next(site for site in sites if site["site_name"] == "PAL-11")

    assert len(sites) == 419
    assert not any(site["site_name"].startswith("WAK-") for site in sites)
    assert pal["visit"] == pal["visits"][0]
    assert len(pal["visits"]) == 2
    assert pal["depth_bin"] == ""
    assert pal["cog_uri"].endswith("_mos_cog.tif")
    assert pal["dem_uri"].endswith("_dem_cog.tif")


def test_file_api_counts_regions_and_searches_all_visits(monkeypatch):
    monkeypatch.setattr(sites_api, "_use_db", lambda: False)

    response = sites_api.list_sites(
        region=None, depth_bin=None, search=None, has_cog=None
    )
    regions = sites_api.list_regions()
    status = sites_api.sites_status()
    team_matches = sites_api.list_sites(
        region=None, depth_bin=None, search="Oceanography", has_cog=None
    )
    date_matches = sites_api.list_sites(
        region=None, depth_bin=None, search="4/20/2026", has_cog=None
    )
    survey_matches = sites_api.list_sites(
        region=None, depth_bin=None, search="spiral", has_cog=None
    )

    assert response["total"] == 419
    assert "PAL" in regions["regions"]
    assert "WAK" not in regions["regions"]
    assert status["csv_site_count"] == 419
    assert team_matches["total"] > 0
    assert any(site["site_name"] == "PAL-11" for site in date_matches["sites"])
    assert survey_matches["total"] > 0
    assert all(
        any(visit["survey_type"] == "spiral" for visit in site["visits"])
        for site in survey_matches["sites"]
    )


def test_database_rows_group_into_the_file_mode_contract():
    base = {
        "site_name": "PAL-11",
        "site_depth_bin": "",
        "site_region": "PAL",
        "cog_uri": "gs://test/2026_PAL-11_mos_cog.tif",
        "mission_id": "SE2602",
        "cruise_leg": "Leg 1",
        "photographer": "CLL",
        "team": "Oceanography",
        "visit_region": "PAL",
        "island": "PAL",
        "sector": None,
        "reef_zone": None,
        "visit_depth_bin": "",
        "survey_size": "12m",
        "latitude": 5.88323,
        "longitude": -162.133,
        "survey_type": "spiral",
        "total_images": "4461",
        "notes": None,
        "modeling_priority": None,
        "annotation_time": None,
        "piclea_file_path": "N:\\Fixed_Sites\\PAL-11",
    }
    rows = [
        {**base, "survey_date": "4/20/2026"},
        {**base, "survey_date": "4/24/2026"},
    ]

    sites = _group_site_rows(rows)

    assert len(sites) == 1
    assert [visit["survey_date"] for visit in sites[0]["visits"]] == [
        "4/24/2026",
        "4/20/2026",
    ]
    assert sites[0]["visit"] == sites[0]["visits"][0]
    assert sites[0]["cog_uri"] == base["cog_uri"]


def test_database_rows_preserve_a_persisted_dem_only_match():
    dem_uri = "gs://test/dem_cog/2026_PAL-11_dem_cog.tif"
    sites = _group_site_rows([{
        "site_name": "PAL-11",
        "site_depth_bin": "",
        "site_region": "PAL",
        "cog_uri": None,
        "dem_uri": dem_uri,
    }])

    assert sites[0]["has_cog"] is True
    assert sites[0]["has_dem"] is True
    assert sites[0]["cog_uri"] is None
    assert sites[0]["dem_uri"] == dem_uri


class _FakeCursor:
    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, *args):
        self.calls.append(("execute", sql, args))

    def executemany(self, sql, rows):
        self.calls.append(("executemany", sql, list(rows)))

    def fetchall(self):
        return [("WAK-2104",), ("PAL-11",)]


class _FakeConnection:
    def __init__(self):
        self.cursor_instance = _FakeCursor()
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commits += 1


def test_update_cog_uris_persists_dem_without_clearing_orthomosaic(monkeypatch):
    connection = _FakeConnection()
    monkeypatch.setattr(oracle, "get_connection", lambda: connection)

    updated = update_cog_uris({
        "PAL-11": {
            "cog_uri": None,
            "dem_uri": "gs://test/dem_cog/2026_PAL-11_dem_cog.tif",
        },
        "GUA-2838": {
            "cog_uri": "gs://test/orthomosaic_cog/2026_GUA-2838_mos_cog.tif",
            "dem_uri": "gs://test/dem_cog/2026_GUA-2838_dem_cog.tif",
        },
    })

    call = connection.cursor_instance.calls[0]
    assert updated == 2
    assert call[0] == "executemany"
    assert "dem_uri = NVL(:dem_uri, dem_uri)" in call[1]
    assert call[2] == [
        {
            "site_name": "PAL-11",
            "cog_uri": None,
            "dem_uri": "gs://test/dem_cog/2026_PAL-11_dem_cog.tif",
        },
        {
            "site_name": "GUA-2838",
            "cog_uri": "gs://test/orthomosaic_cog/2026_GUA-2838_mos_cog.tif",
            "dem_uri": "gs://test/dem_cog/2026_GUA-2838_dem_cog.tif",
        },
    ]
    assert connection.commits == 1


class _AssetManagerCursor:
    def __init__(self):
        self.calls = []
        self.rowcount = 0
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        normalized = " ".join(sql.lower().split())
        self.calls.append((normalized, params or {}))
        self._rows = []
        if normalized.startswith("update cat_sites"):
            self.rowcount = 1
        elif normalized.startswith("select project_id from cat_projects"):
            self._rows = [(41,), (42,)]
            self.rowcount = 2
        elif normalized.startswith("update cat_project_assets"):
            self.rowcount = 1 if params["project_id"] == 41 else 0
        elif normalized.startswith("delete from cat_project_assets"):
            self.rowcount = 1
        else:
            self.rowcount = 1

    def fetchall(self):
        return self._rows


class _AssetManagerConnection(_FakeConnection):
    def __init__(self):
        self.cursor_instance = _AssetManagerCursor()
        self.commits = 0


def test_replace_site_assets_can_propagate_and_clear_project_assets(monkeypatch):
    connection = _AssetManagerConnection()
    monkeypatch.setattr(oracle, "get_connection", lambda: connection)
    cog_uri = "gs://test/orthomosaic_cog/2026_PAL-11_mos_cog_v2.tif"

    result = replace_site_assets(
        "PAL-11",
        cog_uri=cog_uri,
        dem_uri=None,
        update_projects=True,
    )

    calls = connection.cursor_instance.calls
    site_update = next(call for call in calls if call[0].startswith("update cat_sites"))
    project_updates = [call for call in calls if call[0].startswith("update cat_project_assets")]
    project_insert = next(call for call in calls if call[0].startswith("insert into cat_project_assets"))
    project_deletes = [call for call in calls if call[0].startswith("delete from cat_project_assets")]

    assert site_update[1] == {
        "site_name": "PAL-11",
        "cog_uri": cog_uri,
        "dem_uri": None,
    }
    assert len(project_updates) == 2
    assert project_insert[1]["project_id"] == 42
    assert project_insert[1]["asset_type"] == "COG"
    assert project_insert[1]["cog_url"] == cog_uri
    assert len(project_deletes) == 2
    assert all(call[1]["asset_type"] == "DEM" for call in project_deletes)
    assert result == {"projects_updated": 2}
    assert connection.commits == 1


def test_site_asset_api_validates_site_and_asset_kind(monkeypatch):
    monkeypatch.setattr(sites_api, "_use_db", lambda: True)

    with pytest.raises(sites_api.HTTPException) as exc_info:
        sites_api.update_site_assets(
            "PAL-11",
            sites_api.SiteAssetsUpdate(
                cog_uri="gs://test/dem_cog/2026_GUA-2838_dem_cog.tif",
            ),
            {"role": "admin"},
        )

    assert exc_info.value.status_code == 422


def test_site_asset_api_returns_refreshed_persistent_site(monkeypatch):
    cog_uri = "gs://test/orthomosaic_cog/2026_PAL-11_mos_cog_v2.tif"
    captured = {}

    def fake_replace(site_name, cog_uri, dem_uri, update_projects):
        captured.update({
            "site_name": site_name,
            "cog_uri": cog_uri,
            "dem_uri": dem_uri,
            "update_projects": update_projects,
        })
        return {"projects_updated": 2}

    monkeypatch.setattr(sites_api, "_use_db", lambda: True)
    monkeypatch.setattr(sites_api, "replace_site_assets", fake_replace)
    monkeypatch.setattr(sites_api, "get_sites", lambda use_db: [{
        "site_name": "PAL-11",
        "cog_uri": cog_uri,
        "dem_uri": None,
        "has_cog": True,
        "has_dem": False,
    }])

    result = sites_api.update_site_assets(
        "PAL-11",
        sites_api.SiteAssetsUpdate(
            cog_uri=cog_uri,
            dem_uri=None,
            update_projects=True,
        ),
        {"role": "admin"},
    )

    assert captured == {
        "site_name": "PAL-11",
        "cog_uri": cog_uri,
        "dem_uri": None,
        "update_projects": True,
    }
    assert result["site"]["cog_uri"] == cog_uri
    assert result["projects_updated"] == 2


def test_oracle_sync_replaces_only_reference_data(monkeypatch):
    connection = _FakeConnection()
    monkeypatch.setattr(oracle, "get_connection", lambda: connection)

    result = seed_sites_from_csv()
    calls = connection.cursor_instance.calls
    all_sql = "\n".join(call[1].lower() for call in calls)
    batches = [call for call in calls if call[0] == "executemany"]
    site_merge = next(call for call in batches if "merge into cat_sites" in call[1].lower())
    visit_insert = next(call for call in batches if "insert into cat_site_visits" in call[1].lower())
    stale_delete = next(call for call in batches if "delete from cat_sites" in call[1].lower())

    assert result == {
        "sites_seeded": 419,
        "visits_seeded": 442,
        "sites_removed": 1,
    }
    assert len(site_merge[2]) == 419
    assert len(visit_insert[2]) == 442
    assert stale_delete[2] == [{"site_name": "WAK-2104"}]
    assert connection.commits == 1
    assert all(name not in all_sql for name in (
        "cat_projects", "cat_project_assets", "cat_annotations", "cat_users"
    ))
    assert all(
        key in visit_insert[2][0]
        for key in (
            "mission_id", "occ_site_id", "camera_number", "reef_zone",
            "depth_bin", "processing_status", "color_correct",
            "exposure_correct", "mosaic_issues", "piclea_file_path",
        )
    )


def test_site_list_loader_is_the_same_unique_2026_collection():
    sites = load_site_list_csv()

    assert len(sites) == 419
    assert sum(len(site["visits"]) for site in sites.values()) == 442
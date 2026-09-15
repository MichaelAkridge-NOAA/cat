from datetime import datetime

import cat.api.sites as sites_api
import cat.db.oracle as oracle
from cat.db.sites import (
    _group_site_rows,
    build_sites_from_csv,
    load_site_list_csv,
    load_visit_info_csv,
    seed_sites_from_csv,
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
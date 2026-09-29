"""Report / QC aggregation: code normalisation, the species-list fallback,
conditions across con_1..con_3, and ordered breakdowns."""

import json

import cat.api.db_projects as dbp

SQUARE = {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}}


def _row(created_by="Ann", **props):
    return {"project_id": 1, "created_by": created_by,
            "feature_geojson": json.dumps(SQUARE), "properties_json": json.dumps(props)}


LOOKUP = {"PMEA": {"name": "Pocillopora meandrina", "genus": "Pocillopora"}}


def test_codes_are_normalised_and_placeholders_count_as_missing():
    rows = [_row(spcode="PMEA", con_1="BLE"), _row(spcode=" pmea ", con_1="ble"),
            _row(spcode="-", con_1=""), _row(spcode="unknown", con_1="-"), _row(spcode="XXXX", con_1="BLE")]
    out = dbp._aggregate_rows(rows, LOOKUP, False)

    assert [(d["spcode"], d["count"]) for d in out["by_species"]] == [("PMEA", 2), ("XXXX", 1)]
    assert out["by_species"][0]["name"] == "Pocillopora meandrina"
    assert out["missing_fields"] == {"spcode": 2, "con_1": 2}
    # "-" is missing, not an unrecognized species; only the real stray code is.
    assert out["by_unrecognized_species"] == [{"spcode": "XXXX", "count": 1}]
    assert out["complete_count"] == 3


def test_conditions_are_counted_across_all_three_slots_with_severity():
    rows = [_row(spcode="PMEA", con_1="BLE", sev_1="2", con_2="DIS", sev_2="4"),
            _row(spcode="PMEA", con_1="BLE", sev_1="3")]
    out = dbp._aggregate_rows(rows, LOOKUP, False)

    assert [(d["condition"], d["count"]) for d in out["by_condition"]] == [("BLE", 2)]
    anyc = {d["condition"]: d for d in out["by_condition_any"]}
    assert anyc["BLE"]["count"] == 2 and anyc["DIS"]["count"] == 1
    assert anyc["BLE"]["by_severity"] == [{"severity": "2", "count": 1}, {"severity": "3", "count": 1}]
    assert [d["severity"] for d in out["by_severity"]] == ["2", "3", "4"]


def test_ordered_breakdowns_keep_their_natural_order():
    rows = [_row(spcode="PMEA", size_cm=90, transect="A", segment="10"),
            _row(spcode="PMEA", size_cm=3, transect="A", segment="5"),
            _row(spcode="PMEA", size_cm=3, transect="A", segment="5"),
            _row(spcode="PMEA", diameter="25", transect="B", segment="0")]
    out = dbp._aggregate_rows(rows, LOOKUP, False)

    assert [d["size_class"] for d in out["by_size_class"]] == ["<5 cm", "20–39.9 cm", "80–159.9 cm"]
    assert [(d["transect"], d["segment"]) for d in out["by_transect_segment"]] == [("A", "5"), ("A", "10"), ("B", "0")]
    assert out["by_species"][0]["mean_size_cm"] == round((90 + 3 + 3 + 25) / 4, 1)


def test_annotator_morphology_and_colony_flags():
    rows = [_row(created_by="Ann", spcode="PMEA", morph_code="br", juvenile=-1),
            _row(created_by=None, analyst="Bo", spcode="PMEA", morph_code="", no_colony="-1", remnant=0)]
    out = dbp._aggregate_rows(rows, LOOKUP, False)

    assert {d["annotator"] for d in out["by_annotator"]} == {"Ann", "Bo"}
    assert out["by_morphology"] == [{"morph_code": "BR", "count": 1}]
    assert out["missing_morphology"] == 1
    assert out["colony_flags"] == {"juvenile": 1, "remnant": 0, "no_colony": 1, "ex_bound": 0}


def test_species_lookup_falls_back_to_the_reference_csv(monkeypatch):
    # The table is empty until someone clicks "Import CSV"; the annotation
    # form already falls back to the CSV, so QC/report must too.
    monkeypatch.setattr(dbp, "fetch_all", lambda sql, params=None: [])
    lookup = dbp._load_species_lookup()
    assert len(lookup) > 100
    assert all(code == code.upper() for code in lookup)


def test_activity_export_times_use_the_viewers_zone():
    from datetime import datetime, timezone

    zone, label = dbp._export_tz("Pacific/Honolulu", None)
    assert label == "Pacific/Honolulu"
    assert datetime(2026, 9, 29, 8, 6, tzinfo=timezone.utc).astimezone(zone).strftime("%Y-%m-%d %H:%M") == "2026-09-28 22:06"
    # Unknown zone name: fall back to the browser's offset, then UTC.
    assert dbp._export_tz("Not/AZone", -600)[1] == "UTC-10:00"
    assert dbp._export_tz(None, None)[1] == "UTC"


def test_activity_export_rejects_unknown_tables(monkeypatch):
    import pytest
    from fastapi import HTTPException

    monkeypatch.setattr(dbp, "_ensure_oracle_mode", lambda: None)
    with pytest.raises(HTTPException) as exc:
        dbp.activity_export(table="payroll", current_user={"user_id": 1, "role": "admin"})
    assert exc.value.status_code == 400

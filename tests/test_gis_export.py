"""ArcGIS / GeoPackage export: one layer per geometry type, field names a
File Geodatabase accepts, and a real .gdb that reads back."""

import os

import pytest

import cat.api.db_projects as dbp


def _ann(aid, geometry, **props):
    return {"annotation_id": aid, "project_id": 1, "created_by": "Ed", "created_at": None,
            "updated_at": None, "version": 1, "geometry": geometry, "properties": props}


POLY = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [0, 1], [0, 0]]]}
LINE = {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}
POINT = {"type": "Point", "coordinates": [0, 0]}
PROJECTS = {1: {"name": "Reef A", "region": "BAK", "year": 2026}}


def test_field_names_are_valid_and_unique_ignoring_case():
    taken = set()
    names = [dbp._gis_field_name(k, taken) for k in ("spcode", "SPCODE", "Size cm", "1st", "OBJECTID", "Shape", "")]
    assert names == ["spcode", "SPCODE_2", "Size_cm", "f_1st", "attr_OBJECTID", "attr_Shape", "field"]


def test_one_layer_per_geometry_type_and_server_fields_win():
    anns = [
        _ann(1, POLY, spcode="ACUR", annotation_id=999),
        _ann(2, {"type": "MultiPolygon", "coordinates": [POLY["coordinates"]]}, spcode="PMEA"),
        _ann(3, LINE, spcode="X", nested={"a": 1}),
        _ann(4, POINT),
        _ann(5, None),  # no geometry: skipped, not an error
    ]
    layers, skipped = dbp._build_gis_layers(PROJECTS, anns, {"ACUR": "Acropora"})

    assert set(layers) == {"cat_polygons", "cat_lines", "cat_points"}
    assert skipped == 1
    polys = layers["cat_polygons"]
    assert set(polys.geometry.geom_type) == {"MultiPolygon"}  # one type per layer
    assert list(polys["annotation_id"]) == [1, 2]  # stored "annotation_id" doesn't override
    assert polys.iloc[0]["taxon_name"] == "Acropora"
    assert polys.iloc[0]["project_name"] == "Reef A"
    assert layers["cat_lines"].iloc[0]["nested"] == '{"a": 1}'
    assert str(polys.crs) == "EPSG:4326"


def test_property_that_is_sometimes_text_is_stored_as_text():
    layers, _ = dbp._build_gis_layers(PROJECTS, [_ann(1, POINT, size=5), _ann(2, POINT, size="large")], {})
    assert list(layers["cat_points"]["size"]) == ["5", "large"]


def test_writes_a_file_geodatabase_that_reads_back(tmp_path):
    pyogrio = pytest.importorskip("pyogrio")
    if "OpenFileGDB" not in pyogrio.list_drivers(write=True):
        pytest.skip("GDAL without File Geodatabase write support")
    layers, _ = dbp._build_gis_layers(PROJECTS, [_ann(1, POLY, spcode="ACUR"), _ann(2, LINE)], {})
    path = os.path.join(tmp_path, "t.gdb")
    for name, gdf in layers.items():
        gdf.to_file(path, layer=name, driver="OpenFileGDB")
    back = pyogrio.read_dataframe(path, layer="cat_polygons")
    assert back.iloc[0]["spcode"] == "ACUR"
    assert int(back.iloc[0]["project_year"]) == 2026

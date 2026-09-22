"""
Shapefile -> annotation import (preview + execute).

The Project Manager's create flow lets you drop a shapefile's components
(.shp/.shx/.dbf/.prj/...) instead of a JSON annotation file: the first call
reports the shapefile's columns so the UI can render a column-mapping table,
and the second converts the features into CAT annotations using the mapping
the analyst chose.

Both endpoints were called by cat/web/project_creator.html but had no
server-side implementation at all (and the client pointed them at a
hardcoded http://localhost:8000), so the whole path failed. They live here
rather than in db_projects.py because neither one touches Oracle: they are
pure file-in/JSON-out converters, usable in file mode as well as DB mode.

Conventions follow the existing shapefile handling in
db_projects.py::upload_shapefile_to_layer -- geopandas for the read, the
components written to a TemporaryDirectory (geopandas needs the sidecars
next to the .shp on disk), and reprojection to EPSG:4326 for web display.
"""

import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from cat.api.auth import require_auth

router = APIRouter(prefix="/api/annotations", tags=["annotation-import"])

# Number of features returned to the client as a mapping preview. The UI
# renders these in a small table under the column mapper; the full feature
# set is only materialised by /import/execute-components.
PREVIEW_FEATURE_LIMIT = 5

# The annotation fields an analyst may map a shapefile column onto. Names and
# order mirror DEFAULT_COLUMNS in cat/web/js/v2-table.js, which is the closest
# thing the app has to a canonical annotation schema -- keep the two in step.
# `required` drives the asterisk in the mapping dropdown only; the import does
# not reject an unmapped required field, because a shapefile legitimately may
# not carry e.g. the analyst's name, and the create form fills those in.
ANNOTATION_FIELDS: List[Dict[str, Any]] = [
    {"name": "site", "required": True, "description": "Site code"},
    {"name": "spcode", "required": True, "description": "Species code"},
    {"name": "analyst", "required": False, "description": "Analyst name/initials"},
    {"name": "obs_year", "required": False, "description": "Observation year"},
    {"name": "mission_id", "required": False, "description": "Mission / cruise ID"},
    {"name": "transect", "required": False, "description": "Transect"},
    {"name": "segment", "required": False, "description": "Segment"},
    {"name": "seglength", "required": False, "description": "Segment length"},
    {"name": "segwidth", "required": False, "description": "Segment width"},
    {"name": "colony_id", "required": False, "description": "Colony ID"},
    {"name": "morph_code", "required": False, "description": "Morphology code"},
    {"name": "juvenile", "required": False, "description": "Juvenile (-1 yes / 0 no)"},
    {"name": "juv_substrate", "required": False, "description": "Juvenile substrate"},
    {"name": "no_colony", "required": False, "description": "No colony (-1 yes / 0 no)"},
    {"name": "remnant", "required": False, "description": "Remnant (-1 yes / 0 no)"},
    {"name": "fragment", "required": False, "description": "Fragment (-1 yes / 0 no)"},
    {"name": "ex_bound", "required": False, "description": "Extends beyond boundary"},
    {"name": "old_dead", "required": False, "description": "Old dead %"},
    {"name": "line_length_m", "required": False, "description": "Line length (m)"},
    {"name": "rdcause1", "required": False, "description": "Recent dead cause 1"},
    {"name": "rd_1", "required": False, "description": "Recent dead 1 %"},
    {"name": "rdcause2", "required": False, "description": "Recent dead cause 2"},
    {"name": "rd_2", "required": False, "description": "Recent dead 2 %"},
    {"name": "rdcause3", "required": False, "description": "Recent dead cause 3"},
    {"name": "rd_3", "required": False, "description": "Recent dead 3 %"},
    {"name": "con_1", "required": False, "description": "Condition 1"},
    {"name": "extent_1", "required": False, "description": "Condition 1 extent %"},
    {"name": "sev_1", "required": False, "description": "Condition 1 severity"},
    {"name": "con_2", "required": False, "description": "Condition 2"},
    {"name": "extent_2", "required": False, "description": "Condition 2 extent %"},
    {"name": "sev_2", "required": False, "description": "Condition 2 severity"},
    {"name": "con_3", "required": False, "description": "Condition 3"},
    {"name": "extent_3", "required": False, "description": "Condition 3 extent %"},
    {"name": "sev_3", "required": False, "description": "Condition 3 severity"},
]

# Fields the client sends as integers/floats. Shapefile DBF columns are often
# typed as strings (or as floats where an int is meant), so coerce rather than
# pass whatever the DBF happened to hold straight into the annotation.
_INT_FIELDS = {
    "obs_year", "segment", "colony_id", "juvenile", "no_colony", "remnant",
    "fragment", "ex_bound", "old_dead", "rd_1", "rd_2", "rd_3",
    "extent_1", "extent_2", "extent_3", "sev_1", "sev_2", "sev_3",
}
_FLOAT_FIELDS = {"seglength", "segwidth", "line_length_m"}


def _require_geopandas():
    try:
        import geopandas as gpd  # noqa: F401
        return gpd
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="geopandas is not installed on the server. Run: pip install geopandas",
        )


async def _materialise_components(
    tmpdir: str,
    shp_file: UploadFile,
    sidecars: Dict[str, Optional[UploadFile]],
) -> Path:
    """Write the uploaded components to disk under one stem.

    geopandas/GDAL resolves sidecars by filename next to the .shp, so the
    parts have to share a basename regardless of what the browser called
    them -- a .dbf uploaded as "foo (1).dbf" would otherwise be ignored and
    the features would silently come back with no attributes.
    """
    stem = Path(shp_file.filename or "layer").stem
    base = Path(tmpdir) / stem

    shp_path = base.with_suffix(".shp")
    shp_path.write_bytes(await shp_file.read())

    for suffix, upload in sidecars.items():
        if upload is None:
            continue
        (base.with_suffix(suffix)).write_bytes(await upload.read())

    return shp_path


def _read_features(shp_path: Path):
    """Read a shapefile and reproject to WGS84, as the web map expects."""
    gpd = _require_geopandas()

    # Dragging only the .shp is the most common mistake here, and GDAL's own
    # message for it names a temp path the analyst has never seen. Check first
    # and say which file to add.
    missing = [
        suffix for suffix in (".shx", ".dbf")
        if not shp_path.with_suffix(suffix).exists()
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=(
                "Shapefile is incomplete — missing "
                + ", ".join(missing)
                + ". Select every component of the shapefile (.shp, .shx, .dbf and .prj)."
            ),
        )

    try:
        gdf = gpd.read_file(shp_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read shapefile: {exc}")

    if gdf.empty:
        raise HTTPException(status_code=400, detail="Shapefile contains no features")

    source_epsg = None
    try:
        if gdf.crs is not None:
            source_epsg = gdf.crs.to_epsg()
            if source_epsg != 4326:
                gdf = gdf.to_crs(epsg=4326)
    except Exception as exc:
        # A missing/!unreadable .prj is common in field data. Say so plainly
        # rather than importing coordinates that are silently in the wrong CRS.
        raise HTTPException(
            status_code=400,
            detail=(
                "Shapefile has no usable coordinate system (.prj). Include the .prj "
                f"file so coordinates can be converted to WGS84. ({exc})"
            ),
        )

    return gdf, source_epsg


def _json_safe(value: Any) -> Any:
    """Make a DBF/pandas value JSON-serialisable.

    pandas hands back numpy scalars, NaT and NaN; json.dumps chokes on the
    first and emits invalid JSON (`NaN`) for the last.
    """
    if value is None:
        return None
    if isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    # numpy scalar -> python scalar
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _json_safe(item())
        except Exception:
            pass
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    text = str(value)
    return None if text in ("nan", "NaT", "None") else text


def _coerce(field: str, value: Any) -> Any:
    value = _json_safe(value)
    if value is None or value == "":
        return None
    if field in _INT_FIELDS:
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None
    if field in _FLOAT_FIELDS:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    return value


def _column_type(dtype) -> str:
    name = str(dtype)
    if name.startswith(("int", "uint")):
        return "integer"
    if name.startswith("float"):
        return "number"
    if name.startswith("datetime"):
        return "date"
    if name == "bool":
        return "boolean"
    return "text"


@router.post("/import/preview-components")
async def preview_shapefile_components(
    shp_file: UploadFile = File(...),
    shx_file: Optional[UploadFile] = File(None),
    dbf_file: Optional[UploadFile] = File(None),
    prj_file: Optional[UploadFile] = File(None),
    cpg_file: Optional[UploadFile] = File(None),
    xml_file: Optional[UploadFile] = File(None),
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Inspect an uploaded shapefile and describe its columns.

    Returns the shape the Project Manager's mapping table expects:
    `shapefile_columns` for the left side, `annotation_fields` for the
    dropdown, `sample_features` for the preview rows (and for auto-filling
    project metadata), and `total_features` for the summary line.
    """
    with TemporaryDirectory() as tmpdir:
        shp_path = await _materialise_components(
            tmpdir,
            shp_file,
            {
                ".shx": shx_file,
                ".dbf": dbf_file,
                ".prj": prj_file,
                ".cpg": cpg_file,
                ".shp.xml": xml_file,
            },
        )
        gdf, source_epsg = _read_features(shp_path)

        geometry_column = gdf.geometry.name
        columns = [
            {"name": str(col), "type": _column_type(gdf[col].dtype)}
            for col in gdf.columns
            if col != geometry_column
        ]

        sample = []
        for _, row in gdf.head(PREVIEW_FEATURE_LIMIT).iterrows():
            properties = {
                str(col): _json_safe(row[col])
                for col in gdf.columns
                if col != geometry_column
            }
            geometry = row[geometry_column]
            sample.append({
                "properties": properties,
                "geometry_type": geometry.geom_type if geometry is not None else None,
            })

        geometry_types = sorted({
            str(t) for t in gdf.geom_type.dropna().unique().tolist()
        })

        return {
            "total_features": int(len(gdf)),
            "shapefile_columns": columns,
            "annotation_fields": ANNOTATION_FIELDS,
            "sample_features": sample,
            "geometry_types": geometry_types,
            "source_epsg": source_epsg,
            "layer_name": shp_path.stem,
        }


@router.post("/import/execute-components")
async def execute_shapefile_components(
    shp_file: UploadFile = File(...),
    shx_file: Optional[UploadFile] = File(None),
    dbf_file: Optional[UploadFile] = File(None),
    prj_file: Optional[UploadFile] = File(None),
    cpg_file: Optional[UploadFile] = File(None),
    xml_file: Optional[UploadFile] = File(None),
    column_mapping: str = Form("{}"),
    analyst: Optional[str] = Form(None),
    obs_year: Optional[str] = Form(None),
    mission_id: Optional[str] = Form(None),
    site_name: Optional[str] = Form(None),
    ortho_file: Optional[str] = Form(None),
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Convert shapefile features into CAT annotations using a column mapping.

    `column_mapping` is a JSON object of {shapefile_column: annotation_field},
    exactly as the mapping table builds it. Unmapped columns are dropped.

    Annotations come back flat -- `{geometry, site, spcode, ...}` -- which is
    the same shape the JSON-import path produces, so everything downstream
    (metadata auto-fill, the generated project file, and
    normalizeAnnotationForDb before bulk-replace) handles them unchanged.
    """
    try:
        mapping = json.loads(column_mapping or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid column_mapping JSON: {exc}")
    if not isinstance(mapping, dict):
        raise HTTPException(status_code=400, detail="column_mapping must be a JSON object")

    known_fields = {field["name"] for field in ANNOTATION_FIELDS}
    unknown = sorted(set(mapping.values()) - known_fields)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown annotation field(s) in mapping: {', '.join(unknown)}",
        )

    # Form defaults only fill a field the mapping didn't claim, so a real
    # column in the shapefile always beats the create form's placeholder.
    defaults = {
        "analyst": analyst,
        "obs_year": obs_year,
        "mission_id": mission_id,
        "site": site_name,
        "ortho_file": ortho_file,
    }
    defaults = {
        key: value for key, value in defaults.items()
        if value not in (None, "", "Unknown")
    }

    with TemporaryDirectory() as tmpdir:
        shp_path = await _materialise_components(
            tmpdir,
            shp_file,
            {
                ".shx": shx_file,
                ".dbf": dbf_file,
                ".prj": prj_file,
                ".cpg": cpg_file,
                ".shp.xml": xml_file,
            },
        )
        gdf, source_epsg = _read_features(shp_path)

        geometry_column = gdf.geometry.name
        mapped_fields = set(mapping.values())
        annotations: List[Dict[str, Any]] = []
        skipped_no_geometry = 0

        for _, row in gdf.iterrows():
            geometry = row[geometry_column]
            if geometry is None or geometry.is_empty:
                skipped_no_geometry += 1
                continue

            annotation: Dict[str, Any] = {
                "geometry": json.loads(json.dumps(geometry.__geo_interface__)),
            }

            for source_column, target_field in mapping.items():
                if source_column not in gdf.columns:
                    continue
                value = _coerce(target_field, row[source_column])
                if value is not None:
                    annotation[target_field] = value

            for key, value in defaults.items():
                if key in mapped_fields or key in annotation:
                    continue
                annotation[key] = _coerce(key, value)

            annotations.append(annotation)

        return {
            "annotations": annotations,
            "total_features": int(len(gdf)),
            "imported": len(annotations),
            "skipped_no_geometry": skipped_no_geometry,
            "source_epsg": source_epsg,
        }

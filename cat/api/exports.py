"""Annotation exports to GIS formats (Shapefile, KML, GeoPackage).

Moved out of the removed file-mode API (cat/api/file_projects.py), where
these routes had no authentication. The annotation page posts the
annotations it has loaded (same request shape as before); the file is built
in a temporary directory and streamed back.
"""

import io
import logging
import os
import re
import tempfile
import zipfile
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import StreamingResponse

from cat.api.auth import require_auth

router = APIRouter(prefix="/api/exports", tags=["exports"])
logger = logging.getLogger(__name__)


def _safe_name(value: Any, fallback: str) -> str:
    """Filename-safe fragment. The names come from the request and end up in
    both a temp-file path and a Content-Disposition header."""
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "")).strip("._")
    return text[:80] or fallback


def _request_parts(data: Dict[str, Any]):
    annotations = data.get("annotations", [])
    if not annotations:
        raise HTTPException(status_code=400, detail="No annotations provided")
    project_name = _safe_name(data.get("project_name"), "annotations")
    site = _safe_name(data.get("site"), "unknown")
    return annotations, project_name, site


def _shapefile_properties(ann: Dict[str, Any]) -> Dict[str, Any]:
    # Shapefile (DBF) field names are limited to 10 characters.
    return {
        "ANALYST": ann.get("analyst", ""),
        "OBS_YEAR": ann.get("obs_year", None),
        "MISSION_ID": ann.get("mission_id", ""),
        "SITE": ann.get("site", ""),
        "TRANSECT": ann.get("transect", ""),
        "SEGMENT": ann.get("segment", None),
        "SEGLENGTH": ann.get("seglength", None),
        "SEGWIDTH": ann.get("segwidth", None),
        "NO_COLONY": ann.get("no_colony", 0),
        "SPCODE": ann.get("spcode", ""),
        "JUVENILE": ann.get("juvenile", 0),
        "JUV_SUBST": ann.get("juv_substrate", ""),
        "REMNANT": ann.get("remnant", 0),
        "FRAGMENT": ann.get("fragment", 0),
        "MORPH_CODE": ann.get("morph_code", ""),
        "EX_BOUND": ann.get("ex_bound", 0),
        "OLD_DEAD": ann.get("old_dead", None),
        "RDCAUSE1": ann.get("rdcause1", ""),
        "RD_1": ann.get("rd_1", None),
        "RDCAUSE2": ann.get("rdcause2", ""),
        "RD_2": ann.get("rd_2", None),
        "RDCAUSE3": ann.get("rdcause3", ""),
        "RD_3": ann.get("rd_3", None),
        "CON_1": ann.get("con_1", ""),
        "EXTENT_1": ann.get("extent_1", None),
        "SEV_1": ann.get("sev_1", None),
        "CON_2": ann.get("con_2", ""),
        "EXTENT_2": ann.get("extent_2", None),
        "SEV_2": ann.get("sev_2", None),
        "CON_3": ann.get("con_3", ""),
        "EXTENT_3": ann.get("extent_3", None),
        "SEV_3": ann.get("sev_3", None),
        "CREATED": (ann.get("created_at") or "")[:10],
    }


def _full_properties(ann: Dict[str, Any]) -> Dict[str, Any]:
    # KML / GeoPackage have no 10-character limit, so full names are kept.
    return {
        "analyst": ann.get("analyst", ""),
        "obs_year": ann.get("obs_year", None),
        "mission_id": ann.get("mission_id", ""),
        "site": ann.get("site", ""),
        "transect": ann.get("transect", ""),
        "segment": ann.get("segment", None),
        "no_colony": ann.get("no_colony", 0),
        "spcode": ann.get("spcode", ""),
        "juvenile": ann.get("juvenile", 0),
        "remnant": ann.get("remnant", 0),
        "fragment": ann.get("fragment", 0),
        "morph_code": ann.get("morph_code", ""),
        "con_1": ann.get("con_1", ""),
        "extent_1": ann.get("extent_1", None),
        "sev_1": ann.get("sev_1", None),
        "con_2": ann.get("con_2", ""),
        "extent_2": ann.get("extent_2", None),
        "sev_2": ann.get("sev_2", None),
        "con_3": ann.get("con_3", ""),
        "extent_3": ann.get("extent_3", None),
        "sev_3": ann.get("sev_3", None),
        "created_at": (ann.get("created_at") or "")[:10],
    }


def _to_geodataframe(annotations: list, properties_fn):
    import geopandas as gpd
    from shapely.geometry import shape

    rows, geoms = [], []
    for ann in annotations:
        if not isinstance(ann, dict) or not ann.get("geometry"):
            continue
        geoms.append(shape(ann["geometry"]))
        rows.append(properties_fn(ann))
    if not geoms:
        raise HTTPException(status_code=400, detail="No annotations with geometry to export")
    return gpd.GeoDataFrame(rows, geometry=geoms, crs="EPSG:4326")


def _export_failed(kind: str, exc: Exception):
    if isinstance(exc, HTTPException):
        raise exc
    if isinstance(exc, ImportError):
        logger.error("Missing package for %s export: %s", kind, exc)
        raise HTTPException(status_code=500, detail="Missing required package (geopandas/shapely/fiona)")
    logger.exception("Error exporting %s", kind)
    raise HTTPException(status_code=500, detail=f"Error exporting {kind}: {exc}")


@router.post("/shapefile")
def export_shapefile(data: Dict = Body(...), _user: Dict[str, Any] = Depends(require_auth)):
    """Zipped ESRI Shapefile of the given annotations."""
    try:
        annotations, project_name, site = _request_parts(data)
        gdf = _to_geodataframe(annotations, _shapefile_properties)
        base_name = f"{project_name}_{site}_annotations"
        with tempfile.TemporaryDirectory() as tmpdir:
            base = os.path.join(tmpdir, base_name)
            gdf.to_file(base + ".shp", driver="ESRI Shapefile")
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                for ext in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
                    if os.path.exists(base + ext):
                        zf.write(base + ext, base_name + ext)
        buffer.seek(0)
        return StreamingResponse(
            buffer,
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename={base_name}_shapefile.zip"},
        )
    except Exception as exc:
        _export_failed("shapefile", exc)


@router.post("/kml")
def export_kml(data: Dict = Body(...), _user: Dict[str, Any] = Depends(require_auth)):
    """KML of the given annotations."""
    try:
        annotations, project_name, site = _request_parts(data)
        gdf = _to_geodataframe(annotations, _full_properties)
        name = f"{project_name}_{site}_annotations.kml"
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, name)
            gdf.to_file(path, driver="KML")
            with open(path, "rb") as fh:
                buffer = io.BytesIO(fh.read())
        return StreamingResponse(
            buffer,
            media_type="application/vnd.google-earth.kml+xml",
            headers={"Content-Disposition": f"attachment; filename={name}"},
        )
    except Exception as exc:
        _export_failed("KML", exc)


@router.post("/geopackage")
def export_geopackage(data: Dict = Body(...), _user: Dict[str, Any] = Depends(require_auth)):
    """GeoPackage of the given annotations."""
    try:
        annotations, project_name, site = _request_parts(data)
        gdf = _to_geodataframe(annotations, _full_properties)
        name = f"{project_name}_{site}_annotations.gpkg"
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, name)
            gdf.to_file(path, driver="GPKG", layer="annotations")
            with open(path, "rb") as fh:
                buffer = io.BytesIO(fh.read())
        return StreamingResponse(
            buffer,
            media_type="application/geopackage+sqlite3",
            headers={"Content-Disposition": f"attachment; filename={name}"},
        )
    except Exception as exc:
        _export_failed("GeoPackage", exc)

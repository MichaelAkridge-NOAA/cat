"""
Server-side raster derivative tools: hillshade, slope, and zonal statistics.

Consistent with CAT's existing raster-handling conventions:
  - rasterio/numpy calls directly in the request handler (not a subprocess
    script like cat/scripts/make_cog.py) -- these are fast, single-purpose
    operations, unlike the heavy COG conversion make_cog.py exists to isolate.
  - Derived outputs are cached on disk under ~/.cat/derived_raster_cache/,
    mirroring ensure_local_cs_vrt()'s cache under ~/.cat/vrt_cache/
    (cat/server.py): a hash of the source + tool + params is the cache key,
    and a plain existence check decides reuse (no mtime/staleness tracking,
    same tradeoff the VRT cache already makes).
  - Generated rasters are written as COGs (via rio-cogeo, the same profile
    machinery make_cog.py uses) so they can be served through the existing
    TiTiler /tiles endpoint exactly like any other COG -- pass the returned
    `path` as the tile layer's `url` query param client-side.
"""

import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Dict

from fastapi import APIRouter, Depends, HTTPException, Query

from cat.api.auth import require_auth
from cat.db.oracle import fetch_one

router = APIRouter(prefix="/api/raster", tags=["raster-tools"])

USER_DATA_DIR = Path.home() / ".cat"
DERIVED_CACHE_DIR = USER_DATA_DIR / "derived_raster_cache"
DERIVED_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _cache_key(src: str, tool: str, params: Dict[str, Any]) -> str:
    payload = json.dumps({"src": src, "tool": tool, "params": params}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _compute_hillshade(band, dx: float, dy: float, params: Dict[str, Any]):
    """Standard analytical hillshade (same formula family as gdaldem hillshade)."""
    import numpy as np

    elevation = band.filled(np.nan) if hasattr(band, "filled") else band
    z_factor = float(params.get("z_factor", 1.0))
    gy, gx = np.gradient(elevation * z_factor, dy, dx)
    slope = np.pi / 2.0 - np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    azimuth_rad = np.radians(360.0 - float(params.get("azimuth", 315.0)))
    altitude_rad = np.radians(float(params.get("altitude", 45.0)))
    shaded = (
        np.sin(altitude_rad) * np.sin(slope)
        + np.cos(altitude_rad) * np.cos(slope) * np.cos(azimuth_rad - np.pi / 2.0 - aspect)
    )
    return np.clip(255.0 * (shaded + 1.0) / 2.0, 0, 255)


def _compute_slope(band, dx: float, dy: float, params: Dict[str, Any]):
    import numpy as np

    elevation = band.filled(np.nan) if hasattr(band, "filled") else band
    gy, gx = np.gradient(elevation, dy, dx)
    rise_run = np.hypot(gx, gy)
    if params.get("units") == "percent":
        return rise_run * 100.0
    return np.degrees(np.arctan(rise_run))


def _generate_derivative(src: str, tool: str, params: Dict[str, Any], compute_fn: Callable) -> Dict[str, Any]:
    key = _cache_key(src, tool, params)
    out_path = DERIVED_CACHE_DIR / f"{tool}_{key}.tif"
    if out_path.exists():
        return {"success": True, "path": str(out_path), "cached": True}

    try:
        import numpy as np
        import rasterio
        from rio_cogeo.cogeo import cog_translate
        from rio_cogeo.profiles import cog_profiles
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=f"Missing required package: {exc}")

    tmp_path = out_path.with_suffix(".tmp.tif")
    try:
        with rasterio.open(src) as ds:
            band = ds.read(1, masked=True)
            profile = ds.profile.copy()
            pixel_x = abs(ds.transform.a)
            pixel_y = abs(ds.transform.e)

        result = compute_fn(band, pixel_x, pixel_y, params)
        result = np.where(np.isnan(result), -9999.0, result).astype("float32")

        out_profile = profile.copy()
        out_profile.update(dtype="float32", count=1, nodata=-9999.0, compress="deflate")
        out_profile.pop("blockxsize", None)
        out_profile.pop("blockysize", None)
        with rasterio.open(tmp_path, "w", **out_profile) as dst:
            dst.write(result, 1)

        cog_translate(str(tmp_path), str(out_path), cog_profiles.get("deflate"), in_memory=False, quiet=True)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error generating {tool}: {exc}")
    finally:
        if tmp_path.exists():
            tmp_path.unlink()

    return {"success": True, "path": str(out_path), "cached": False}


@router.get("/hillshade")
def get_hillshade(
    src: str = Query(..., description="Raster path/URL — the same value already used as the tile layer's 'url' param"),
    azimuth: float = Query(315.0, ge=0, le=360),
    altitude: float = Query(45.0, ge=0, le=90),
    z_factor: float = Query(1.0, gt=0),
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    return _generate_derivative(
        src, "hillshade", {"azimuth": azimuth, "altitude": altitude, "z_factor": z_factor}, _compute_hillshade
    )


@router.get("/slope")
def get_slope(
    src: str = Query(..., description="Raster path/URL — the same value already used as the tile layer's 'url' param"),
    units: str = Query("degrees", pattern="^(degrees|percent)$"),
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    return _generate_derivative(src, "slope", {"units": units}, _compute_slope)


@router.get("/zonal-stats")
def get_zonal_stats(
    src: str = Query(..., description="DEM/COG raster path or URL to sample"),
    project_id: int = Query(...),
    annotation_id: int = Query(...),
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Pixel statistics (min/max/mean/std/count) of `src` within one
    annotation's polygon. Reuses the same feature_geojson column every other
    annotation endpoint in cat/api/db_projects.py reads from; queried
    directly here (rather than importing db_projects) to avoid a cross-module
    import cycle between the two API routers."""
    row = fetch_one(
        """
        SELECT feature_geojson FROM cat_annotations
        WHERE project_id = :project_id AND annotation_id = :annotation_id AND deleted_at IS NULL
        """,
        {"project_id": project_id, "annotation_id": annotation_id},
    )
    if not row:
        raise HTTPException(status_code=404, detail="Annotation not found")

    raw = row.get("feature_geojson")
    feature = json.loads(raw) if isinstance(raw, str) else raw
    geometry = feature.get("geometry") if isinstance(feature, dict) else None
    if not geometry or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        raise HTTPException(status_code=400, detail="Annotation geometry must be a Polygon/MultiPolygon for zonal statistics")

    try:
        import numpy as np
        import rasterio
        from rasterio.mask import mask as rio_mask
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=f"Missing required package: {exc}")

    try:
        with rasterio.open(src) as ds:
            out_image, _ = rio_mask(ds, [geometry], crop=True, filled=False)
            band = out_image[0]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error computing zonal statistics: {exc}")

    valid = band.compressed() if hasattr(band, "compressed") else band[~np.isnan(band)]
    if valid.size == 0:
        return {"success": True, "count": 0, "min": None, "max": None, "mean": None, "std": None}

    return {
        "success": True,
        "count": int(valid.size),
        "min": float(np.min(valid)),
        "max": float(np.max(valid)),
        "mean": float(np.mean(valid)),
        "std": float(np.std(valid)),
    }

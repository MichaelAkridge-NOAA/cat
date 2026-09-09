"""SAM3 AI segmentation API for CAT.

Thin proxy in front of the separate SAM3 GPU microservice
(services/sam3-service/, reachable at CAT_SEGMENTATION_SERVICE_URL). Resolves
CAT's own COG URL / LOCAL_CS-VRT conventions to a filesystem path the GPU
service can open, forwards prompts to it, and optionally converts the
returned features into CAT annotations via the bulk-create endpoint.
"""

from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from cat.api.auth import require_auth
from cat.segmentation.config import get_segmentation_settings, is_segmentation_enabled

router = APIRouter(prefix="/api/segmentation", tags=["segmentation"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class BBox(BaseModel):
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float


class PointPromptIn(BaseModel):
    lon: float
    lat: float
    label: int = 1


class TextSegmentRequest(BaseModel):
    cog_url: str
    bbox: BBox
    prompt: str = Field(default="coral", max_length=200)
    project_id: Optional[int] = None
    asset_id: Optional[int] = None
    auto_save: bool = True
    save_diameter_line: bool = False


class PointSegmentRequest(BaseModel):
    cog_url: str
    points: List[PointPromptIn]
    bbox: Optional[BBox] = None
    project_id: Optional[int] = None
    asset_id: Optional[int] = None
    auto_save: bool = True
    save_diameter_line: bool = False


class BoxSegmentRequest(BaseModel):
    cog_url: str
    bbox: BBox
    project_id: Optional[int] = None
    asset_id: Optional[int] = None
    auto_save: bool = True
    save_diameter_line: bool = False


class TiledSegmentRequest(BaseModel):
    cog_url: str
    bbox: BBox
    prompt: str = Field(default="coral", max_length=200)
    project_id: Optional[int] = None
    asset_id: Optional[int] = None
    auto_save: bool = True
    save_diameter_line: bool = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_raster_path(cog_url: str) -> str:
    """Resolve a CAT cog_url to a filesystem path the SAM3 service can open.

    Mirrors the LOCAL_CS handling in cat/server.py's /api/check-cog-crs: if
    the raster's native CRS is a non-standard LOCAL_CS, use the cached VRT
    override (relabelled as EPSG:4326) instead of the raw path, so
    segmentation crops line up with what the Leaflet frontend displays.
    """
    # Deferred import: cat.server imports this router before it defines
    # these helpers (its optional-feature try/except block runs earlier in
    # the module than the LOCAL_CS helper definitions), so a top-of-file
    # import here would raise a circular-import ImportError at startup.
    from cat.server import ensure_local_cs_vrt, _is_local_cs, _gdal_path

    import rasterio

    gdal_p = _gdal_path(cog_url)
    try:
        with rasterio.open(gdal_p) as src:
            crs_wkt = src.crs.to_wkt() if src.crs else ""
    except Exception:
        crs_wkt = ""

    if _is_local_cs(crs_wkt):
        vrt_path = ensure_local_cs_vrt(cog_url)
        if vrt_path is not None:
            return vrt_path

    return _gdal_path(cog_url)


async def _call_segmentation_service(path: str, payload: dict) -> dict:
    settings = get_segmentation_settings()
    if not is_segmentation_enabled():
        raise HTTPException(status_code=503, detail="Segmentation feature is disabled")

    try:
        async with httpx.AsyncClient(timeout=settings.timeout_s) as client:
            resp = await client.post(f"{settings.service_url}{path}", json=payload)
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Segmentation service timed out")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Segmentation service unavailable")

    if resp.status_code == 413:
        try:
            detail = resp.json().get("detail", "Selection too large")
        except Exception:
            detail = "Selection too large"
        raise HTTPException(status_code=413, detail=detail)

    if resp.status_code == 507:
        raise HTTPException(status_code=507, detail="GPU out of memory -- try a smaller area")

    if resp.status_code == 503:
        try:
            detail = resp.json().get("detail", "SAM3 is busy processing another request")
        except Exception:
            detail = "SAM3 is busy processing another request"
        raise HTTPException(status_code=503, detail=detail)

    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError:
        raise HTTPException(status_code=resp.status_code, detail=f"Segmentation service error: {resp.text}")

    return resp.json()


def _features_to_annotations(
    features: List[dict],
    method: str,
    prompt: Optional[str],
    asset_id: Optional[int],
    created_by: Optional[str],
    save_diameter_line: bool = False,
) -> List[dict]:
    # Deferred import -- mirrors the existing db_projects import inside
    # _handle_result() below (avoids a circular import at module load time).
    from cat.api.db_projects import _polygon_max_diameter_line, _haversine_distance_m

    annotations: List[dict] = []
    for feat in features:
        geometry = feat["geometry"]
        annotations.append(
            {
                "asset_id": asset_id,
                "feature": {
                    "type": "Feature",
                    "geometry": geometry,
                    "properties": {},
                },
                "properties": {
                    "detection_method": method,
                    "prompt": prompt,
                    "confidence": feat.get("confidence"),
                },
                "created_by": created_by,
            }
        )

        if save_diameter_line and geometry.get("type") in ("Polygon", "MultiPolygon"):
            line_geom = _polygon_max_diameter_line(geometry)
            if line_geom is not None:
                p1, p2 = line_geom["coordinates"]
                # Same haversine convention _polygon_max_diameter_line used
                # to pick the pair -- recomputed here only to store the
                # value, not to re-derive the geometry.
                diameter_m = _haversine_distance_m(p1, p2)
                annotations.append(
                    {
                        "asset_id": asset_id,
                        "feature": {
                            "type": "Feature",
                            "geometry": line_geom,
                            "properties": {},
                        },
                        "properties": {
                            "detection_method": f"{method}-diameter",
                            "prompt": prompt,
                            "confidence": feat.get("confidence"),
                            "derived_from": "sam3_diameter",
                            # size_cm mirrors the existing hard-coded "cm"
                            # display convention (annotation-runtime-panel-ui.js);
                            # diameter_m is the stable raw value for report/analysis.
                            "size_cm": round(diameter_m * 100, 1),
                            "diameter_m": round(diameter_m, 4),
                        },
                        "created_by": created_by,
                    }
                )
    return annotations


async def _handle_result(result: dict, payload, method: str, current_user: dict) -> dict:
    features = result.get("features", [])

    if not payload.auto_save or not payload.project_id:
        return {"success": True, "saved": False, "features": features}

    annotations = _features_to_annotations(
        features,
        method,
        getattr(payload, "prompt", None),
        payload.asset_id,
        current_user.get("display_name"),
        getattr(payload, "save_diameter_line", False),
    )

    if not annotations:
        return {"success": True, "saved": True, "count": 0, "annotations": []}

    from cat.api.db_projects import bulk_create_annotations, AnnotationBulkCreate, AnnotationCreate

    bulk_payload = AnnotationBulkCreate(annotations=[AnnotationCreate(**a) for a in annotations])
    saved = await run_in_threadpool(bulk_create_annotations, payload.project_id, bulk_payload, current_user)
    return {"success": True, "saved": True, **saved}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/status")
async def segmentation_status() -> Dict[str, Any]:
    """Report whether the SAM3 segmentation service is configured and reachable.

    Always returns 200 -- never raises -- so the frontend can poll this to
    decide whether to show the AI toolbar at all.

    `state` is the field the frontend should branch its display on:
    "disabled" (feature off), "unreachable" (service down/network issue),
    "error" (service up but model failed to load), "cpu" (loaded but no
    GPU -- functional but very slow), "busy" (another request is currently
    running -- a single GPU only serves one at a time), or "ready".
    `available` is kept for backwards compat: true for "cpu"/"busy"/"ready"
    (the feature CAN be used, even if degraded/queued), false otherwise.
    """
    settings = get_segmentation_settings()
    if not is_segmentation_enabled():
        return {"available": False, "state": "disabled", "reason": "disabled"}

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{settings.service_url}/health")
            resp.raise_for_status()
            health = resp.json()
    except Exception as exc:
        return {"available": False, "state": "unreachable", "reason": f"service unreachable: {exc}"}

    model_loaded = bool(health.get("model_loaded"))
    state = health.get("state", "error" if not model_loaded else "ready")
    reason = {
        "error": health.get("error"),
        "busy": "SAM3 is processing another request -- try again shortly",
        "cpu": "Running on CPU (no GPU detected) -- segmentation will be very slow",
    }.get(state)

    return {
        "available": state in ("ready", "cpu", "busy"),
        "state": state,
        "device": health.get("device"),
        "busy": bool(health.get("busy")),
        "reason": reason,
    }


@router.post("/text")
async def segment_text(
    payload: TextSegmentRequest,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    raster_path = await run_in_threadpool(_resolve_raster_path, payload.cog_url)
    result = await _call_segmentation_service(
        "/segment/text",
        {
            "raster_path": raster_path,
            "prompt": payload.prompt,
            "bbox": payload.bbox.model_dump(),
        },
    )
    return await _handle_result(result, payload, "sam3-text", current_user)


@router.post("/point")
async def segment_point(
    payload: PointSegmentRequest,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    raster_path = await run_in_threadpool(_resolve_raster_path, payload.cog_url)
    result = await _call_segmentation_service(
        "/segment/point",
        {
            "raster_path": raster_path,
            "points": [p.model_dump() for p in payload.points],
            "bbox": payload.bbox.model_dump() if payload.bbox else None,
        },
    )
    return await _handle_result(result, payload, "sam3-point", current_user)


@router.post("/box")
async def segment_box(
    payload: BoxSegmentRequest,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    raster_path = await run_in_threadpool(_resolve_raster_path, payload.cog_url)
    result = await _call_segmentation_service(
        "/segment/box",
        {
            "raster_path": raster_path,
            "bbox": payload.bbox.model_dump(),
        },
    )
    return await _handle_result(result, payload, "sam3-box", current_user)


@router.post("/tiled")
async def segment_tiled(
    payload: TiledSegmentRequest,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    raster_path = await run_in_threadpool(_resolve_raster_path, payload.cog_url)
    result = await _call_segmentation_service(
        "/segment/tiled",
        {
            "raster_path": raster_path,
            "prompt": payload.prompt,
            "bbox": payload.bbox.model_dump(),
        },
    )
    return await _handle_result(result, payload, "sam3-tiled", current_user)

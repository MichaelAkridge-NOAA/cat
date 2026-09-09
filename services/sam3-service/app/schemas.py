"""Pydantic request/response models for the SAM3 segmentation service.

Task 1 defines the models needed for `/health` and `/segment/text`.
Task 2 will add request models for `/segment/point`, `/segment/box`, and
`/segment/tiled` to this same module — `SegmentFeature`/`SegmentResponse`
are written to be reused by all of them (the `method` field on
`SegmentResponse` distinguishes which route produced a given response).
"""

from __future__ import annotations

from pydantic import BaseModel


class BBoxNative(BaseModel):
    """A bounding box in EPSG:4326 (lon/lat) degrees."""

    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float


class TextSegmentRequest(BaseModel):
    """Request body for POST /segment/text."""

    raster_path: str
    prompt: str = "coral"
    bbox: BBoxNative
    confidence_threshold: float | None = None


class PointPrompt(BaseModel):
    """A single point click prompt in EPSG:4326 (lon/lat) degrees."""

    lon: float
    lat: float
    label: int = 1  # 1 = positive/foreground, 0 = negative/background


class PointSegmentRequest(BaseModel):
    """Request body for POST /segment/point."""

    raster_path: str
    points: list[PointPrompt]
    bbox: BBoxNative | None = None  # optional crop hint; if omitted, buffer around the points
    confidence_threshold: float | None = None


class BoxSegmentRequest(BaseModel):
    """Request body for POST /segment/box."""

    raster_path: str
    bbox: BBoxNative
    confidence_threshold: float | None = None


class TiledSegmentRequest(BaseModel):
    """Request body for POST /segment/tiled."""

    raster_path: str
    prompt: str = "coral"
    bbox: BBoxNative
    confidence_threshold: float | None = None


class SegmentFeature(BaseModel):
    """A single segmented feature, as a GeoJSON geometry + metadata."""

    geometry: dict
    confidence: float
    area_m2: float | None = None


class SegmentResponse(BaseModel):
    """Common response shape for all /segment/* routes."""

    success: bool
    features: list[SegmentFeature]
    prompt: str | None = None
    method: str
    device: str
    warning: str | None = None


class HealthResponse(BaseModel):
    """Response body for GET /health. This route should never 500 —
    if the model failed to load, `model_loaded` is False and `error`
    carries the reason, but the service itself reports 200 OK.

    `state` is the single field callers should branch on for display:
    "error" (model failed to load), "busy" (another request is currently
    running inference -- a single GPU only serves one request at a time),
    "cpu" (loaded but running without a GPU -- functional but very slow),
    or "ready".
    """

    status: str
    model_loaded: bool
    device: str | None
    checkpoint_path: str
    error: str | None = None
    busy: bool = False
    state: str = "error"

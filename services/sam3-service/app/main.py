"""FastAPI app for the SAM3 segmentation microservice.

Task 1 scaffold: lifespan model load, GET /health, POST /segment/text.
Task 2 will add POST /segment/point, POST /segment/box, and
POST /segment/tiled to this same app, reusing get_model()/get_device()
and the SegmentResponse/SegmentFeature schemas below.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import uuid
from contextlib import asynccontextmanager

import numpy as np
import rasterio
import rasterio.errors
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from app import model as model_module
from app.config import get_sam3_settings
from app.raster_io import (
    CropTooLargeError,
    get_pixel_size_deg,
    get_window_for_bbox,
    mask_to_geojson,
    merge_overlapping_features,
    open_window,
)
from app.schemas import (
    BoxSegmentRequest,
    HealthResponse,
    PointSegmentRequest,
    SegmentFeature,
    SegmentResponse,
    TextSegmentRequest,
    TiledSegmentRequest,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_sam3_settings()
    logger.info("SAM3 service starting up; loading model...")
    model_module.load_model(settings)
    if not model_module.is_model_loaded():
        logger.error(
            "SAM3 model failed to load at startup: %s. Service will stay "
            "up; /health will report model_loaded=false.",
            model_module.get_load_error(),
        )
    yield
    logger.info("SAM3 service shutting down.")


app = FastAPI(title="CAT SAM3 Segmentation Service", lifespan=lifespan)


def _pad_bbox(bbox: dict, fraction: float = 0.25) -> dict:
    """Pad a {min_lon, min_lat, max_lon, max_lat} bbox outward.

    Without this, an object that extends past the edge of a user-drawn
    selection gets hard-clipped by the crop boundary -- the model never
    sees the rest of it, so the returned mask has a straight artificial
    edge instead of following the object's real outline.

    Purely proportional (25% of the bbox's own span) -- NOT floored at a
    fixed absolute degree value. These orthomosaics range from
    reef-survey-scale (hundreds of meters) down to sub-centimeter GSD
    macro shots covering a couple dozen meters total; a fixed floor like
    "0.001 degrees" (~100m) that's a sensible minimum for the former
    silently swallows the ENTIRE raster for the latter (verified this by
    seeing a padded crop equal to the full 42478x15585px raster instead of
    the requested ~2000x700px area). Callers here always start from a
    real, nonzero-area user-drawn box, so proportional-only padding is
    safe -- unlike _bbox_from_points() below, which pads a possibly
    zero-spread single point and needs its own floor.
    """
    lon_spread = bbox["max_lon"] - bbox["min_lon"]
    lat_spread = bbox["max_lat"] - bbox["min_lat"]
    lon_buffer = lon_spread * fraction
    lat_buffer = lat_spread * fraction
    return {
        "min_lon": bbox["min_lon"] - lon_buffer,
        "min_lat": bbox["min_lat"] - lat_buffer,
        "max_lon": bbox["max_lon"] + lon_buffer,
        "max_lat": bbox["max_lat"] + lat_buffer,
    }


def _check_crop_size(raster_path: str, bbox: dict, max_px: int) -> None:
    """Pre-flight size check: reject (413) before reading pixel data if
    the requested bbox, at the raster's native resolution, exceeds
    max_crop_px in either dimension.
    """
    # rasterio.open() on a missing/unopenable path raises RasterioIOError
    # (an OSError subclass), not FileNotFoundError. Let it propagate
    # uncaught here — the route handler's except clause maps it to 404.
    window, _crs = get_window_for_bbox(raster_path, bbox)
    width_px = int(round(window.width))
    height_px = int(round(window.height))
    if width_px > max_px or height_px > max_px:
        raise CropTooLargeError(width_px, height_px, max_px)


def _to_image_array(data: np.ndarray) -> np.ndarray:
    """Convert a rasterio-style (bands, rows, cols) array into the
    (rows, cols, bands) layout SamGeo3.set_image expects for an in-memory
    array. Single-band arrays are squeezed to 2D.
    """
    if data.ndim == 3:
        moved = np.moveaxis(data, 0, -1)
        if moved.shape[-1] == 1:
            return moved[:, :, 0]
        return moved
    return data


def _normalize_for_sam(image: np.ndarray) -> np.ndarray:
    """Normalize a raw rasterio-read crop into a uint8 3-band (RGB) image.

    set_image() on an in-memory array gets no normalization from rasterio
    (open_window() returns the raster's native dtype/band-count untouched),
    unlike the file-based generate_masks_tiled() path, which is tolerant of
    real-world raster layouts. Coral orthomosaics are commonly uint16 or
    float32, and/or carry a 4th alpha band -- passed straight through,
    these have caused set_image()/generate_masks*() to error out for the
    text/point/box routes (only tiled worked). This brings the in-memory
    path in line with what a normal 8-bit RGB image would look like.
    """
    arr = image

    # Reduce to exactly 3 bands (grayscale -> replicate, 4+ -> drop
    # alpha/extra bands, keep the first 3 as RGB).
    if arr.ndim == 2:
        arr = np.stack([arr, arr, arr], axis=-1)
    elif arr.ndim == 3 and arr.shape[-1] != 3:
        if arr.shape[-1] == 1:
            arr = np.repeat(arr, 3, axis=-1)
        else:
            arr = arr[:, :, :3]

    # Rescale to uint8 if not already. Percentile clip (2nd/98th) rather
    # than a plain min/max stretch or bit-shift -- robust to single
    # hot/dead pixels blowing out the scale on real sensor data.
    if arr.dtype != np.uint8:
        arr = arr.astype(np.float32)
        lo = np.percentile(arr, 2)
        hi = np.percentile(arr, 98)
        if hi <= lo:
            lo, hi = float(arr.min()), float(arr.max())
        if hi > lo:
            arr = np.clip((arr - lo) / (hi - lo), 0.0, 1.0) * 255.0
        else:
            arr = np.zeros_like(arr)
        arr = arr.astype(np.uint8)

    return arr


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Never raises/500s — reports current model load state as data."""
    settings = get_sam3_settings()
    loaded = model_module.is_model_loaded()
    busy = model_module.is_busy()
    device = model_module.get_device()

    if not loaded:
        state = "error"
    elif busy:
        state = "busy"
    elif device == "cpu":
        state = "cpu"
    else:
        state = "ready"

    return HealthResponse(
        status="ok" if loaded else "degraded",
        model_loaded=loaded,
        device=device,
        checkpoint_path=settings.checkpoint_path,
        error=model_module.get_load_error(),
        busy=busy,
        state=state,
    )


@app.post("/segment/text", response_model=SegmentResponse)
def segment_text(request: TextSegmentRequest) -> SegmentResponse:
    settings = get_sam3_settings()
    bbox = request.bbox.model_dump()

    sam_model = model_module.get_model()
    if sam_model is None:
        raise HTTPException(
            status_code=503,
            detail=f"SAM3 model is not loaded: {model_module.get_load_error()}",
        )

    padded_bbox = _pad_bbox(bbox)

    try:
        _check_crop_size(request.raster_path, padded_bbox, settings.max_crop_px)

        data, transform, crs = open_window(request.raster_path, padded_bbox)
        image = _normalize_for_sam(_to_image_array(data))

        confidence_threshold = (
            request.confidence_threshold
            if request.confidence_threshold is not None
            else settings.confidence_threshold
        )
        with model_module.acquire_inference():
            # Must come BEFORE set_image(): set_confidence_threshold() with
            # no `state` arg sets self.inference_state = None as a side
            # effect (see Sam3Processor.set_confidence_threshold), which
            # would wipe out the backbone state set_image() computes if
            # called afterward.
            sam_model.set_confidence_threshold(confidence_threshold)
            sam_model.set_image(image)
            # generate_masks() has no return value (despite its type hint)
            # -- results land on the instance as self.masks/self.scores.
            sam_model.generate_masks(prompt=request.prompt, min_size=settings.min_mask_px)

            masks = np.asarray(sam_model.masks) if sam_model.masks else np.empty((0,))
            scores = list(sam_model.scores) if sam_model.scores else []

        raw_features = mask_to_geojson(masks, transform, crs, scores=scores)
        # An open-vocabulary prompt like "coral" can return several
        # overlapping detections for what's visually one colony (no NMS
        # inside generate_masks()) -- merge them into one feature.
        merged_features = merge_overlapping_features(raw_features)
        features = [
            SegmentFeature(geometry=f["geometry"], confidence=f["confidence"], area_m2=None)
            for f in merged_features
        ]

        return SegmentResponse(
            success=True,
            features=features,
            prompt=request.prompt,
            method="text",
            device=model_module.get_device() or settings.device,
        )
    except CropTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except (FileNotFoundError, rasterio.errors.RasterioIOError) as exc:
        # FileNotFoundError is kept alongside RasterioIOError for
        # robustness/forward-compat, but rasterio.open() on a missing
        # path actually raises RasterioIOError (an OSError subclass),
        # not FileNotFoundError.
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except model_module.ModelBusyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except torch.cuda.OutOfMemoryError as exc:
        logger.exception("CUDA OOM during /segment/text")
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - map to 500, log full traceback
        logger.exception("Unexpected error in /segment/text")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _bbox_from_points(points: list, raster_path: str) -> dict:
    """Compute a small crop bbox around a set of lon/lat points when the
    caller didn't supply an explicit bbox. The model needs some image
    context around a point click, not just a single pixel, so we pad the
    min/max extent of the points by a buffer: either a fraction of the
    points' own spread (25%) or a floor of ~80 native pixels of context
    (derived from the raster's own resolution), whichever is larger — this
    keeps single-point clicks (zero spread) usable while still giving
    multi-point prompts a bit of breathing room proportional to their
    extent. The floor is resolution-relative rather than a fixed degree
    value because these orthomosaics range from reef-survey-scale (hundreds
    of meters) down to sub-centimeter-GSD macro shots covering a couple
    dozen meters total -- a fixed "0.001 degrees" floor swallows the ENTIRE
    raster on the latter (see _pad_bbox's docstring for the concrete case
    this caused).
    """
    lons = [p.lon for p in points]
    lats = [p.lat for p in points]
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)

    px_w_deg, px_h_deg = get_pixel_size_deg(raster_path)
    context_px = 80
    min_lon_buffer = px_w_deg * context_px
    min_lat_buffer = px_h_deg * context_px

    lon_spread = max_lon - min_lon
    lat_spread = max_lat - min_lat
    lon_buffer = max(min_lon_buffer, lon_spread * 0.25)
    lat_buffer = max(min_lat_buffer, lat_spread * 0.25)

    return {
        "min_lon": min_lon - lon_buffer,
        "min_lat": min_lat - lat_buffer,
        "max_lon": max_lon + lon_buffer,
        "max_lat": max_lat + lat_buffer,
    }


@app.post("/segment/point", response_model=SegmentResponse)
def segment_point(request: PointSegmentRequest) -> SegmentResponse:
    settings = get_sam3_settings()

    sam_model = model_module.get_model()
    if sam_model is None:
        raise HTTPException(
            status_code=503,
            detail=f"SAM3 model is not loaded: {model_module.get_load_error()}",
        )

    bbox = (
        request.bbox.model_dump()
        if request.bbox is not None
        else _bbox_from_points(request.points, request.raster_path)
    )

    try:
        _check_crop_size(request.raster_path, bbox, settings.max_crop_px)

        data, transform, crs = open_window(request.raster_path, bbox)
        image = _normalize_for_sam(_to_image_array(data))

        confidence_threshold = (
            request.confidence_threshold
            if request.confidence_threshold is not None
            else settings.confidence_threshold
        )
        with model_module.acquire_inference():
            # Must come BEFORE set_image() -- see segment_text's comment:
            # set_confidence_threshold() with no `state` arg resets
            # self.inference_state, which would wipe out set_image()'s
            # backbone state if called afterward.
            sam_model.set_confidence_threshold(confidence_threshold)
            sam_model.set_image(image)

            # Convert each point's lon/lat into pixel coords (col, row)
            # relative to this crop's own affine transform via its inverse.
            inv_transform = ~transform
            point_coords = []
            for p in request.points:
                col, row = inv_transform * (p.lon, p.lat)
                point_coords.append([int(round(col)), int(round(row))])
            point_labels = [p.label for p in request.points]

            # generate_masks_by_points() has no return value (despite its
            # type hint) -- results land on self.masks/self.scores.
            sam_model.generate_masks_by_points(
                point_coords=point_coords,
                point_labels=point_labels,
                min_size=settings.min_mask_px,
            )

            masks = np.asarray(sam_model.masks) if sam_model.masks else np.empty((0,))
            scores = list(sam_model.scores) if sam_model.scores else []

        raw_features = mask_to_geojson(masks, transform, crs, scores=scores)
        merged_features = merge_overlapping_features(raw_features)
        features = [
            SegmentFeature(geometry=f["geometry"], confidence=f["confidence"], area_m2=None)
            for f in merged_features
        ]

        return SegmentResponse(
            success=True,
            features=features,
            prompt=None,
            method="point",
            device=model_module.get_device() or settings.device,
        )
    except CropTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except (FileNotFoundError, rasterio.errors.RasterioIOError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except model_module.ModelBusyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except torch.cuda.OutOfMemoryError as exc:
        logger.exception("CUDA OOM during /segment/point")
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - map to 500, log full traceback
        logger.exception("Unexpected error in /segment/point")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/segment/box", response_model=SegmentResponse)
def segment_box(request: BoxSegmentRequest) -> SegmentResponse:
    settings = get_sam3_settings()
    bbox = request.bbox.model_dump()

    sam_model = model_module.get_model()
    if sam_model is None:
        raise HTTPException(
            status_code=503,
            detail=f"SAM3 model is not loaded: {model_module.get_load_error()}",
        )

    # Pad the requested bbox outward before cropping, so the crop provides
    # context around the target box rather than being identical to it (a
    # box prompt that covers the crop's entire extent isn't a meaningful
    # box prompt).
    padded_bbox = _pad_bbox(bbox)

    try:
        _check_crop_size(request.raster_path, padded_bbox, settings.max_crop_px)

        data, transform, crs = open_window(request.raster_path, padded_bbox)
        image = _normalize_for_sam(_to_image_array(data))

        confidence_threshold = (
            request.confidence_threshold
            if request.confidence_threshold is not None
            else settings.confidence_threshold
        )
        with model_module.acquire_inference():
            # Must come BEFORE set_image() -- see segment_text's comment:
            # set_confidence_threshold() with no `state` arg resets
            # self.inference_state, which would wipe out set_image()'s
            # backbone state if called afterward.
            sam_model.set_confidence_threshold(confidence_threshold)
            sam_model.set_image(image)

            # Convert the ORIGINAL (unpadded) requested box into pixel
            # coordinates relative to this (padded) crop's own affine
            # transform, mirroring segment_point()'s inverse-affine pattern.
            # min/max explicitly needed since a north-up affine's row axis
            # is typically inverted relative to latitude.
            inv_transform = ~transform
            x1, y1 = inv_transform * (bbox["min_lon"], bbox["min_lat"])
            x2, y2 = inv_transform * (bbox["max_lon"], bbox["max_lat"])
            pixel_box = [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]

            # generate_masks_by_boxes() has no return value (despite its
            # type hint) -- results land on self.masks/self.scores.
            sam_model.generate_masks_by_boxes(boxes=[pixel_box], min_size=settings.min_mask_px)

            masks = np.asarray(sam_model.masks) if sam_model.masks else np.empty((0,))
            scores = list(sam_model.scores) if sam_model.scores else []

        raw_features = mask_to_geojson(masks, transform, crs, scores=scores)
        merged_features = merge_overlapping_features(raw_features)
        features = [
            SegmentFeature(geometry=f["geometry"], confidence=f["confidence"], area_m2=None)
            for f in merged_features
        ]

        return SegmentResponse(
            success=True,
            features=features,
            prompt=None,
            method="box",
            device=model_module.get_device() or settings.device,
        )
    except CropTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except (FileNotFoundError, rasterio.errors.RasterioIOError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except model_module.ModelBusyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except torch.cuda.OutOfMemoryError as exc:
        logger.exception("CUDA OOM during /segment/box")
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - map to 500, log full traceback
        logger.exception("Unexpected error in /segment/box")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/segment/tiled", response_model=SegmentResponse)
def segment_tiled(request: TiledSegmentRequest) -> SegmentResponse:
    settings = get_sam3_settings()
    bbox = request.bbox.model_dump()

    sam_model = model_module.get_model()
    if sam_model is None:
        raise HTTPException(
            status_code=503,
            detail=f"SAM3 model is not loaded: {model_module.get_load_error()}",
        )

    tmp_dir = os.path.join(tempfile.gettempdir(), "sam3-tiled", str(uuid.uuid4()))

    try:
        # Enforce max_tiled_px (not max_crop_px) as the pre-flight safety
        # cap for this route.
        _check_crop_size(request.raster_path, bbox, settings.max_tiled_px)

        data, transform, crs = open_window(request.raster_path, bbox)

        os.makedirs(tmp_dir, exist_ok=True)
        input_path = os.path.join(tmp_dir, "crop.tif")
        # generate_masks_tiled() writes a single-band labeled *raster* mask
        # (uint32, one unique value per object), not GeoJSON -- despite the
        # route needing GeoJSON features, so this gets vectorized below via
        # raster_to_vector() into a separate .geojson file.
        mask_raster_path = os.path.join(tmp_dir, "mask.tif")
        output_path = os.path.join(tmp_dir, "output.geojson")

        count = data.shape[0] if data.ndim == 3 else 1
        height = data.shape[-2]
        width = data.shape[-1]
        with rasterio.open(
            input_path,
            "w",
            driver="GTiff",
            height=height,
            width=width,
            count=count,
            dtype=data.dtype,
            crs=crs,
            transform=transform,
        ) as dst:
            if data.ndim == 3:
                dst.write(data)
            else:
                dst.write(data, 1)

        confidence_threshold = (
            request.confidence_threshold
            if request.confidence_threshold is not None
            else settings.confidence_threshold
        )
        with model_module.acquire_inference():
            sam_model.set_confidence_threshold(confidence_threshold)

            sam_model.generate_masks_tiled(
                source=input_path,
                prompt=request.prompt,
                output=mask_raster_path,
                tile_size=settings.tile_size_px,
                overlap=settings.tile_overlap_px,
                min_size=settings.min_mask_px,
            )

        # raster_to_vector() is pure CPU polygonization of the already-
        # written mask file -- no shared model state touched, so it runs
        # outside the lock to free the GPU for the next request sooner.
        #
        # dst_crs is REQUIRED here: raster_to_vector() (see samgeo.common)
        # sets the output's CRS from the mask raster's own native CRS and
        # does NOT reproject unless told to. mask_raster_path was written
        # using the crop's native transform/crs (whatever the source COG
        # uses), so without this, any raster not already in EPSG:4326 would
        # silently produce coordinates in the wrong CRS -- geometries that
        # look "valid" but are placed at the wrong location entirely (only
        # went unnoticed in testing because that test raster happened to
        # already be native EPSG:4326).
        sam_model.raster_to_vector(raster=mask_raster_path, vector=output_path, dst_crs="EPSG:4326")

        with open(output_path, "r", encoding="utf-8") as f:
            geojson_data = json.load(f)

        raw_features = []
        for feat in geojson_data.get("features", []):
            props = feat.get("properties") or {}
            confidence = props.get("confidence", props.get("score", 1.0))
            raw_features.append({"geometry": feat["geometry"], "confidence": float(confidence)})

        # generate_masks_tiled() has no cross-tile object identity, so a
        # single real object spanning tile overlaps comes back as several
        # duplicate polygons -- merge anything whose geometries overlap or
        # nearly touch (a small gap tolerance bridges sub-pixel seams left
        # by resize/interpolation exactly at tile boundaries).
        merged_features = merge_overlapping_features(raw_features, gap_tolerance_deg=1e-7)
        features = [
            SegmentFeature(geometry=f["geometry"], confidence=f["confidence"], area_m2=None)
            for f in merged_features
        ]

        return SegmentResponse(
            success=True,
            features=features,
            prompt=request.prompt,
            method="tiled",
            device=model_module.get_device() or settings.device,
        )
    except CropTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except (FileNotFoundError, rasterio.errors.RasterioIOError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except model_module.ModelBusyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except torch.cuda.OutOfMemoryError as exc:
        logger.exception("CUDA OOM during /segment/tiled")
        raise HTTPException(status_code=507, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - map to 500, log full traceback
        logger.exception("Unexpected error in /segment/tiled")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc: Exception) -> JSONResponse:
    """Last-resort catch-all: never leak a raw traceback to the caller."""
    logger.exception("Unhandled exception for %s %s", request.method, request.url)
    return JSONResponse(status_code=500, content={"detail": str(exc)})

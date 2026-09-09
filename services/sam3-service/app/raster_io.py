"""Windowed rasterio read/crop, CRS reprojection, and mask -> GeoJSON helpers.

Kept as a small, self-contained module rather than depending on
`segment-geospatial`'s internal `raster_to_vector` helper, whose import
path has moved across versions — polygonizing a numpy mask with
`rasterio.features.shapes()` is a handful of lines and much more stable
to depend on here.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import rasterio
import rasterio.features
import rasterio.warp
import rasterio.windows
from pyproj import Transformer
from rasterio.crs import CRS
from shapely.geometry import shape as shapely_shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

logger = logging.getLogger(__name__)

WGS84 = CRS.from_epsg(4326)


class CropTooLargeError(Exception):
    """Raised when a requested bbox, at the raster's native resolution,
    would exceed the configured max_crop_px in width or height.
    """

    def __init__(self, width_px: int, height_px: int, max_px: int):
        self.width_px = width_px
        self.height_px = height_px
        self.max_px = max_px
        super().__init__(
            f"Requested crop ({width_px}x{height_px}px) exceeds max_crop_px={max_px}"
        )


def get_pixel_size_deg(raster_path: str) -> tuple[float, float]:
    """Return (pixel_width_deg, pixel_height_deg) -- the raster's native
    pixel size expressed in EPSG:4326 degrees, approximated by dividing its
    reprojected-to-WGS84 bounds by its pixel dimensions.

    Used to derive a resolution-relative padding floor (e.g. "at least N
    pixels of context") instead of a fixed absolute degree value: these
    orthomosaics range from reef-survey-scale (hundreds of meters) down to
    sub-centimeter-GSD macro shots covering a couple dozen meters total, so
    a single fixed-degree constant is either useless on one end or
    swallows the entire raster on the other (see _pad_bbox's docstring in
    main.py for the concrete failure this caused).
    """
    with rasterio.open(raster_path) as src:
        if src.crs is not None and CRS(src.crs) != WGS84:
            left, bottom, right, top = rasterio.warp.transform_bounds(
                src.crs, WGS84, *src.bounds
            )
        else:
            left, bottom, right, top = src.bounds
        width_deg = (right - left) / src.width if src.width else 0.0
        height_deg = (top - bottom) / src.height if src.height else 0.0
        return width_deg, height_deg


def _bbox_to_native_crs(
    bbox: dict[str, float], src_crs: CRS
) -> tuple[float, float, float, float]:
    """Reproject a {min_lon, min_lat, max_lon, max_lat} EPSG:4326 bbox into
    the raster's native CRS. Returns (left, bottom, right, top) in that CRS.
    """
    min_lon, min_lat = bbox["min_lon"], bbox["min_lat"]
    max_lon, max_lat = bbox["max_lon"], bbox["max_lat"]

    if src_crs is None or CRS(src_crs) == WGS84:
        return min_lon, min_lat, max_lon, max_lat

    transformer = Transformer.from_crs(WGS84, src_crs, always_xy=True)
    xs, ys = transformer.transform(
        [min_lon, max_lon, min_lon, max_lon],
        [min_lat, max_lat, max_lat, min_lat],
    )
    return min(xs), min(ys), max(xs), max(ys)


def get_window_for_bbox(
    raster_path: str, bbox: dict[str, float]
) -> tuple[rasterio.windows.Window, CRS]:
    """Compute (without reading pixel data) the pixel Window a bbox covers
    at the raster's native resolution, clamped to the raster's extent.

    Used for the pre-flight max_crop_px size check before an actual read.
    """
    with rasterio.open(raster_path) as src:
        left, bottom, right, top = _bbox_to_native_crs(bbox, src.crs)
        window = rasterio.windows.from_bounds(
            left, bottom, right, top, transform=src.transform
        )
        window = window.intersection(
            rasterio.windows.Window(0, 0, src.width, src.height)
        )
        return window, src.crs


def open_window(
    raster_path: str, bbox: dict[str, float]
) -> tuple[np.ndarray, rasterio.Affine, CRS]:
    """Read the portion of `raster_path` covering `bbox` (EPSG:4326 dict
    with min_lon/min_lat/max_lon/max_lat keys).

    Returns (array, transform, crs) where `array` is the cropped pixel
    data (bands, rows, cols), `transform` is the affine transform for
    that crop, and `crs` is the raster's native CRS.
    """
    with rasterio.open(raster_path) as src:
        src_crs = src.crs
        left, bottom, right, top = _bbox_to_native_crs(bbox, src_crs)
        window = rasterio.windows.from_bounds(
            left, bottom, right, top, transform=src.transform
        )
        window = window.intersection(
            rasterio.windows.Window(0, 0, src.width, src.height)
        )
        data = src.read(window=window)
        transform = rasterio.windows.transform(window, src.transform)
        return data, transform, src_crs


def mask_to_geojson(
    mask: np.ndarray,
    transform: rasterio.Affine,
    crs: CRS,
    scores: list[float] | None = None,
) -> list[dict[str, Any]]:
    """Polygonize a boolean/uint8 mask (or stack of masks) into GeoJSON
    geometries in EPSG:4326, each paired with a confidence score.

    `mask` may be a single (H, W) array or a stack of (N, H, W) arrays
    (one mask per detected instance). `scores`, if given, must have the
    same length as the number of masks and is zipped in by index.

    Returns a list of {"geometry": <geojson geom dict>, "confidence": float}.
    """
    if mask.ndim == 2:
        masks = mask[None, ...]
    else:
        masks = mask

    if scores is not None and len(scores) != masks.shape[0]:
        logger.warning(
            "mask_to_geojson: %d masks but %d scores; scores will be "
            "truncated/padded with 1.0",
            masks.shape[0],
            len(scores),
        )

    needs_reproject = crs is not None and CRS(crs) != WGS84

    features: list[dict[str, Any]] = []
    for idx in range(masks.shape[0]):
        band = np.asarray(masks[idx]).astype("uint8")
        if not band.any():
            continue

        score = 1.0
        if scores is not None and idx < len(scores):
            score = float(scores[idx])

        for geom, value in rasterio.features.shapes(
            band, mask=band.astype(bool), transform=transform
        ):
            if value == 0:
                continue
            out_geom = geom
            if needs_reproject:
                out_geom = rasterio.warp.transform_geom(crs, WGS84, geom)
            features.append({"geometry": out_geom, "confidence": score})

    return features


def merge_overlapping_features(
    features: list[dict[str, Any]],
    gap_tolerance_deg: float = 0.0,
) -> list[dict[str, Any]]:
    """Merge features whose geometries overlap (or nearly touch) into one.

    Two situations produce several polygons for what's really one object:
    (1) tiled segmentation (generate_masks_tiled) runs each tile through the
    model independently with no cross-tile object identity, so a single
    object spanning tile overlaps comes back as separate polygons that may
    not even literally overlap -- resize/interpolation at the tile boundary
    can leave a microscopic gap between them; (2) an open-vocabulary prompt
    (e.g. "coral") can return multiple overlapping detections for one
    object even in a single, untiled crop (generate_masks() applies no
    NMS/deduplication itself). `gap_tolerance_deg` bridges case (1)'s tiny
    seam gaps by testing intersection on slightly buffered copies; the
    final merged geometry still unions the ORIGINAL (unbuffered) shapes, so
    the output isn't artificially inflated.
    """
    if len(features) <= 1:
        return features

    geoms: list[BaseGeometry] = []
    test_geoms: list[BaseGeometry] = []
    for f in features:
        g = shapely_shape(f["geometry"])
        if not g.is_valid:
            g = g.buffer(0)
        geoms.append(g)
        test_geoms.append(g.buffer(gap_tolerance_deg) if gap_tolerance_deg > 0 else g)

    # Union-find over pairwise intersection -- O(n^2), acceptable for the
    # hundreds-of-objects scale a single segmentation request produces.
    parent = list(range(len(geoms)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    for i in range(len(geoms)):
        for j in range(i + 1, len(geoms)):
            if test_geoms[i].intersects(test_geoms[j]):
                union(i, j)

    groups: dict[int, list[int]] = {}
    for idx in range(len(geoms)):
        groups.setdefault(find(idx), []).append(idx)

    merged: list[dict[str, Any]] = []
    for members in groups.values():
        if len(members) == 1:
            merged.append(features[members[0]])
            continue
        merged_geom = unary_union([geoms[m] for m in members])
        best_confidence = max(features[m]["confidence"] for m in members)
        merged.append(
            {
                "geometry": merged_geom.__geo_interface__,
                "confidence": best_confidence,
            }
        )

    return merged

"""
COG thumbnail rendering for project cards and the site browser.

A project list that is all text can't tell a 412-annotation orthomosaic from
an empty one. These endpoints turn any COG the app already knows about into
a small PNG, so the Project Manager and the Sites page can show the imagery
itself rather than a filename.

Why not just point an <img> at the mounted TiTiler?
  /preview.png?url=... does exist (cat/server.py mounts TilerFactory), but it
  re-reads the COG's overviews from GCS on every request. A project list of
  20 cards would issue 20 cold range-reads against remote storage on every
  page load. Here the render happens once and the PNG is cached on disk,
  keyed by source URL + render options, so the second load is a file read.

The cache mirrors the conventions already used by cat/api/raster_tools.py
(~/.cat/<name>_cache, a sha256 of the inputs as the key, plain existence
check for reuse -- no staleness tracking). A COG is an immutable artefact of
a conversion run, so a changed image means a changed URL in practice; the
`refresh=1` escape hatch covers the case where someone overwrites one in
place.
"""

import hashlib
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from cat.gdal_env import GCS_GDAL_ENV, gdal_path

logger = logging.getLogger(__name__)

router = APIRouter(tags=["thumbnails"])

USER_DATA_DIR = Path.home() / ".cat"
THUMBNAIL_CACHE_DIR = USER_DATA_DIR / "thumbnail_cache"
THUMBNAIL_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Bounds on the requested size. The cache key includes the size, so an
# unbounded value would let anyone fill the disk with one render per pixel
# width; these cover a list row (96) through a detail panel (512).
MIN_SIZE = 32
MAX_SIZE = 512
DEFAULT_SIZE = 256

# Colormap used when the source is elevation rather than imagery. Matches the
# DEM default in the annotation layer panel (annotation-runtime-project-layers.js).
DEM_COLORMAP = "viridis"

# Cached renders are served with a long max-age: the URL fully determines the
# bytes (same reasoning as the disk cache), and a stale card thumbnail is the
# least consequential thing in the app.
CACHE_CONTROL = "public, max-age=86400"

# Upper bound on the cache directory. Nothing here is precious -- an evicted
# entry costs one re-render -- but the process runs in a container with a
# fixed disk, so an unbounded cache is a slow-motion outage. At ~5-55 KB a
# thumbnail this holds thousands, far more than any project list needs.
# Override with CAT_THUMBNAIL_CACHE_MB for a deployment with a smaller disk.
try:
    CACHE_BUDGET_BYTES = int(float(os.environ.get("CAT_THUMBNAIL_CACHE_MB", "200")) * 1024 * 1024)
except ValueError:
    CACHE_BUDGET_BYTES = 200 * 1024 * 1024


def _cache_path(url: str, size: int) -> Path:
    key = hashlib.sha256(f"{url}|{size}".encode()).hexdigest()[:20]
    return THUMBNAIL_CACHE_DIR / f"{key}.png"


def _looks_like_dem(*hints: Optional[str]) -> bool:
    """Guess from names whether an asset is elevation rather than imagery.

    Used only to CHOOSE between a project's assets (prefer the orthomosaic).
    How a source is rendered is decided by its actual band count, not by its
    name -- see _render_png. Same "type == DEM or 'dem' in the name" rule the
    annotation page uses to pick its DEM controls.
    """
    for hint in hints:
        if not hint:
            continue
        lowered = str(hint).lower()
        if lowered == "dem" or "dem" in lowered:
            return True
    return False


def _render_png(url: str, size: int) -> bytes:
    """Read a COG's overviews and return a small PNG.

    Uses rio-tiler's Reader directly rather than an HTTP round-trip to the
    app's own tile endpoints: it is the same library TiTiler runs on, and
    preview() reads from the COG's overview pyramid, so the cost is a couple
    of range requests rather than a full-resolution decode.
    """
    try:
        import rasterio
        from rio_tiler.io import Reader
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise HTTPException(
            status_code=500,
            detail=f"Raster libraries unavailable on the server: {exc}",
        )

    with rasterio.Env(**GCS_GDAL_ENV):
        with Reader(gdal_path(url)) as src:
            band_count = len(src.dataset.indexes)

            # preview() reads the smallest overview that satisfies max_size,
            # which is what keeps a 600 MB DEM to a sub-second render. A source
            # with no overview pyramid forces a decimated read of every block
            # instead — still correct, but seconds-to-minutes on a large file.
            # Worth saying out loud, since the fix is to run the COG converter
            # over it rather than anything in this endpoint.
            if not src.dataset.overviews(1):
                logger.warning(
                    "Thumbnail source has no overviews, render will be slow: %s "
                    "(%s x %s) — convert it to a proper COG",
                    url, src.dataset.width, src.dataset.height,
                )

            # The band count decides how to render, not the filename: a
            # colormap needs exactly one band, so deciding from a name would
            # fail on a 3-band file that happens to have "dem" in it and
            # would miss a single-band elevation file that doesn't.
            colorize = band_count == 1

            # Imagery with more than three bands (e.g. RGB + alpha from a
            # drone mosaic) would render as an invalid 4-plus-mask PNG, so
            # read just the visible bands.
            indexes = (1, 2, 3) if (not colorize and band_count > 3) else None
            image = src.preview(max_size=size, indexes=indexes)

            if colorize:
                # Elevation is a single band of metres; stretch it across the
                # colormap using the data's own 2nd/98th percentiles so a few
                # outlier pixels can't flatten the whole image to one colour.
                from rio_tiler.colormap import cmap

                low, high = _percentile_range(image, 2, 98)
                if high <= low:
                    high = low + 1.0
                image.rescale(in_range=((low, high),))
                return image.render(img_format="PNG", colormap=cmap.get(DEM_COLORMAP))

            # Imagery: let rio-tiler write the mask as alpha, so nodata edges
            # come back transparent rather than as a black block.
            return image.render(img_format="PNG", add_mask=True)


def _percentile_range(image, low_pct: float, high_pct: float):
    """Percentile bounds over an ImageData's VALID pixels only.

    Reads through ImageData.array, which is a numpy MaskedArray, so
    .compressed() drops nodata exactly. Do not reach for ImageData.mask
    here: in rio-tiler 9 it is a float32 array (±3.4e38), not a boolean, so
    `mask.astype(bool)` is true for every pixel including nodata. That bug
    made a real survey DEM (nodata -32767, seabed -7..-2 m) stretch across
    -32767..-3, i.e. render as one flat colour -- and it was invisible
    against synthetic test data that declares a nodata value but contains
    no nodata pixels.

    Both bounds come from one pass, since compressing a preview twice to
    compute two percentiles is pure waste.
    """
    import numpy as np

    arr = getattr(image, "array", None)
    if isinstance(arr, np.ma.MaskedArray):
        valid = arr.compressed()
    else:
        valid = np.asarray(image.data).ravel()

    valid = valid[np.isfinite(valid)]
    if valid.size == 0:
        return 0.0, 1.0
    lo, hi = np.percentile(valid, [low_pct, high_pct])
    return float(lo), float(hi)


def render_cached_thumbnail(url: str, size: int, refresh: bool = False) -> Path:
    """Return a path to the cached PNG for this source, rendering if needed."""
    path = _cache_path(url, size)

    if path.exists() and not refresh:
        return path

    png = _render_png(url, size)

    # Write via a temp file in the same directory, then replace: two requests
    # for the same uncached thumbnail arrive together on any project list, and
    # a half-written PNG served to the first one would be cached by the browser.
    tmp = path.with_suffix(f".{hashlib.sha1(png[:64]).hexdigest()[:8]}.tmp")
    tmp.write_bytes(png)
    tmp.replace(path)

    _evict_if_over_budget()
    return path


def _evict_if_over_budget() -> None:
    """Keep the cache directory under CACHE_BUDGET_BYTES, oldest out first.

    Only runs after a miss (a hit never grows the directory), so the scan
    cost lands on the render path that just spent a second reading a COG,
    not on the hits that matter for a list view. Sweeps down to 80% of the
    budget rather than to exactly the budget, so a full cache doesn't
    re-scan on every single subsequent render.

    Eviction is by mtime, i.e. by when the entry was written. That is
    approximate LRU at best -- serving a cached file doesn't bump its
    mtime -- but the cost of being wrong is one re-render, which does not
    justify tracking access times.
    """
    try:
        entries = []
        total = 0
        for f in THUMBNAIL_CACHE_DIR.glob("*.png"):
            try:
                st = f.stat()
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, f))
            total += st.st_size

        if total <= CACHE_BUDGET_BYTES:
            return

        target = int(CACHE_BUDGET_BYTES * 0.8)
        entries.sort()  # oldest first
        removed = 0
        for _mtime, size, f in entries:
            if total <= target:
                break
            try:
                f.unlink()
                total -= size
                removed += 1
            except OSError:
                continue

        if removed:
            logger.info(
                "Thumbnail cache over %.0f MB, evicted %d entries (now %.0f MB)",
                CACHE_BUDGET_BYTES / 1048576, removed, total / 1048576,
            )
    except Exception as exc:
        # Never fail a render because housekeeping failed.
        logger.warning("Thumbnail cache eviction failed: %s", exc)


def _png_response(path: Path, filename: str) -> FileResponse:
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": CACHE_CONTROL},
        filename=filename,
    )


def _clamp_size(size: int) -> int:
    return max(MIN_SIZE, min(MAX_SIZE, size))


@router.get("/api/thumbnails/cog")
def cog_thumbnail(
    url: str = Query(..., description="COG URL or gs:// URI to render"),
    size: int = Query(DEFAULT_SIZE, ge=MIN_SIZE, le=MAX_SIZE),
    refresh: bool = Query(False, description="Re-render even if a cached PNG exists"),
):
    """Thumbnail for any COG URL.

    Used by the Sites page, whose COG URIs come from a GCS scan and have no
    project row behind them. Imagery and elevation are told apart by band
    count at render time, so the caller doesn't have to say which it is.
    """
    if not url.strip():
        raise HTTPException(status_code=400, detail="url is required")

    try:
        path = render_cached_thumbnail(url, _clamp_size(size), refresh)
    except HTTPException:
        raise
    except Exception as exc:
        # A missing or unreadable COG is routine here (a site whose imagery
        # hasn't been converted yet), so log it and 404 rather than 500 --
        # the client just falls back to its placeholder.
        logger.info("Thumbnail render failed for %s: %s", url, exc)
        raise HTTPException(status_code=404, detail=f"Could not render thumbnail: {exc}")

    return _png_response(path, f"thumbnail-{_clamp_size(size)}.png")


@router.get("/api/db/projects/{project_id}/thumbnail")
def project_thumbnail(
    project_id: int,
    size: int = Query(DEFAULT_SIZE, ge=MIN_SIZE, le=MAX_SIZE),
    refresh: bool = Query(False, description="Re-render even if a cached PNG exists"),
):
    """Thumbnail for a DB project, rendered from its first orthomosaic asset.

    Prefers imagery over elevation: a project with both a DEM and an
    orthomosaic should show the photo. Falls back to the DEM when that is all
    the project has, so an elevation-only project still gets a picture.
    """
    try:
        from cat.db.oracle import fetch_all
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database backend unavailable: {exc}")

    try:
        assets = fetch_all(
            "SELECT asset_id, asset_type, asset_name, cog_url FROM cat_project_assets "
            "WHERE project_id = :project_id ORDER BY created_at ASC",
            {"project_id": project_id},
        )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Could not read project assets: {exc}")

    usable = [a for a in assets if (a.get("cog_url") or "").strip()]
    if not usable:
        raise HTTPException(status_code=404, detail="Project has no imagery to render")

    ortho = next(
        (a for a in usable
         if not _looks_like_dem(a.get("asset_type"), a.get("asset_name"), a.get("cog_url"))),
        None,
    )
    asset = ortho or usable[0]

    try:
        path = render_cached_thumbnail(asset["cog_url"], _clamp_size(size), refresh)
    except HTTPException:
        raise
    except Exception as exc:
        logger.info("Project %s thumbnail failed (%s): %s", project_id, asset.get("cog_url"), exc)
        raise HTTPException(status_code=404, detail=f"Could not render thumbnail: {exc}")

    return _png_response(path, f"project-{project_id}.png")

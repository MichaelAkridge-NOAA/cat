"""Environment-driven configuration for the SAM3 segmentation microservice.

Mirrors the frozen-dataclass + `_parse_bool_env` pattern used by
`cat/db/config.py` in the main CAT app, so the two services read
similarly even though they are otherwise fully independent.
"""

from dataclasses import dataclass
import os


def _parse_bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _parse_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def _parse_float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return default


@dataclass(frozen=True)
class Sam3Settings:
    """Settings for the SAM3 model + service limits.

    checkpoint_path: local filesystem path to the SAM3 checkpoint weights
        (loaded with load_from_HF=False — no network access at model-load
        time is assumed).
    device: "cuda" or "cpu". If "cuda" is requested but unavailable at
        runtime, app/model.py falls back to "cpu" and logs a warning
        rather than crashing.
    confidence_threshold / mask_threshold: forwarded to SamGeo3's
        constructor.
    max_crop_px: maximum width/height (in native raster pixels) allowed
        for a single-shot crop (used by /segment/text and other
        non-tiled routes added in Task 2).
    max_tiled_px: maximum width/height allowed for the tiled route
        (Task 2's /segment/tiled).
    tile_size_px / tile_overlap_px: tiling parameters for the tiled
        route (Task 2).
    request_timeout_s: soft timeout budget for a single segmentation
        request, in seconds.
    """

    checkpoint_path: str = ""
    device: str = "cuda"
    confidence_threshold: float = 0.5
    mask_threshold: float = 0.5
    max_crop_px: int = 4096
    max_tiled_px: int = 16384
    tile_size_px: int = 1024
    tile_overlap_px: int = 128
    request_timeout_s: int = 120
    # SamGeo3's internal ViT resolution -- every crop/tile is resized to
    # resolution x resolution before inference. MUST stay at the model's
    # trained default (1008): the ViT backbone's rotary position embeddings
    # (freqs_cis) are precomputed for a fixed patch grid at model-init time
    # and are NOT recomputed when this changes, so any other value crashes
    # with AssertionError: freqs_cis.shape == (x.shape[-2], x.shape[-1]).
    # Verified this the hard way -- do not raise without confirming the
    # installed segment-geospatial/sam3 version actually recomputes
    # freqs_cis for the requested grid size first.
    resolution: int = 1008
    # Masks smaller than this (in pixels, at the crop's/tile's own native
    # resolution) are dropped before vectorization. The fixed 1008x1008
    # inference grid produces noise-sized sliver fragments on large crops --
    # these are both visual clutter ("many annotations for one coral") and
    # nearly unclickable in the UI. 0 disables filtering.
    min_mask_px: int = 64


def get_sam3_settings() -> Sam3Settings:
    return Sam3Settings(
        checkpoint_path=os.getenv("SAM3_CHECKPOINT_PATH", "").strip(),
        device=os.getenv("SAM3_DEVICE", "cuda").strip().lower(),
        confidence_threshold=_parse_float_env("SAM3_CONFIDENCE_THRESHOLD", 0.5),
        mask_threshold=_parse_float_env("SAM3_MASK_THRESHOLD", 0.5),
        max_crop_px=_parse_int_env("SAM3_MAX_CROP_PX", 4096),
        max_tiled_px=_parse_int_env("SAM3_MAX_TILED_PX", 16384),
        tile_size_px=_parse_int_env("SAM3_TILE_SIZE_PX", 1024),
        tile_overlap_px=_parse_int_env("SAM3_TILE_OVERLAP_PX", 128),
        request_timeout_s=_parse_int_env("SAM3_REQUEST_TIMEOUT_S", 120),
        resolution=_parse_int_env("SAM3_RESOLUTION", 1008),
        min_mask_px=_parse_int_env("SAM3_MIN_MASK_PX", 64),
    )

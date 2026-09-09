"""Singleton SamGeo3 model loader.

Loaded eagerly in the FastAPI `lifespan` startup hook (see app/main.py) so
model-loading failures surface immediately in logs at container start
rather than on the first request. A load failure does NOT crash the app —
it leaves the singleton unset and /health reports model_loaded=false plus
the error, so the caller (cat-app) can degrade gracefully instead of
getting connection errors.
"""

from __future__ import annotations

import contextlib
import logging
import threading

import torch
from samgeo.samgeo3 import SamGeo3

from app.config import Sam3Settings

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_model: SamGeo3 | None = None
_device: str | None = None
_load_error: str | None = None

# A single SamGeo3 instance is shared across all requests (loading it twice
# would double GPU memory on hardware -- a T4 -- that's already tight for
# one copy). Its methods mutate shared instance state (self.image,
# self.inference_state, self.masks, ...), so two requests running inference
# concurrently would corrupt each other's in-flight results or crash the
# CUDA context outright. This lock serializes actual GPU inference calls;
# routes acquire it non-blocking (see ModelBusyError below) so a second
# user gets an immediate, clear "busy" response instead of silently
# queueing behind an unknown wait or racing the first user's GPU state.
_inference_lock = threading.Lock()


class ModelBusyError(Exception):
    """Raised when inference is requested while another request already
    holds the GPU (see acquire_inference()). Routes map this to HTTP 503.
    """


def resolve_device(requested_device: str) -> str:
    """Resolve the requested device against actual CUDA availability,
    falling back to CPU (with a warning) rather than crashing if CUDA
    was requested but is not available.
    """
    if requested_device == "cuda" and not torch.cuda.is_available():
        logger.warning(
            "SAM3_DEVICE=cuda requested but torch.cuda.is_available() is "
            "False; falling back to CPU."
        )
        return "cpu"
    return requested_device


def load_model(settings: Sam3Settings) -> None:
    """Load the singleton SamGeo3 instance. Safe to call once at startup.

    On failure, logs the full error and records it in `_load_error` so
    /health can report it, but does not raise — the app stays up.
    """
    global _model, _device, _load_error

    device = resolve_device(settings.device)

    with _lock:
        _device = device
        try:
            logger.info(
                "Loading SAM3 model: checkpoint_path=%s device=%s "
                "confidence_threshold=%s mask_threshold=%s",
                settings.checkpoint_path,
                device,
                settings.confidence_threshold,
                settings.mask_threshold,
            )
            _model = SamGeo3(
                backend="meta",
                checkpoint_path=settings.checkpoint_path,
                load_from_HF=False,
                device=device,
                confidence_threshold=settings.confidence_threshold,
                mask_threshold=settings.mask_threshold,
                # Required for generate_masks_by_points/by_boxes (used by
                # /segment/point and /segment/box) -- without this the Meta
                # backend has no inst_interactive_predictor and those calls
                # raise ValueError("Instance interactivity not enabled...").
                enable_inst_interactivity=True,
                resolution=settings.resolution,
            )
            _load_error = None
            logger.info("SAM3 model loaded successfully.")
        except Exception as exc:  # noqa: BLE001 - intentional: keep app up
            _model = None
            _load_error = str(exc)
            logger.exception("Failed to load SAM3 model: %s", exc)


def get_model() -> SamGeo3 | None:
    """Return the loaded model instance, or None if it failed to load."""
    return _model


def get_device() -> str | None:
    return _device


def get_load_error() -> str | None:
    return _load_error


def is_model_loaded() -> bool:
    return _model is not None


def is_busy() -> bool:
    """Best-effort snapshot for /health -- not used for correctness (the
    actual mutual exclusion is acquire_inference()'s non-blocking acquire).
    """
    return _inference_lock.locked()


@contextlib.contextmanager
def acquire_inference():
    """Serialize GPU inference across concurrent requests.

    Acquires the shared inference lock without blocking: if another
    request already holds it, raises ModelBusyError immediately rather
    than queueing behind an unknown wait (a queued request could still
    outlast the caller's own HTTP timeout, and the frontend has no way to
    show "waiting in line" vs. "broken"). Route handlers catch
    ModelBusyError and return HTTP 503 so the UI can show a clear
    "busy, try again" state distinct from "unavailable".
    """
    if not _inference_lock.acquire(blocking=False):
        raise ModelBusyError(
            "SAM3 is currently processing another request. Please try again shortly."
        )
    try:
        yield
    finally:
        _inference_lock.release()

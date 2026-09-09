"""Segmentation (SAM3) service configuration for CAT."""

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class SegmentationSettings:
    enabled: bool = False
    service_url: str = ""
    timeout_s: int = 90


def _parse_bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def get_segmentation_settings() -> SegmentationSettings:
    try:
        timeout_s = int(os.getenv("CAT_SEGMENTATION_TIMEOUT_S", "90").strip())
    except ValueError:
        timeout_s = 90

    return SegmentationSettings(
        enabled=_parse_bool_env("CAT_SEGMENTATION_ENABLED", default=False),
        service_url=os.getenv("CAT_SEGMENTATION_SERVICE_URL", "").strip().rstrip("/"),
        timeout_s=timeout_s,
    )


def is_segmentation_enabled() -> bool:
    settings = get_segmentation_settings()
    return settings.enabled and bool(settings.service_url)

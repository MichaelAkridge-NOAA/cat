"""
In-memory timing probe for the raster hot path (tiles, statistics, the
LOCAL_CS CRS check, previews).

Exists because diagnosing "the annotation page feels slow" otherwise means
SSHing into a cloud workstation and hand-timing curl requests. Records the
same request prefixes cat/server.py's prepend_data_path_middleware already
singles out, in a fixed-size ring buffer, and exposes them at
/api/debug/tile-stats for the admin-only Debug page (cat/web/debug_stats.html).

Deliberately in-memory only: this is a live probe, not a metrics system --
it resets on every restart and holds no more than RING_SIZE entries. No
auth here (the page link itself is admin-gated in cat-auth.js), no
persistence, nothing to clean up.
"""

import csv
import io
import re
import time
from collections import deque
from typing import Any, Dict, List
from urllib.parse import unquote

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

router = APIRouter(tags=["debug"])

# Same prefixes prepend_data_path_middleware in cat/server.py treats as
# raster-serving requests. Kept as a tuple of (prefix, group_label) so the
# summary groups by endpoint rather than by exact path (which varies with
# z/x/y).
TRACKED_PREFIXES = (
    ("/tiles/", "tiles"),
    ("/statistics", "statistics"),
    ("/api/check-cog-crs", "check-cog-crs"),
    ("/preview", "preview"),
    ("/info", "info"),
    ("/bounds", "bounds"),
)

RING_SIZE = 300
_ring: deque = deque(maxlen=RING_SIZE)


def group_for_path(path: str):
    for prefix, label in TRACKED_PREFIXES:
        if path.startswith(prefix):
            return label
    return None


def _cog_name(url_param: str) -> str:
    """Shorten a COG url/gdal-path query param to just the filename."""
    if not url_param:
        return ""
    decoded = unquote(url_param)
    name = re.split(r"[\\/]", decoded)[-1]
    return name or decoded


def record(path: str, query_string: str, duration_ms: float, status_code: int) -> None:
    group = group_for_path(path)
    if group is None:
        return

    url_param = ""
    for part in (query_string or "").split("&"):
        if part.startswith("url="):
            url_param = part[len("url="):]
            break

    _ring.append({
        "ts": time.time(),
        "group": group,
        "path": path,
        "cog": _cog_name(url_param),
        "ms": round(duration_ms, 1),
        "status": status_code,
    })


def _percentile(sorted_values: List[float], pct: float) -> float:
    if not sorted_values:
        return 0.0
    k = (len(sorted_values) - 1) * (pct / 100.0)
    f = int(k)
    c = min(f + 1, len(sorted_values) - 1)
    if f == c:
        return sorted_values[f]
    return sorted_values[f] + (sorted_values[c] - sorted_values[f]) * (k - f)


@router.get("/api/debug/tile-stats")
def tile_stats() -> Dict[str, Any]:
    """Recent raster-request timings plus a per-endpoint summary.

    Returns entries newest-first so the page's recent-requests table doesn't
    need to reverse anything.
    """
    entries = list(_ring)

    by_group: Dict[str, List[float]] = {}
    for e in entries:
        by_group.setdefault(e["group"], []).append(e["ms"])

    summary = []
    for label in dict.fromkeys(label for _, label in TRACKED_PREFIXES):
        values = sorted(by_group.get(label, []))
        if not values:
            continue
        summary.append({
            "group": label,
            "count": len(values),
            "p50_ms": round(_percentile(values, 50), 1),
            "p95_ms": round(_percentile(values, 95), 1),
            "max_ms": round(values[-1], 1),
        })

    return {
        "ring_size": RING_SIZE,
        "recorded": len(entries),
        "summary": summary,
        "recent": list(reversed(entries)),
    }


@router.get("/api/debug/tile-stats.csv")
def tile_stats_csv() -> StreamingResponse:
    """Dump every entry currently in the ring buffer as CSV.

    Whatever is in memory right now -- no filtering, no re-aggregation --
    since the point is to hand someone the raw numbers behind the summary
    table for a spreadsheet or a bug report.
    """
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["timestamp_iso", "epoch", "group", "path", "cog", "status", "ms"])
    for e in _ring:
        writer.writerow([
            time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(e["ts"])),
            e["ts"],
            e["group"],
            e["path"],
            e["cog"],
            e["status"],
            e["ms"],
        ])
    buf.seek(0)

    filename = f"tile-stats-{int(time.time())}.csv"
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

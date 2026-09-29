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
import os
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

# Non-raster requests whose latency matters for "saving randomly fails" and
# "the header is slow" on cloud workstations. Kept in their own ring so a
# burst of tile requests can't push the saves out of the buffer.
APP_EXACT = {
    "/health": "health",
    "/api/config": "config",
    "/api/auth/me": "auth-me",
}
APP_GROUPS = ("db-write", "db-read", "auth-me", "config", "health")

RING_SIZE = 300
_ring: deque = deque(maxlen=RING_SIZE)
_app_ring: deque = deque(maxlen=RING_SIZE)

# Requests currently inside the app (all paths), and the peak since start.
_in_flight = 0
_in_flight_peak = 0


def group_for_path(path: str, method: str = "GET"):
    for prefix, label in TRACKED_PREFIXES:
        if path.startswith(prefix):
            return label
    if path in APP_EXACT:
        return APP_EXACT[path]
    if path.startswith("/api/db/"):
        return "db-read" if method in ("GET", "HEAD") else "db-write"
    return None


def request_started() -> None:
    global _in_flight, _in_flight_peak
    _in_flight += 1
    if _in_flight > _in_flight_peak:
        _in_flight_peak = _in_flight


def request_finished() -> None:
    global _in_flight
    _in_flight = max(0, _in_flight - 1)


def _cog_name(url_param: str) -> str:
    """Shorten a COG url/gdal-path query param to just the filename."""
    if not url_param:
        return ""
    decoded = unquote(url_param)
    name = re.split(r"[\\/]", decoded)[-1]
    return name or decoded


def record(path: str, query_string: str, duration_ms: float, status_code: int, method: str = "GET") -> None:
    group = group_for_path(path, method)
    if group is None:
        return

    url_param = ""
    for part in (query_string or "").split("&"):
        if part.startswith("url="):
            url_param = part[len("url="):]
            break

    (_app_ring if group in APP_GROUPS else _ring).append({
        "ts": time.time(),
        "group": group,
        "method": method,
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
    entries = sorted(list(_ring) + list(_app_ring), key=lambda e: e["ts"])

    by_group: Dict[str, List[float]] = {}
    for e in entries:
        by_group.setdefault(e["group"], []).append(e["ms"])

    summary = []
    for label in dict.fromkeys([label for _, label in TRACKED_PREFIXES] + list(APP_GROUPS)):
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
        "ring_size": RING_SIZE * 2,
        "recorded": len(entries),
        "summary": summary,
        "recent": list(reversed(entries)),
    }


def _running_keepalive() -> str:
    """The keep-alive uvicorn was actually started with.

    Read from the process command line rather than CAT_KEEPALIVE_S: a
    container running a new compose file on an old image has the variable
    set but still starts uvicorn without the flag (its 5s default).
    """
    try:
        with open("/proc/self/cmdline", "rb") as fh:
            args = fh.read().decode(errors="replace").split("\0")
    except OSError:
        return "unknown"
    if "--timeout-keep-alive" in args:
        i = args.index("--timeout-keep-alive")
        if i + 1 < len(args):
            return args[i + 1]
    return "5 (uvicorn default - rebuild the image to apply CAT_KEEPALIVE_S)"


@router.get("/api/debug/runtime")
async def runtime_stats() -> Dict[str, Any]:
    """Point-in-time gauges for "is the server saturated?".

    async on purpose: it must answer even when every worker thread is busy
    (and the thread limiter can only be read from the event loop).
    """
    threads: Dict[str, Any] = {}
    try:
        import anyio.to_thread
        limiter = anyio.to_thread.current_default_thread_limiter()
        threads = {"in_use": limiter.borrowed_tokens, "limit": limiter.total_tokens}
    except Exception as exc:  # pragma: no cover - diagnostic only
        threads = {"error": str(exc)}

    try:
        from cat.db.oracle import pool_stats
        db_pool = pool_stats()
    except Exception as exc:  # pragma: no cover - diagnostic only
        db_pool = {"error": str(exc)}

    return {
        "ts": time.time(),
        "requests_in_flight": _in_flight,
        "requests_in_flight_peak": _in_flight_peak,
        "threadpool": threads,
        "db_pool": db_pool,
        "keepalive_s": _running_keepalive(),
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
    writer.writerow(["timestamp_iso", "epoch", "group", "method", "path", "cog", "status", "ms"])
    for e in sorted(list(_ring) + list(_app_ring), key=lambda e: e["ts"]):
        writer.writerow([
            time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(e["ts"])),
            e["ts"],
            e["group"],
            e.get("method", "GET"),
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

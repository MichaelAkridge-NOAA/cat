#!/usr/bin/env python3
"""
Reproduce "saves randomly fail / header is slow" under realistic load.

Drives a running CAT the way one annotator does, but from a script so the
browser's own connection limits don't skew the result:
  * N threads loading imagery tiles for a real COG, panning around its centre;
  * an annotation PUT every 3-15 s (random idle gaps, like autosave);
  * /health and /api/auth/me sampled every second.

Then reports latency (p50/p95/max) per endpoint and failures by kind:
connection reset/refused, timeout, HTTP 5xx, other HTTP errors.

Every request uses a fresh TCP connection on purpose: that takes this
client's own keep-alive reuse out of the picture, so any connection error
comes from the hop being tested (e.g. nginx -> uvicorn in
docker-compose.proxytest.yml), not the script.

Standard library only. Example:
  python scripts/perf_repro.py --base http://localhost:8080 \
      --user admin --password ChangeMe123 --project 3 \
      --cog gs://bucket/path/ortho_cog.tif --minutes 15
"""

import argparse
import http.client
import json
import math
import random
import socket
import statistics
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

_lock = threading.Lock()
_timings = defaultdict(list)             # endpoint -> [ms]
_errors = defaultdict(lambda: defaultdict(int))  # endpoint -> kind -> count
_error_log = []                          # (t, endpoint, kind, detail)
_stop = threading.Event()
_t0 = time.time()


def _record(endpoint, ms=None, kind=None, detail=""):
    with _lock:
        if kind is None:
            _timings[endpoint].append(ms)
        else:
            _errors[endpoint][kind] += 1
            # Wall-clock time so errors line up with `cat.access` lines in
            # `docker logs cat-app`.
            _error_log.append((time.strftime("%H:%M:%S"), endpoint, kind, detail[:200]))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # surface redirects as errors
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def request(base, cookie, method, path, body=None, timeout=60.0, endpoint=None):
    """One request on a fresh connection. Returns (status, parsed_json_or_None)."""
    endpoint = endpoint or path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Connection", "close")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    start = time.perf_counter()
    try:
        with _opener.open(req, timeout=timeout) as resp:
            raw = resp.read()
            ms = (time.perf_counter() - start) * 1000
            _record(endpoint, ms)
            ctype = resp.headers.get("content-type", "")
            return resp.status, (json.loads(raw) if "json" in ctype and raw else None)
    except urllib.error.HTTPError as exc:
        ms = (time.perf_counter() - start) * 1000
        status = exc.code
        payload = None
        try:
            payload = json.loads(exc.read() or b"null")
        except Exception:
            pass
        # 404 on a tile outside the raster and 409 on a save are normal.
        if (endpoint == "tile" and status == 404) or status == 409:
            _record(endpoint, ms)
        elif 300 <= status < 400:
            _record(endpoint, kind="redirect", detail=exc.headers.get("location", ""))
        elif status >= 500:
            _record(endpoint, kind=f"http-{status}", detail=f"{ms:.0f}ms")
        else:
            _record(endpoint, kind=f"http-{status}", detail=str(payload)[:200])
        return status, payload
    except (socket.timeout, TimeoutError) as exc:
        _record(endpoint, kind="timeout", detail=str(exc))
    except urllib.error.URLError as exc:
        reason = exc.reason
        kind = "timeout" if isinstance(reason, (socket.timeout, TimeoutError)) else f"conn:{type(reason).__name__}"
        _record(endpoint, kind=kind, detail=str(reason))
    except (ConnectionError, http.client.HTTPException) as exc:
        _record(endpoint, kind=f"conn:{type(exc).__name__}", detail=str(exc))
    return None, None


def login(base, user, password):
    req = urllib.request.Request(
        base + "/api/auth/login",
        data=json.dumps({"username": user, "password": password}).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with _opener.open(req, timeout=30) as resp:
        cookies = resp.headers.get_all("set-cookie") or []
    for c in cookies:
        name_value = c.split(";", 1)[0]
        if name_value.strip():
            return name_value.strip()
    raise SystemExit("Login succeeded but no session cookie was returned")


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def tile_worker(base, cookie, cog_q, center, zooms):
    lon, lat = center
    while not _stop.is_set():
        z = random.choice(zooms)
        cx, cy = lonlat_to_tile(lon, lat, z)
        x = cx + random.randint(-3, 3)
        y = cy + random.randint(-3, 3)
        request(base, cookie, "GET", f"/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url={cog_q}",
                endpoint="tile", timeout=90)


def save_worker(base, cookie, project_id, ann):
    ann_id = ann["annotation_id"]
    version = ann.get("version")
    path = f"/api/db/projects/{project_id}/annotations/{ann_id}"
    while not _stop.is_set():
        # Autosave fires after the user pauses -- the idle gap is the point.
        if _stop.wait(random.uniform(3, 15)):
            break
        body = {"feature": ann.get("feature"), "properties": ann.get("properties") or {},
                "created_by": ann.get("created_by")}
        if version is not None:
            body["version"] = version
        status, payload = request(base, cookie, "PUT", path, body=body, endpoint="save(PUT)")
        if status == 200 and payload and payload.get("annotation"):
            version = payload["annotation"].get("version", version)
        elif status == 409 and payload:
            detail = payload.get("detail") or payload
            if isinstance(detail, dict) and detail.get("current_version") is not None:
                version = detail["current_version"]
        elif status is None or status >= 500:
            # The reported symptom: the browser saw a failure but the save
            # was actually stored. Re-read the version to tell them apart.
            current = _current_version(base, cookie, project_id, ann_id)
            if current is not None and version is not None and current > version:
                _record("save(PUT)", kind="committed-but-failed",
                        detail=f"version {version} -> {current}")
                version = current


def _current_version(base, cookie, project_id, ann_id):
    offset = 0
    while True:
        _, data = request(base, cookie, "GET",
                          f"/api/db/projects/{project_id}/annotations?limit=500&offset={offset}",
                          endpoint="verify-read")
        rows = (data or {}).get("annotations") or []
        for row in rows:
            if row.get("annotation_id") == ann_id:
                return row.get("version")
        if len(rows) < 500:
            return None
        offset += 500


def probe_worker(base, cookie):
    while not _stop.is_set():
        request(base, None, "GET", "/health", endpoint="health", timeout=30)
        request(base, cookie, "GET", "/api/auth/me", endpoint="auth-me", timeout=30)
        _stop.wait(1.0)


def pct(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p / 100.0
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--project", type=int, required=True, help="project_id with at least one annotation")
    ap.add_argument("--cog", required=True, help="COG URL used by that project (gs://... or https://...)")
    ap.add_argument("--minutes", type=float, default=10)
    ap.add_argument("--tile-workers", type=int, default=20)
    ap.add_argument("--zooms", default="", help="comma list; default = from the COG's tilejson")
    ap.add_argument("--json-out", default="", help="also write the report here as JSON")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    cookie = login(base, args.user, args.password)
    cog_q = urllib.parse.quote(args.cog, safe="")

    status, tj = request(base, None, "GET", f"/WebMercatorQuad/tilejson.json?url={cog_q}", endpoint="tilejson")
    if not tj or "center" not in tj:
        raise SystemExit(f"Could not read tilejson for the COG (HTTP {status}); check --cog")
    center = (tj["center"][0], tj["center"][1])
    if args.zooms:
        zooms = [int(z) for z in args.zooms.split(",")]
    else:
        hi = int(tj.get("maxzoom", 20))
        zooms = list(range(max(int(tj.get("minzoom", hi - 3)), hi - 3), hi + 1))

    status, anns = request(base, cookie, "GET", f"/api/db/projects/{args.project}/annotations?limit=1",
                           endpoint="list-annotations")
    if not anns or not anns.get("annotations"):
        raise SystemExit(f"Project {args.project} has no annotations to re-save (HTTP {status})")
    ann = anns["annotations"][0]

    with _lock:
        _timings.clear()
        _errors.clear()
        _error_log.clear()

    print(f"Running {args.minutes} min against {base}: {args.tile_workers} tile workers, zooms {zooms}, "
          f"saving annotation {ann['annotation_id']} of project {args.project}")
    threads = [threading.Thread(target=tile_worker, args=(base, cookie, cog_q, center, zooms), daemon=True)
               for _ in range(args.tile_workers)]
    threads.append(threading.Thread(target=save_worker, args=(base, cookie, args.project, ann), daemon=True))
    threads.append(threading.Thread(target=probe_worker, args=(base, cookie), daemon=True))
    for t in threads:
        t.start()

    end = time.time() + args.minutes * 60
    try:
        while time.time() < end:
            time.sleep(min(30, max(0, end - time.time())))
            with _lock:
                n_err = sum(sum(k.values()) for k in _errors.values())
                n_save = len(_timings.get("save(PUT)", []))
            print(f"  t+{time.time() - _t0:5.0f}s  saves ok={n_save}  errors={n_err}")
    except KeyboardInterrupt:
        pass
    _stop.set()
    for t in threads:
        t.join(timeout=100)

    report = {"base": base, "minutes": args.minutes, "endpoints": {}, "errors": _error_log}
    print("\nendpoint         count    p50ms    p95ms    maxms   errors")
    for ep in ("save(PUT)", "auth-me", "health", "tile"):
        vals = _timings.get(ep, [])
        errs = dict(_errors.get(ep, {}))
        row = {"count": len(vals), "p50_ms": round(pct(vals, 50), 1), "p95_ms": round(pct(vals, 95), 1),
               "max_ms": round(max(vals), 1) if vals else 0.0,
               "mean_ms": round(statistics.mean(vals), 1) if vals else 0.0, "errors": errs}
        report["endpoints"][ep] = row
        print(f"{ep:14s} {row['count']:7d} {row['p50_ms']:8.0f} {row['p95_ms']:8.0f} {row['max_ms']:8.0f}   {errs or '-'}")
    if _error_log:
        print("\nfirst errors (time, endpoint, kind, detail):")
        for e in _error_log[:20]:
            print("  ", e)
    if args.json_out:
        with open(args.json_out, "w") as fh:
            json.dump(report, fh, indent=2)


if __name__ == "__main__":
    main()

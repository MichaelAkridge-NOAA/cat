"""Sites reference API for CAT.

GET  /api/sites                 -- list all sites (DB in Oracle mode, CSV in file mode)
GET  /api/sites/regions         -- distinct region codes
GET  /api/sites/status          -- DB vs CSV mode info and row counts
POST /api/sites/seed            -- seed Oracle tables from bundled CSVs (Oracle only)
POST /api/sites/load-gcs-report -- load a COG conversion JSON report; persist URIs to DB
POST /api/sites/scan-gcs        -- list GCS COG URIs and persist orthomosaic URIs to DB
"""

import fnmatch
import glob
import json
import logging
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from cat.db.config import is_oracle_backend_enabled
from cat.db.sites import (
    build_gcs_asset_map,
    build_gcs_cog_map,
    count_db_sites,
    get_sites,
    load_site_list_csv,
    seed_sites_from_csv,
    site_name_from_uri,
    update_cog_uris,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sites", tags=["sites"])


def _use_db() -> bool:
    return is_oracle_backend_enabled()


# ---------------------------------------------------------------------------
# GET /api/sites
# ---------------------------------------------------------------------------

@router.get("")
def list_sites(
    region: Optional[str] = Query(None),
    depth_bin: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    has_cog: Optional[bool] = Query(None),
):
    """Return all sites, optionally filtered."""
    use_db = _use_db()
    all_sites = get_sites(use_db=use_db)
    sites = list(all_sites)

    if region:
        sites = [s for s in sites if s["region"].upper() == region.upper()]
    if depth_bin:
        sites = [s for s in sites if s["depth_bin"].upper() == depth_bin.upper()]
    if search:
        q = search.lower()
        sites = [
            s
            for s in sites
            if q in s["site_name"].lower()
            or (s["visit"] and q in (s["visit"].get("cruise_leg") or "").lower())
            or (s["visit"] and q in (s["visit"].get("island") or "").lower())
        ]
    if has_cog is not None:
        sites = [s for s in sites if s["has_cog"] == has_cog]

    regions = sorted({s["region"] for s in all_sites if s["region"]})
    return {
        "sites": sites,
        "total": len(sites),
        "regions": regions,
        "source": "db" if use_db else "csv",
    }


# ---------------------------------------------------------------------------
# GET /api/sites/regions
# ---------------------------------------------------------------------------

@router.get("/regions")
def list_regions():
    if _use_db():
        try:
            from cat.db.oracle import fetch_all

            rows = fetch_all(
                "SELECT DISTINCT region FROM cat_sites "
                "WHERE region IS NOT NULL ORDER BY region"
            )
            return {"regions": [r["region"] for r in rows], "source": "db"}
        except Exception as exc:
            logger.warning("DB region query failed: %s", exc)
    sites = load_site_list_csv()
    regions = sorted({s["region"] for s in sites.values() if s["region"]})
    return {"regions": regions, "source": "csv"}


# ---------------------------------------------------------------------------
# GET /api/sites/status
# ---------------------------------------------------------------------------

@router.get("/status")
def sites_status():
    use_db = _use_db()
    db_count = count_db_sites() if use_db else None
    csv_count = len(load_site_list_csv())
    return {
        "backend": "oracle" if use_db else "file",
        "source": "db" if use_db else "csv",
        "db_site_count": db_count,
        "csv_site_count": csv_count,
        "seeded": (db_count or 0) > 0 if use_db else None,
    }


# ---------------------------------------------------------------------------
# POST /api/sites/seed
# ---------------------------------------------------------------------------

@router.post("/seed")
def seed_sites():
    if not _use_db():
        raise HTTPException(
            status_code=400,
            detail=(
                "Site seeding requires Oracle backend. "
                "Set CAT_STORAGE_BACKEND=oracle."
            ),
        )
    try:
        result = seed_sites_from_csv()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Seed failed: {exc}")
    return {"success": True, **result}


# ---------------------------------------------------------------------------
# POST /api/sites/load-gcs-report
# ---------------------------------------------------------------------------

class LoadReportRequest(BaseModel):
    report_path: Optional[str] = None


@router.post("/load-gcs-report")
def load_gcs_report(body: LoadReportRequest):
    report_path_str = (body.report_path or "").strip()
    if report_path_str:
        candidates = sorted(glob.glob(report_path_str))
    else:
        cwd_reports = sorted(glob.glob("gcs_cog_conversion_report_*.json"))
        parent_reports = sorted(glob.glob("../gcs_cog_conversion_report_*.json"))
        candidates = cwd_reports + parent_reports

    if not candidates:
        raise HTTPException(
            status_code=404,
            detail=(
                "No gcs_cog_conversion_report_*.json found. "
                "Provide report_path or run a COG conversion first."
            ),
        )

    report_file = candidates[-1]
    try:
        with open(report_file, encoding="utf-8") as fh:
            report = json.load(fh)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not parse report: {exc}")

    uris = [
        r["destination_uri"]
        for r in report.get("results", [])
        if r.get("status") == "converted" and r.get("destination_uri")
    ]

    asset_map = build_gcs_asset_map(uris)
    cog_map = build_gcs_cog_map(uris)

    use_db = _use_db()
    db_updated = 0
    if use_db and asset_map:
        try:
            db_updated = update_cog_uris(asset_map)
        except Exception as exc:
            logger.warning("Could not persist COG URIs to DB: %s", exc)

    sites = get_sites(use_db=use_db, gcs_cog_map=cog_map, gcs_asset_map=asset_map)
    matched = sum(1 for s in sites if s["has_cog"])

    return {
        "report_file": str(Path(report_file).resolve()),
        "report_timestamp": report.get("timestamp_utc"),
        "source_prefix": report.get("source_prefix"),
        "dest_prefix": report.get("dest_prefix"),
        "total_converted": report.get("counts", {}).get("converted", len(uris)),
        "sites_matched": matched,
        "sites_unmatched": len(sites) - matched,
        "asset_map": asset_map,
        "cog_map": cog_map,
        "db_uris_updated": db_updated,
        "sites": sites,
    }


# ---------------------------------------------------------------------------
# POST /api/sites/scan-gcs
# ---------------------------------------------------------------------------

class ScanGCSRequest(BaseModel):
    gcs_prefix: str
    pattern: str = "*_cog*.tif"


def _list_gcs_public(gcs_prefix: str, pattern: str) -> list[str]:
    if not gcs_prefix.startswith("gs://"):
        raise ValueError(f"Expected gs:// prefix, got: {gcs_prefix}")

    remainder = gcs_prefix[5:]
    bucket_name, _, obj_prefix = remainder.partition("/")
    if obj_prefix and not obj_prefix.endswith("/"):
        obj_prefix += "/"

    all_uris: list[str] = []
    page_token: str | None = None

    while True:
        params: dict = {"prefix": obj_prefix, "maxResults": "1000"}
        if page_token:
            params["pageToken"] = page_token
        url = (
            f"https://storage.googleapis.com/storage/v1/b/"
            f"{urllib.parse.quote(bucket_name, safe='')}/o?"
            + urllib.parse.urlencode(params)
        )
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                data = json.loads(resp.read().decode())
        except Exception as exc:
            raise RuntimeError(f"GCS list request failed: {exc}") from exc

        for item in data.get("items", []):
            fname = item["name"].split("/")[-1]
            if fnmatch.fnmatch(fname, pattern):
                all_uris.append(f"gs://{bucket_name}/{item['name']}")

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return all_uris


@router.post("/scan-gcs")
def scan_gcs(body: ScanGCSRequest):
    prefix = body.gcs_prefix.rstrip("/")
    try:
        uris = _list_gcs_public(prefix, body.pattern)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        cmd = ["gsutil", "ls", f"{prefix}/{body.pattern}"]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            uris = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        except FileNotFoundError:
            raise HTTPException(
                status_code=503,
                detail=f"GCS REST API failed ({exc}) and gsutil is not installed. "
                "Install Google Cloud SDK or check network access.",
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="gsutil ls timed out after 120 s.")
        if result.returncode != 0:
            err = (result.stderr or "").strip()
            raise HTTPException(status_code=502, detail=f"gsutil ls failed: {err}")

    asset_map = build_gcs_asset_map(uris)
    cog_map = build_gcs_cog_map(uris)

    use_db = _use_db()
    db_updated = 0
    if use_db and asset_map:
        try:
            db_updated = update_cog_uris(asset_map)
        except Exception as exc:
            logger.warning("Could not persist COG URIs to DB: %s", exc)

    sites = get_sites(use_db=use_db, gcs_cog_map=cog_map, gcs_asset_map=asset_map)
    matched = sum(1 for s in sites if s["has_cog"])

    return {
        "gcs_prefix": prefix,
        "total_files_found": len(uris),
        "sites_matched": matched,
        "sites_unmatched": len(sites) - matched,
        "asset_map": asset_map,
        "cog_map": cog_map,
        "db_uris_updated": db_updated,
        "unmatched_uris": [u for u in uris if not site_name_from_uri(u)],
        "sites": sites,
    }

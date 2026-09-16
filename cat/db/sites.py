"""Oracle DB operations and CSV loaders for CAT sites reference data.

Public surface
--------------
CSV:   load_site_list_csv(), load_visit_info_csv(), build_sites_from_csv()
DB:    count_db_sites(), seed_sites_from_csv(), fetch_sites_from_db(),
       update_cog_uris()
Utils: site_name_from_uri(), build_gcs_cog_map(), build_gcs_asset_map()
Entry: get_sites(use_db, gcs_cog_map)
"""

import csv
from datetime import datetime
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_REF_DIR = Path(__file__).parent.parent / "data" / "reference"
_SITE_VISIT_CSV = _REF_DIR / "site_visit_info_2026.csv"

_DEPTH_BIN_CODES = {
    "shallow": "S",
    "mid": "M",
    "medium": "M",
    "deep": "D",
}

# Matches: 2025_WAK-2104_mos_cog.tif  or  WAK-2104_mos.tif
_SITE_RE = re.compile(r"(?:^|[/_])(\d{4}_)?([A-Z]{2,4}-\d{2,5})(?:[_.]|$)")


# ---------------------------------------------------------------------------
# CSV loaders
# ---------------------------------------------------------------------------

def load_site_list_csv() -> Dict[str, dict]:
    """Return the unique 2026 sites derived from the visit CSV."""
    sites: Dict[str, dict] = {}
    for name, visits in load_visit_info_csv().items():
        primary = visits[0]
        depth_bin = next((v.get("depth_bin") for v in visits if v.get("depth_bin")), "")
        sites[name] = {
            "site_name": name,
            "depth_bin": depth_bin,
            "region": name.split("-")[0] if "-" in name else "",
            "visit": primary,
            "visits": visits,
        }
    return sites


def _visit_sort_key(visit: dict) -> tuple:
    value = visit.get("survey_date") or ""
    try:
        return (datetime.strptime(value, "%m/%d/%Y"), value)
    except (TypeError, ValueError):
        return (datetime.min, value)


def load_visit_info_csv() -> Dict[str, List[dict]]:
    """Return all 2026 visits grouped by site name, newest first.

    The CSV has a two-row header: row 1 is group labels (Markers, Agisoft,
    etc.) and row 2 holds the actual column names.  We skip row 1.
    """
    visits: Dict[str, List[dict]] = {}
    if not _SITE_VISIT_CSV.exists():
        logger.warning("2026 site visit CSV not found at %s", _SITE_VISIT_CSV)
        return visits
    with open(_SITE_VISIT_CSV, newline="", encoding="utf-8") as fh:
        fh.readline()  # skip group-label header row
        reader = csv.DictReader(fh)
        for row in reader:
            name = (row.get("Site") or row.get("site") or "").strip()
            if not name:
                continue

            def _s(k: str) -> Optional[str]:
                v = row.get(k, "")
                return v.strip() if v else None

            def _f(k: str) -> Optional[float]:
                v = _s(k)
                try:
                    return float(v) if v else None
                except (ValueError, TypeError):
                    return None

            raw_depth_bin = _s("Depth Bin") or ""
            visit = {
                "mission_id":        _s("Mission ID"),
                "occ_site_id":       _s("OCC Site ID"),
                "survey_date":       _s("Date"),
                "cruise_leg":        _s("Cruise Leg"),
                "photographer":      _s("Photographer"),
                "team":              _s("Team"),
                "camera_number":     _s("Camera #"),
                "region":            name.split("-")[0] if "-" in name else "",
                "island":            _s("Island"),
                "sector":            _s("Sector"),
                "reef_zone":         _s("Reef Zone"),
                "depth_bin":         _DEPTH_BIN_CODES.get(raw_depth_bin.lower(), raw_depth_bin),
                "survey_size":       _s("Survey Size"),
                "latitude":          _f("Lat (N)"),
                "longitude":         _f("Long (E)"),
                "survey_type":       _s("Survey Type"),
                "total_images":      _s("total images shot"),
                "notes":             _s("Field Notes") or _s("Notes"),
                "processing_status": _s("Status"),
                "color_correct":     _s("Color Correct"),
                "exposure_correct":  _s("Exposure Correct"),
                "mosaic_issues":     _s("Mosaic Issues"),
                "modeling_priority": _s("Modeling Priority"),
                "annotation_time":   _s("Annotation Time"),
                "piclea_file_path":  _s("PICLEA FIle Path"),
            }
            visits.setdefault(name, []).append(visit)
    for site_visits in visits.values():
        site_visits.sort(key=_visit_sort_key, reverse=True)
    return visits


def build_sites_from_csv(
    gcs_cog_map: Optional[Dict[str, str]] = None,
    gcs_asset_map: Optional[Dict[str, Dict[str, Optional[str]]]] = None,
) -> List[dict]:
    """Build unique 2026 sites, optionally overlaying GCS COG URIs."""
    sites_base = load_site_list_csv()
    result = []
    for name, s in sites_base.items():
        assets = (gcs_asset_map or {}).get(name) or {
            "cog_uri": (gcs_cog_map or {}).get(name),
            "dem_uri": None,
        }
        cog_uri = assets.get("cog_uri")
        dem_uri = assets.get("dem_uri")
        result.append({
            **s,
            "has_cog": bool(cog_uri or dem_uri),
            "has_dem": bool(dem_uri),
            "cog_uri": cog_uri,
            "dem_uri": dem_uri,
        })
    return sorted(result, key=lambda s: s["site_name"])


# ---------------------------------------------------------------------------
# GCS URI utilities
# ---------------------------------------------------------------------------

def site_name_from_uri(uri: str) -> Optional[str]:
    """Extract site code like WAK-2104 from a GCS file URI/filename."""
    fname = uri.rstrip("/").split("/")[-1]
    m = _SITE_RE.search(fname)
    return m.group(2) if m else None


def _asset_kind_from_uri(uri: str) -> str:
    """Classify URI as orthomosaic COG ("cog") or DEM COG ("dem")."""
    u = (uri or "").lower()
    fname = u.rstrip("/").split("/")[-1]
    if "/dem_cog/" in u or "_dem" in fname:
        return "dem"
    if "/orthomosaic_cog/" in u or "_mos" in fname:
        return "cog"
    return "cog"


def _guess_dem_uri_from_cog(cog_uri: Optional[str]) -> Optional[str]:
    """Best-effort DEM URI guess from orthomosaic naming conventions."""
    if not cog_uri:
        return None
    dem_uri = cog_uri.replace("/orthomosaic_cog/", "/dem_cog/")
    dem_uri = dem_uri.replace("_mos_cog", "_dem_cog")
    dem_uri = dem_uri.replace("_mos.", "_dem.")
    return dem_uri if dem_uri != cog_uri else None


def build_gcs_asset_map(uris: List[str]) -> Dict[str, Dict[str, Optional[str]]]:
    """Return {site_name: {cog_uri, dem_uri}} from a list of GCS URIs."""
    mapping: Dict[str, Dict[str, Optional[str]]] = {}
    for uri in uris:
        site = site_name_from_uri(uri)
        if not site:
            continue

        if site not in mapping:
            mapping[site] = {"cog_uri": None, "dem_uri": None}

        if _asset_kind_from_uri(uri) == "dem":
            mapping[site]["dem_uri"] = mapping[site]["dem_uri"] or uri
        else:
            mapping[site]["cog_uri"] = mapping[site]["cog_uri"] or uri

    return mapping


def build_gcs_cog_map(uris: List[str]) -> Dict[str, str]:
    """Backward-compatible map: {site_name: primary_uri}.

    Prefers orthomosaic URI, falls back to DEM URI when only DEM exists.
    """
    asset_map = build_gcs_asset_map(uris)
    return {
        site: (assets.get("cog_uri") or assets.get("dem_uri"))
        for site, assets in asset_map.items()
        if assets.get("cog_uri") or assets.get("dem_uri")
    }


# ---------------------------------------------------------------------------
# DB operations  (Oracle; only called when is_oracle_backend_enabled())
# ---------------------------------------------------------------------------

def count_db_sites() -> int:
    """Return number of rows in cat_sites (0 if empty or unavailable)."""
    try:
        from cat.db.oracle import fetch_all
        rows = fetch_all("SELECT COUNT(*) AS cnt FROM cat_sites")
        return int(rows[0]["cnt"]) if rows else 0
    except Exception:
        return 0


def seed_sites_from_csv() -> dict:
    """Replace Oracle reference data with the bundled 2026 site data.

    Existing COG URIs are retained for sites still present in 2026. Project,
    asset, annotation, and user tables are not modified.
    """
    sites_base = load_site_list_csv()

    site_rows = [
        {
            "site_name": v["site_name"],
            "depth_bin": v["depth_bin"] or None,
            "region":    v["region"] or None,
        }
        for v in sites_base.values()
    ]

    visit_rows = []
    for name, site in sites_base.items():
        for visit in site["visits"]:
            visit_rows.append({
                "site_name":         name,
                "mission_id":        visit.get("mission_id"),
                "occ_site_id":       visit.get("occ_site_id"),
                "survey_date":       visit.get("survey_date"),
                "cruise_leg":        visit.get("cruise_leg"),
                "photographer":      visit.get("photographer"),
                "team":              visit.get("team"),
                "camera_number":     visit.get("camera_number"),
                "region":            visit.get("region"),
                "island":            visit.get("island"),
                "sector":            visit.get("sector"),
                "reef_zone":         visit.get("reef_zone"),
                "depth_bin":         visit.get("depth_bin"),
                "survey_size":       visit.get("survey_size"),
                "latitude":          visit.get("latitude"),
                "longitude":         visit.get("longitude"),
                "survey_type":       visit.get("survey_type"),
                "total_images":      visit.get("total_images"),
                "notes":             visit.get("notes"),
                "processing_status": visit.get("processing_status"),
                "color_correct":     visit.get("color_correct"),
                "exposure_correct":  visit.get("exposure_correct"),
                "mosaic_issues":     visit.get("mosaic_issues"),
                "modeling_priority": visit.get("modeling_priority"),
                "annotation_time":   visit.get("annotation_time"),
                "piclea_file_path":  visit.get("piclea_file_path"),
            })

    site_merge = """
        MERGE INTO cat_sites dst
        USING (SELECT :site_name AS site_name,
                      :depth_bin AS depth_bin,
                      :region    AS region
               FROM dual) src
        ON (dst.site_name = src.site_name)
        WHEN NOT MATCHED THEN
            INSERT (site_name, depth_bin, region)
            VALUES (src.site_name, src.depth_bin, src.region)
        WHEN MATCHED THEN
            UPDATE SET dst.depth_bin = src.depth_bin,
                       dst.region    = src.region
    """

    visit_insert = """
        INSERT INTO cat_site_visits (
            site_name, mission_id, occ_site_id, survey_date, cruise_leg,
            photographer, team, camera_number, region, island, sector, reef_zone,
            depth_bin, survey_size, latitude, longitude, survey_type, total_images,
            notes, processing_status, color_correct, exposure_correct, mosaic_issues,
            modeling_priority, annotation_time, piclea_file_path
        ) VALUES (
            :site_name, :mission_id, :occ_site_id, :survey_date, :cruise_leg,
            :photographer, :team, :camera_number, :region, :island, :sector,
            :reef_zone, :depth_bin, :survey_size, :latitude, :longitude,
            :survey_type, :total_images, :notes, :processing_status,
            :color_correct, :exposure_correct, :mosaic_issues,
            :modeling_priority, :annotation_time, :piclea_file_path
        )
    """

    from cat.db.oracle import get_connection
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT site_name FROM cat_sites")
            current_names = {row[0] for row in cur.fetchall()}
            active_names = set(sites_base)
            stale_rows = [{"site_name": name} for name in current_names - active_names]

            cur.execute("DELETE FROM cat_site_visits")
            cur.executemany(site_merge, site_rows)
            cur.executemany(visit_insert, visit_rows)
            if stale_rows:
                cur.executemany(
                    "DELETE FROM cat_sites WHERE site_name = :site_name",
                    stale_rows,
                )
        conn.commit()

    return {
        "sites_seeded": len(site_rows),
        "visits_seeded": len(visit_rows),
        "sites_removed": len(stale_rows),
    }


def _group_site_rows(
    rows: List[dict],
    gcs_cog_map: Optional[Dict[str, str]] = None,
    gcs_asset_map: Optional[Dict[str, Dict[str, Optional[str]]]] = None,
) -> List[dict]:
    grouped: Dict[str, dict] = {}
    for row in rows:
        site_name = row["site_name"]
        site = grouped.get(site_name)
        if site is None:
            has_asset_overlay = site_name in (gcs_asset_map or {})
            overlay = (gcs_asset_map or {}).get(site_name) or {}
            cog_uri = overlay.get("cog_uri") if has_asset_overlay else (gcs_cog_map or {}).get(site_name)
            cog_uri = cog_uri or row.get("cog_uri")
            dem_uri = overlay.get("dem_uri") or row.get("dem_uri") or _guess_dem_uri_from_cog(cog_uri)
            site = {
                "site_name": site_name,
                "depth_bin": row.get("site_depth_bin") or "",
                "region": row.get("site_region") or "",
                "has_cog": bool(cog_uri or dem_uri),
                "has_dem": bool(dem_uri),
                "cog_uri": cog_uri,
                "dem_uri": dem_uri,
                "visit": None,
                "visits": [],
            }
            grouped[site_name] = site

        if any(row.get(key) for key in ("survey_date", "cruise_leg", "latitude")):
            site["visits"].append({
                "mission_id":        row.get("mission_id"),
                "occ_site_id":       row.get("occ_site_id"),
                "survey_date":       row.get("survey_date"),
                "cruise_leg":        row.get("cruise_leg"),
                "photographer":      row.get("photographer"),
                "team":              row.get("team"),
                "camera_number":     row.get("camera_number"),
                "region":            row.get("visit_region") or site["region"],
                "island":            row.get("island"),
                "sector":            row.get("sector"),
                "reef_zone":         row.get("reef_zone"),
                "depth_bin":         row.get("visit_depth_bin") or site["depth_bin"],
                "survey_size":       row.get("survey_size"),
                "latitude":          row.get("latitude"),
                "longitude":         row.get("longitude"),
                "survey_type":       row.get("survey_type"),
                "total_images":      row.get("total_images"),
                "notes":             row.get("notes"),
                "processing_status": row.get("processing_status"),
                "color_correct":     row.get("color_correct"),
                "exposure_correct":  row.get("exposure_correct"),
                "mosaic_issues":     row.get("mosaic_issues"),
                "modeling_priority": row.get("modeling_priority"),
                "annotation_time":   row.get("annotation_time"),
                "piclea_file_path":  row.get("piclea_file_path"),
            })

    for site in grouped.values():
        site["visits"].sort(key=_visit_sort_key, reverse=True)
        site["visit"] = site["visits"][0] if site["visits"] else None
    return sorted(grouped.values(), key=lambda site: site["site_name"])


def fetch_sites_from_db(
    gcs_cog_map: Optional[Dict[str, str]] = None,
    gcs_asset_map: Optional[Dict[str, Dict[str, Optional[str]]]] = None,
) -> List[dict]:
    """Query Oracle and return one site with a newest-first visit history."""
    from cat.db.oracle import fetch_all
    rows = fetch_all("""
        SELECT s.site_name,
               s.depth_bin AS site_depth_bin,
               s.region AS site_region,
               s.cog_uri,
             s.dem_uri,
               v.mission_id,
               v.occ_site_id,
               v.survey_date,
               v.cruise_leg,
               v.photographer,
               v.team,
               v.camera_number,
               v.region AS visit_region,
               v.island,
               v.sector,
               v.reef_zone,
               v.depth_bin AS visit_depth_bin,
               v.survey_size,
               v.latitude,
               v.longitude,
               v.survey_type,
               v.total_images,
               v.notes,
               v.processing_status,
               v.color_correct,
               v.exposure_correct,
               v.mosaic_issues,
               v.modeling_priority,
               v.annotation_time,
               v.piclea_file_path
        FROM   cat_sites s
        LEFT JOIN cat_site_visits v ON v.site_name = s.site_name
        ORDER BY s.site_name, v.survey_date DESC, v.visit_id DESC
    """)
    return _group_site_rows(rows, gcs_cog_map, gcs_asset_map)


def update_cog_uris(cog_map: Dict[str, Any]) -> int:
    """Persist raster URIs into cat_sites. Returns count updated.

    Accepts legacy {site: uri} and new {site: {cog_uri, dem_uri}} mappings.
    One-kind scans never overwrite the other stored raster URI.
    """
    if not cog_map:
        return 0
    rows = []
    for site_name, value in cog_map.items():
        if isinstance(value, str):
            cog_uri = value
            dem_uri = None
        elif isinstance(value, dict):
            cog_uri = value.get("cog_uri")
            dem_uri = value.get("dem_uri")
        else:
            cog_uri = None
            dem_uri = None
        rows.append({"site_name": site_name, "cog_uri": cog_uri, "dem_uri": dem_uri})

    from cat.db.oracle import get_connection
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                UPDATE cat_sites
                SET cog_uri = NVL(:cog_uri, cog_uri),
                    dem_uri = NVL(:dem_uri, dem_uri)
                WHERE site_name = :site_name
                """,
                rows,
            )
        conn.commit()
    return len(rows)


def sync_cog_uris(asset_map: Dict[str, Any]) -> int:
    """Replace (not merge) every site's raster URIs to match *asset_map*.

    Unlike update_cog_uris (NVL-based: only fills a NULL, never clears a
    stale value), this is a full reconcile against the current contents of
    a GCS scan: every site in cat_sites gets set to whatever asset_map has
    for it, and any site NOT in asset_map is cleared to NULL. Use this after
    removing/replacing COGs in GCS so cat_sites reflects what's actually
    there now instead of accumulating stale references to deleted files.
    """
    from cat.db.oracle import fetch_all, get_connection

    all_site_names = [r["site_name"] for r in fetch_all("SELECT site_name FROM cat_sites")]
    if not all_site_names:
        return 0

    rows = []
    for site_name in all_site_names:
        value = asset_map.get(site_name)
        if isinstance(value, str):
            cog_uri, dem_uri = value, None
        elif isinstance(value, dict):
            cog_uri, dem_uri = value.get("cog_uri"), value.get("dem_uri")
        else:
            cog_uri, dem_uri = None, None
        rows.append({"site_name": site_name, "cog_uri": cog_uri, "dem_uri": dem_uri})

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                UPDATE cat_sites
                SET cog_uri = :cog_uri,
                    dem_uri = :dem_uri
                WHERE site_name = :site_name
                """,
                rows,
            )
        conn.commit()
    return len(rows)


def replace_site_assets(
    site_name: str,
    cog_uri: Optional[str],
    dem_uri: Optional[str],
    update_projects: bool = False,
) -> Dict[str, int]:
    """Replace a site's stored raster URIs and optionally sync its projects."""
    assets = (("COG", cog_uri), ("DEM", dem_uri))

    from cat.db.oracle import get_connection
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE cat_sites
                SET cog_uri = :cog_uri,
                    dem_uri = :dem_uri
                WHERE site_name = :site_name
                """,
                {"site_name": site_name, "cog_uri": cog_uri, "dem_uri": dem_uri},
            )
            if cur.rowcount == 0:
                raise ValueError(f"Site not found: {site_name}")

            project_ids: List[int] = []
            if update_projects:
                cur.execute(
                    "SELECT project_id FROM cat_projects WHERE site = :site_name",
                    {"site_name": site_name},
                )
                project_ids = [row[0] for row in cur.fetchall()]

                for project_id in project_ids:
                    for asset_type, uri in assets:
                        params = {"project_id": project_id, "asset_type": asset_type}
                        if not uri:
                            cur.execute(
                                """
                                DELETE FROM cat_project_assets
                                WHERE project_id = :project_id
                                  AND UPPER(asset_type) = :asset_type
                                """,
                                params,
                            )
                            continue

                        asset_params = {
                            **params,
                            "asset_name": uri.rstrip("/").split("/")[-1],
                            "cog_url": uri,
                        }
                        cur.execute(
                            """
                            UPDATE cat_project_assets
                            SET asset_name = :asset_name,
                                cog_url = :cog_url
                            WHERE project_id = :project_id
                              AND UPPER(asset_type) = :asset_type
                            """,
                            asset_params,
                        )
                        if cur.rowcount == 0:
                            cur.execute(
                                """
                                INSERT INTO cat_project_assets (
                                    project_id, asset_type, asset_name, cog_url
                                ) VALUES (
                                    :project_id, :asset_type, :asset_name, :cog_url
                                )
                                """,
                                asset_params,
                            )
        conn.commit()

    return {"projects_updated": len(project_ids)}


# ---------------------------------------------------------------------------
# Unified entry point
# ---------------------------------------------------------------------------

def get_sites(
    use_db: bool = False,
    gcs_cog_map: Optional[Dict[str, str]] = None,
    gcs_asset_map: Optional[Dict[str, Dict[str, Optional[str]]]] = None,
) -> List[dict]:
    """Return site list from Oracle DB when use_db=True, else from CSVs.

    Falls back to CSV if the DB query fails *or* returns 0 rows (e.g. tables
    exist but have not been seeded yet).
    """
    if use_db:
        try:
            db_sites = fetch_sites_from_db(gcs_cog_map=gcs_cog_map, gcs_asset_map=gcs_asset_map)
            if db_sites:
                return db_sites
            logger.info("DB returned 0 sites — falling back to CSV (tables may not be seeded yet).")
        except Exception as exc:
            logger.warning("DB sites fetch failed, falling back to CSV: %s", exc)
    return build_sites_from_csv(gcs_cog_map=gcs_cog_map, gcs_asset_map=gcs_asset_map)

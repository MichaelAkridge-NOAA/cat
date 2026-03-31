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
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_REF_DIR = Path(__file__).parent.parent / "data" / "reference"
_SITE_LIST_CSV = _REF_DIR / "site_list.csv"
_SITE_VISIT_CSV = _REF_DIR / "site_visit_info.csv"

# Matches: 2025_WAK-2104_mos_cog.tif  or  WAK-2104_mos.tif
_SITE_RE = re.compile(r"(?:^|[/_])(\d{4}_)?([A-Z]{2,4}-\d{3,5})(?:[_.]|$)")


# ---------------------------------------------------------------------------
# CSV loaders
# ---------------------------------------------------------------------------

def load_site_list_csv() -> Dict[str, dict]:
    """Return {site_name: {site_name, depth_bin, region}} from site_list.csv."""
    sites: Dict[str, dict] = {}
    if not _SITE_LIST_CSV.exists():
        logger.warning("site_list.csv not found at %s", _SITE_LIST_CSV)
        return sites
    with open(_SITE_LIST_CSV, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            name = (row.get("site") or row.get("Site") or "").strip()
            if not name:
                continue
            region = name.split("-")[0] if "-" in name else ""
            depth_bin = (row.get("depth_bin") or row.get("Depth_bin") or "").strip()
            sites[name] = {
                "site_name": name,
                "depth_bin": depth_bin,
                "region": region,
            }
    return sites


def load_visit_info_csv() -> Dict[str, dict]:
    """Return {site_name: visit_dict} from site_visit_info.csv.

    The CSV has a two-row header: row 1 is group labels (Markers, Agisoft,
    etc.) and row 2 holds the actual column names.  We skip row 1.
    """
    visits: Dict[str, dict] = {}
    if not _SITE_VISIT_CSV.exists():
        logger.warning("site_visit_info.csv not found at %s", _SITE_VISIT_CSV)
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

            visits[name] = {
                "survey_date":       _s("Survey Date"),
                "cruise_leg":        _s("Cruise Leg"),
                "photographer":      _s("Photographer"),
                "team":              _s("Team"),
                "region":            _s("Region"),
                "island":            _s("Island"),
                "sector":            _s("Sector"),
                "survey_size":       _s("Survey Size"),
                "latitude":          _f("Lat (N)"),
                "longitude":         _f("Long (E)"),
                "survey_type":       _s("Survey Type"),
                "total_images":      _s("total images shot"),
                "notes":             _s("Notes"),
                "modeling_priority": _s("Modeling Priority"),
                "annotation_time":   _s("Annotation Time"),
            }
    return visits


def build_sites_from_csv(
    gcs_cog_map: Optional[Dict[str, str]] = None,
    gcs_asset_map: Optional[Dict[str, Dict[str, Optional[str]]]] = None,
) -> List[dict]:
    """Merge site_list + visit_info CSVs, optionally overlay GCS COG URIs."""
    sites_base = load_site_list_csv()
    visits = load_visit_info_csv()
    result = []
    for name, s in sites_base.items():
        visit = visits.get(name)
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
            "visit": visit,
        })
    for name, visit in visits.items():
        if name not in sites_base:
            region = name.split("-")[0] if "-" in name else (visit.get("region") or "")
            assets = (gcs_asset_map or {}).get(name) or {
                "cog_uri": (gcs_cog_map or {}).get(name),
                "dem_uri": None,
            }
            cog_uri = assets.get("cog_uri")
            dem_uri = assets.get("dem_uri")
            result.append({
                "site_name": name, "depth_bin": "", "region": region,
                "has_cog": bool(cog_uri or dem_uri),
                "has_dem": bool(dem_uri),
                "cog_uri": cog_uri,
                "dem_uri": dem_uri,
                "visit": visit,
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
    """Upsert all sites and visit info from bundled CSVs into Oracle.

    Safe to call multiple times -- uses MERGE (upsert) semantics.
    Returns {"sites_seeded": N, "visits_seeded": M}.
    """
    sites_base = load_site_list_csv()
    visits = load_visit_info_csv()

    site_rows = [
        {
            "site_name": v["site_name"],
            "depth_bin": v["depth_bin"] or None,
            "region":    v["region"] or None,
        }
        for v in sites_base.values()
    ]

    visit_rows = [
        {
            "site_name":         name,
            "survey_date":       v.get("survey_date"),
            "cruise_leg":        v.get("cruise_leg"),
            "photographer":      v.get("photographer"),
            "team":              v.get("team"),
            "region":            v.get("region"),
            "island":            v.get("island"),
            "sector":            v.get("sector"),
            "survey_size":       v.get("survey_size"),
            "latitude":          v.get("latitude"),
            "longitude":         v.get("longitude"),
            "survey_type":       v.get("survey_type"),
            "total_images":      v.get("total_images"),
            "notes":             v.get("notes"),
            "modeling_priority": v.get("modeling_priority"),
            "annotation_time":   v.get("annotation_time"),
        }
        for name, v in visits.items()
    ]

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

    visit_merge = """
        MERGE INTO cat_site_visits dst
        USING (SELECT :site_name AS site_name FROM dual) src
        ON (dst.site_name = src.site_name)
        WHEN NOT MATCHED THEN
            INSERT (site_name, survey_date, cruise_leg, photographer, team,
                    region, island, sector, survey_size, latitude, longitude,
                    survey_type, total_images, notes, modeling_priority, annotation_time)
            VALUES (:site_name, :survey_date, :cruise_leg, :photographer, :team,
                    :region, :island, :sector, :survey_size, :latitude, :longitude,
                    :survey_type, :total_images, :notes, :modeling_priority, :annotation_time)
        WHEN MATCHED THEN
            UPDATE SET dst.survey_date       = :survey_date,
                       dst.cruise_leg        = :cruise_leg,
                       dst.photographer      = :photographer,
                       dst.team              = :team,
                       dst.region            = :region,
                       dst.island            = :island,
                       dst.sector            = :sector,
                       dst.survey_size       = :survey_size,
                       dst.latitude          = :latitude,
                       dst.longitude         = :longitude,
                       dst.survey_type       = :survey_type,
                       dst.total_images      = :total_images,
                       dst.notes             = :notes,
                       dst.modeling_priority = :modeling_priority,
                       dst.annotation_time   = :annotation_time
    """

    from cat.db.oracle import get_connection
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(site_merge, site_rows)
            cur.executemany(visit_merge, visit_rows)
        conn.commit()

    return {
        "sites_seeded": len(site_rows),
        "visits_seeded": len(visit_rows),
    }


def fetch_sites_from_db(
    gcs_cog_map: Optional[Dict[str, str]] = None,
    gcs_asset_map: Optional[Dict[str, Dict[str, Optional[str]]]] = None,
) -> List[dict]:
    """Query cat_sites + cat_site_visits via LEFT JOIN from Oracle."""
    from cat.db.oracle import fetch_all
    rows = fetch_all("""
        SELECT s.site_name,
               s.depth_bin,
               s.region,
               s.cog_uri,
               v.survey_date,
               v.cruise_leg,
               v.photographer,
               v.team,
               v.island,
               v.sector,
               v.survey_size,
               v.latitude,
               v.longitude,
               v.survey_type,
               v.total_images,
               v.notes,
               v.modeling_priority,
               v.annotation_time
        FROM   cat_sites s
        LEFT JOIN cat_site_visits v ON v.site_name = s.site_name
        ORDER BY s.site_name
    """)

    result = []
    for r in rows:
        site_name = r["site_name"]
        # Live overlay takes precedence over the stored value
        overlay = (gcs_asset_map or {}).get(site_name) or {}
        cog_uri = overlay.get("cog_uri") or (gcs_cog_map or {}).get(site_name) or r.get("cog_uri")
        dem_uri = overlay.get("dem_uri") or _guess_dem_uri_from_cog(cog_uri)
        has_visit = any(r.get(k) for k in ("survey_date", "cruise_leg", "latitude"))
        visit = None
        if has_visit:
            visit = {
                "survey_date":       r.get("survey_date"),
                "cruise_leg":        r.get("cruise_leg"),
                "photographer":      r.get("photographer"),
                "team":              r.get("team"),
                "region":            r.get("region"),
                "island":            r.get("island"),
                "sector":            r.get("sector"),
                "survey_size":       r.get("survey_size"),
                "latitude":          r.get("latitude"),
                "longitude":         r.get("longitude"),
                "survey_type":       r.get("survey_type"),
                "total_images":      r.get("total_images"),
                "notes":             r.get("notes"),
                "modeling_priority": r.get("modeling_priority"),
                "annotation_time":   r.get("annotation_time"),
            }
        result.append({
            "site_name": site_name,
            "depth_bin": r.get("depth_bin") or "",
            "region":    r.get("region") or "",
            "has_cog":   bool(cog_uri or dem_uri),
            "has_dem":   bool(dem_uri),
            "cog_uri":   cog_uri,
            "dem_uri":   dem_uri,
            "visit":     visit,
        })
    return result


def update_cog_uris(cog_map: Dict[str, Any]) -> int:
    """Persist orthomosaic URIs into cat_sites.cog_uri. Returns count updated.

    Accepts legacy {site: uri} and new {site: {cog_uri, dem_uri}} mappings.
    DEM-only scans never overwrite an existing stored orthomosaic URI.
    """
    if not cog_map:
        return 0
    rows = []
    for site_name, value in cog_map.items():
        if isinstance(value, str):
            cog_uri = value
        elif isinstance(value, dict):
            cog_uri = value.get("cog_uri")
        else:
            cog_uri = None
        rows.append({"site_name": site_name, "cog_uri": cog_uri})

    from cat.db.oracle import get_connection
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "UPDATE cat_sites SET cog_uri = NVL(:cog_uri, cog_uri) WHERE site_name = :site_name",
                rows,
            )
        conn.commit()
    return len(rows)


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

"""
API endpoints for coral species lookup and autocomplete.
Supports both CSV-file fallback and Oracle DB-backed mode.
When a DB is available, species are loaded from cat_coral_species
and can be filtered per-project by region columns and flags.
"""
import csv
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from cat.api.auth import require_auth, require_team_lead_or_admin

router = APIRouter(prefix="/api/coral", tags=["coral"])

# ── In-memory cache (CSV fallback) ──
_species_cache: Optional[List[Dict]] = None

# ── DB species list cache (keyed by filter tuple, TTL 60s) ──
_db_species_cache: Dict[str, tuple] = {}  # key -> (timestamp, list)
_DB_CACHE_TTL = 60  # seconds

# ── Region columns present in the CSV / DB ──
REGION_COLUMNS = [
    "samoa", "marianas", "hawaii", "johnston",
    "line_island", "phoenix", "wake",
]
FLAG_COLUMNS = ["inactive_flag", "adu_flag", "juv_flag"]


# =====================================================================
#  CSV helpers (fallback when Oracle is not available)
# =====================================================================

def _csv_path() -> Path:
    return Path(__file__).parent.parent / "data" / "reference" / "list_of_coral.csv"


def _flag_to_int(val: str) -> int:
    """Convert CSV flag values: '-1'/'Yes' → -1, '0'/'No'/'' → 0."""
    v = str(val).strip().lower()
    if v in ("-1", "yes"):
        return -1
    return 0


def load_species_list() -> List[Dict]:
    """Load coral species from CSV file (cached)."""
    global _species_cache
    if _species_cache is not None:
        return _species_cache

    csv_file = _csv_path()
    if not csv_file.exists():
        print(f"⚠️ Species CSV not found at: {csv_file}")
        return []

    species_list = []
    try:
        with open(csv_file, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                species_list.append({
                    "code": row.get("SPECIES", ""),
                    "taxon_name": row.get("TAXONNAME", ""),
                    "scientific_name": row.get("SCIENTIFIC_NAME", ""),
                    "genus": row.get("GENUS", ""),
                    "family": row.get("FAMILY", ""),
                    "morphology": f"{row.get('MORPHOLOGY_1', '')} {row.get('MORPHOLOGY_2', '')}".strip(),
                    "class": row.get("CLASS", ""),
                    "gencode": row.get("GENCODE", ""),
                    # Region flags — normalise Yes/No → -1/0
                    "samoa": _flag_to_int(row.get("SAMOA", "0")),
                    "marianas": _flag_to_int(row.get("MARIANAS", row.get("MARIANAS_", "0"))),
                    "hawaii": _flag_to_int(row.get("HAWAII", "0")),
                    "johnston": _flag_to_int(row.get("JOHNSTON", "0")),
                    "line_island": _flag_to_int(row.get("LINE", "0")),
                    "phoenix": _flag_to_int(row.get("PHOENIX", "0")),
                    "wake": _flag_to_int(row.get("WAKE", "0")),
                    # Flags
                    "inactive_flag": _flag_to_int(row.get("INACTIVE_FLAG_YN", "0")),
                    "adu_flag": _flag_to_int(row.get("ADU_FLAG_YN", "0")),
                    "juv_flag": _flag_to_int(row.get("JUV_FLAG_YN", "0")),
                })
        _species_cache = species_list
    except Exception as e:
        print(f"Error loading species list: {e}")
        return []

    return species_list


# =====================================================================
#  DB helpers
# =====================================================================

def _is_db_available() -> bool:
    try:
        from cat.db.config import is_oracle_backend_enabled
        return is_oracle_backend_enabled()
    except Exception:
        return False


def _load_species_from_db(filters: Optional[Dict] = None) -> List[Dict]:
    """Query cat_coral_species with optional region/flag filters."""
    from cat.db.oracle import fetch_all

    where_clauses: List[str] = []
    params: Dict[str, Any] = {}

    if filters:
        # Region filters: if any region is enabled, species must have that region = -1
        regions_on = [r for r in REGION_COLUMNS if filters.get(r)]
        if regions_on:
            # OR logic: species is valid if it's present in ANY selected region
            region_parts = [f"{r} = -1" for r in regions_on]
            where_clauses.append(f"({' OR '.join(region_parts)})")

        # Flag filters. hide_inactive is now redundant with the org-wide floor
        # below (kept for backward compatibility with the per-project filter
        # modal, which may still send it) — checking it never un-hides
        # anything the team-lead config already excludes.
        if filters.get("hide_inactive", False):
            where_clauses.append("inactive_flag = 0")
        if filters.get("adu_only", False):
            where_clauses.append("adu_flag = -1")
        if filters.get("juv_only", False):
            where_clauses.append("juv_flag = -1")

    # Org-wide floor (team-lead config, cat_coral_species.inactive_flag): a
    # species a team lead has disabled is excluded from every annotator-facing
    # list/search regardless of any per-project filter setting. Only the
    # team-lead management endpoint (include_inactive=True) sees disabled rows
    # — it needs them to render the enable/disable toggle itself. This must
    # never touch QC's species lookup (aggregate_annotations queries
    # cat_coral_species directly, not through this function) or any historical
    # annotation data — see docs/team-lead-config-plan.md.
    if not (filters and filters.get("include_inactive")):
        where_clauses.append("NVL(inactive_flag, 0) = 0")

    where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    sql = f"SELECT * FROM cat_coral_species{where_sql} ORDER BY spcode"

    rows = fetch_all(sql, params)
    return [
        {
            # Oracle stores '' as NULL, so a blank CSV field comes back as a
            # present key with value None — `.get(field, "")` doesn't catch
            # that (the key IS present), and code downstream (_score_species'
            # unconditional .lower()) crashed on it as soon as the DB table
            # actually held real, partially-blank data. `or ""` catches both
            # "missing" and "present but None".
            "code": r.get("spcode") or "",
            "taxon_name": r.get("taxon_name") or "",
            "scientific_name": r.get("scientific_name") or "",
            "genus": r.get("genus") or "",
            "family": r.get("family") or "",
            "morphology": f"{r.get('morphology_1', '') or ''} {r.get('morphology_2', '') or ''}".strip(),
            "class": r.get("class_name") or "",
            "gencode": r.get("gencode") or "",
            "samoa": r.get("samoa") or 0,
            "marianas": r.get("marianas") or 0,
            "hawaii": r.get("hawaii") or 0,
            "johnston": r.get("johnston") or 0,
            "line_island": r.get("line_island") or 0,
            "phoenix": r.get("phoenix") or 0,
            "wake": r.get("wake") or 0,
            "inactive_flag": r.get("inactive_flag") or 0,
            "adu_flag": r.get("adu_flag") or 0,
            "juv_flag": r.get("juv_flag") or 0,
        }
        for r in rows
    ]


_db_table_populated_cache: Optional[tuple] = None  # (timestamp, bool)


def _db_species_table_has_any_rows() -> bool:
    """Cheap, cached check for 'has cat_coral_species ever been imported into,
    at all' — independent of any filter. Used only to decide whether an empty
    filtered result means 'nothing matched' (trust it) versus 'table was never
    seeded, use the CSV' (today's bootstrap state on a fresh deployment)."""
    global _db_table_populated_cache
    now = time.time()
    if _db_table_populated_cache and now - _db_table_populated_cache[0] < _DB_CACHE_TTL:
        return _db_table_populated_cache[1]
    from cat.db.oracle import fetch_one
    row = fetch_one("SELECT COUNT(*) AS n FROM cat_coral_species")
    populated = bool(row and row.get("n"))
    _db_table_populated_cache = (now, populated)
    return populated


def _get_species_list(filters: Optional[Dict] = None) -> List[Dict]:
    """Return species from DB if available, otherwise CSV (with in-memory filtering)."""
    if _is_db_available():
        try:
            # Build a stable cache key from the filter dict
            cache_key = str(sorted(filters.items()) if filters else [])
            now = time.time()
            if cache_key in _db_species_cache:
                ts, cached = _db_species_cache[cache_key]
                if now - ts < _DB_CACHE_TTL:
                    return cached
            db_rows = _load_species_from_db(filters)
            # Trust an empty result once the table has real data — "0 species
            # match this filter" (e.g. every match is disabled, or a very
            # narrow region filter) is a legitimate answer, not a signal to
            # fall back to the CSV. Only fall back while the table has never
            # been imported into at all (today's out-of-the-box state).
            if db_rows or _db_species_table_has_any_rows():
                _db_species_cache[cache_key] = (now, db_rows)
                return db_rows
        except Exception as e:
            print(f"⚠️ DB species query failed, falling back to CSV: {e}")

    # CSV fallback — apply filters in memory
    all_species = load_species_list()
    filters = filters or {}
    filtered = all_species
    regions_on = [r for r in REGION_COLUMNS if filters.get(r)]
    if regions_on:
        filtered = [s for s in filtered if any(s.get(r) == -1 for r in regions_on)]
    if filters.get("hide_inactive", False):
        filtered = [s for s in filtered if s.get("inactive_flag", 0) == 0]
    if filters.get("adu_only", False):
        filtered = [s for s in filtered if s.get("adu_flag", 0) == -1]
    if filters.get("juv_only", False):
        filtered = [s for s in filtered if s.get("juv_flag", 0) == -1]
    # Org-wide floor — see the matching comment in _load_species_from_db.
    if not filters.get("include_inactive"):
        filtered = [s for s in filtered if s.get("inactive_flag", 0) == 0]
    return filtered


# =====================================================================
#  Search / scoring
# =====================================================================

def _score_species(species: Dict, query: str) -> int:
    # `or ""` defends against a None value regardless of source (DB row with
    # a NULL column, or a CSV row with a blank field) — see the comment in
    # _load_species_from_db for why `.get(field, "")` alone isn't enough.
    code = (species.get("code") or "").lower()
    taxon = (species.get("taxon_name") or "").lower()
    sci = (species.get("scientific_name") or "").lower()
    genus = (species.get("genus") or "").lower()

    if code == query:
        return 100
    if code.startswith(query):
        return 90
    if query in code:
        return 80
    if taxon.startswith(query):
        return 70
    if query in taxon:
        return 60
    if query in sci:
        return 50
    if query in genus:
        return 40
    return 0


# =====================================================================
#  Endpoints
# =====================================================================

def _parse_filter_params(
    samoa, marianas, hawaii, johnston, line_island, phoenix, wake,
    hide_inactive, adu_only, juv_only,
) -> Optional[Dict]:
    """Build a filters dict from query params; returns None if no filters set."""
    filters: Dict[str, Any] = {}
    mapping = {
        "samoa": samoa, "marianas": marianas, "hawaii": hawaii,
        "johnston": johnston, "line_island": line_island,
        "phoenix": phoenix, "wake": wake,
    }
    for col, val in mapping.items():
        if val:
            filters[col] = True
    if hide_inactive:
        filters["hide_inactive"] = True
    if adu_only:
        filters["adu_only"] = True
    if juv_only:
        filters["juv_only"] = True
    return filters or None


@router.get("/species")
async def get_all_species(
    samoa: Optional[int] = None,
    marianas: Optional[int] = None,
    hawaii: Optional[int] = None,
    johnston: Optional[int] = None,
    line_island: Optional[int] = None,
    phoenix: Optional[int] = None,
    wake: Optional[int] = None,
    hide_inactive: Optional[int] = None,
    adu_only: Optional[int] = None,
    juv_only: Optional[int] = None,
    _current_user: Dict[str, Any] = Depends(require_auth),
):
    """Get complete list of coral species, optionally filtered."""
    filters = _parse_filter_params(
        samoa, marianas, hawaii, johnston, line_island, phoenix, wake,
        hide_inactive, adu_only, juv_only,
    )
    species = _get_species_list(filters)
    return {"count": len(species), "species": species}


@router.get("/species/search")
async def search_species(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(10, ge=1, le=100),
    samoa: Optional[int] = None,
    marianas: Optional[int] = None,
    hawaii: Optional[int] = None,
    johnston: Optional[int] = None,
    line_island: Optional[int] = None,
    phoenix: Optional[int] = None,
    wake: Optional[int] = None,
    hide_inactive: Optional[int] = None,
    adu_only: Optional[int] = None,
    juv_only: Optional[int] = None,
    _current_user: Dict[str, Any] = Depends(require_auth),
):
    """Search coral species by code/name with optional filters."""
    filters = _parse_filter_params(
        samoa, marianas, hawaii, johnston, line_island, phoenix, wake,
        hide_inactive, adu_only, juv_only,
    )
    species_list = _get_species_list(filters)
    if not species_list:
        return {"query": q, "count": 0, "results": []}

    query = q.lower().strip()
    results = []
    for sp in species_list:
        score = _score_species(sp, query)
        if score > 0:
            results.append({**sp, "score": score})

    results.sort(key=lambda x: (-x["score"], x.get("code", "")))
    return {"query": q, "count": len(results), "results": results[:limit]}


@router.get("/species/manage")
async def list_species_for_management(
    _current_user: Dict[str, Any] = Depends(require_team_lead_or_admin),
):
    """Every species, including disabled ones, for the team-lead config page.
    Unlike GET /species, this deliberately bypasses the org-wide floor.
    Registered ABOVE /species/{code} — FastAPI matches path routes in
    registration order, and {code} would otherwise swallow this literal path
    (a request for /species/manage would 404 as "species code 'manage'").
    """
    if not _is_db_available():
        raise HTTPException(status_code=400, detail="Oracle backend not enabled")
    species = _load_species_from_db({"include_inactive": True})
    return {"count": len(species), "species": species}


@router.get("/species/{code}")
async def get_species_by_code(code: str, _current_user: Dict[str, Any] = Depends(require_auth)):
    """Get detailed information for a specific species code."""
    species_list = _get_species_list()
    code_upper = code.upper()
    for sp in species_list:
        if sp.get("code", "").upper() == code_upper:
            return sp
    raise HTTPException(status_code=404, detail=f"Species code '{code}' not found")


@router.get("/filters")
async def get_available_filters(_current_user: Dict[str, Any] = Depends(require_auth)):
    """Return the list of available region and flag filter columns."""
    return {
        "regions": REGION_COLUMNS,
        "flags": FLAG_COLUMNS,
        "flag_labels": {
            "inactive_flag": "Hide inactive species",
            "adu_flag": "Adult-survey species only",
            "juv_flag": "Juvenile-survey species only",
        },
        "region_labels": {
            "samoa": "Samoa",
            "marianas": "Marianas",
            "hawaii": "Hawaiʻi",
            "johnston": "Johnston",
            "line_island": "Line Islands",
            "phoenix": "Phoenix",
            "wake": "Wake",
        },
    }


@router.post("/species/import-csv")
async def import_species_from_csv(_current_user: Dict[str, Any] = Depends(require_team_lead_or_admin)):
    """Bulk-load species from the reference CSV into the cat_coral_species DB table."""
    if not _is_db_available():
        raise HTTPException(status_code=400, detail="Oracle backend not enabled")

    from cat.db.oracle import get_connection

    csv_file = _csv_path()
    if not csv_file.exists():
        raise HTTPException(status_code=404, detail="Species CSV not found")

    rows_to_insert = []
    with open(csv_file, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows_to_insert.append({
                "spcode": row.get("SPECIES", "").strip(),
                "taxon_name": row.get("TAXONNAME", "").strip(),
                "genus": row.get("GENUS", "").strip(),
                "family": row.get("FAMILY", "").strip(),
                "class_name": row.get("CLASS", "").strip(),
                "comp_class": row.get("COMPCLASS", "").strip(),
                "morphology_1": row.get("MORPHOLOGY_1", "").strip(),
                "morphology_2": row.get("MORPHOLOGY_2", "").strip(),
                "scientific_name": row.get("SCIENTIFIC_NAME", "").strip(),
                "gencode": row.get("GENCODE", "").strip(),
                "samoa": _flag_to_int(row.get("SAMOA", "0")),
                "marianas": _flag_to_int(row.get("MARIANAS", row.get("MARIANAS_", "0"))),
                "hawaii": _flag_to_int(row.get("HAWAII", "0")),
                "johnston": _flag_to_int(row.get("JOHNSTON", "0")),
                "line_island": _flag_to_int(row.get("LINE", "0")),
                "phoenix": _flag_to_int(row.get("PHOENIX", "0")),
                "wake": _flag_to_int(row.get("WAKE", "0")),
                "inactive_flag": _flag_to_int(row.get("INACTIVE_FLAG_YN", "0")),
                "adu_flag": _flag_to_int(row.get("ADU_FLAG_YN", "0")),
                "juv_flag": _flag_to_int(row.get("JUV_FLAG_YN", "0")),
            })

    # One connection for the whole import, not one per row per statement
    # (fetch_one/execute each open+close their own connection) — 338 rows used
    # to open 600+ short-lived connections in a tight loop, which was enough
    # to exhaust Oracle Free's listener connection limit (DPY-6000) on a
    # single import click.
    inserted = 0
    updated = 0
    with get_connection() as conn:
        with conn.cursor() as cursor:
            for r in rows_to_insert:
                if not r["spcode"]:
                    continue
                cursor.execute(
                    "SELECT species_id FROM cat_coral_species WHERE spcode = :spcode",
                    {"spcode": r["spcode"]},
                )
                existing = cursor.fetchone()
                if existing:
                    cursor.execute(
                        """UPDATE cat_coral_species SET
                            taxon_name=:taxon_name, genus=:genus, family=:family,
                            class_name=:class_name, comp_class=:comp_class,
                            morphology_1=:morphology_1, morphology_2=:morphology_2,
                            scientific_name=:scientific_name, gencode=:gencode,
                            samoa=:samoa, marianas=:marianas, hawaii=:hawaii,
                            johnston=:johnston, line_island=:line_island, phoenix=:phoenix,
                            wake=:wake, inactive_flag=:inactive_flag, adu_flag=:adu_flag,
                            juv_flag=:juv_flag
                        WHERE spcode=:spcode""",
                        r,
                    )
                    updated += 1
                else:
                    cursor.execute(
                        """INSERT INTO cat_coral_species (
                            spcode, taxon_name, genus, family, class_name, comp_class,
                            morphology_1, morphology_2, scientific_name, gencode,
                            samoa, marianas, hawaii, johnston, line_island, phoenix, wake,
                            inactive_flag, adu_flag, juv_flag
                        ) VALUES (
                            :spcode, :taxon_name, :genus, :family, :class_name, :comp_class,
                            :morphology_1, :morphology_2, :scientific_name, :gencode,
                            :samoa, :marianas, :hawaii, :johnston, :line_island, :phoenix, :wake,
                            :inactive_flag, :adu_flag, :juv_flag
                        )""",
                        r,
                    )
                    inserted += 1
        conn.commit()

    # Clear all caches so updated data is picked up immediately
    global _species_cache, _db_species_cache, _db_table_populated_cache
    _species_cache = None
    _db_species_cache = {}
    _db_table_populated_cache = None

    return {
        "success": True,
        "total_csv_rows": len(rows_to_insert),
        "inserted": inserted,
        "updated": updated,
    }


# =====================================================================
#  Team-lead / admin management — deployment-wide species enable/disable
#  (docs/team-lead-config-plan.md, Phase 2). "Disabled" reuses the existing
#  cat_coral_species.inactive_flag column, now enforced as a floor on every
#  annotator-facing list/search above, regardless of any per-project filter.
#  This never touches QC's own species lookup or historical annotation data —
#  see the invariant note in the plan doc.
# =====================================================================

class SpeciesEnabledUpdate(BaseModel):
    enabled: bool


def _invalidate_species_caches() -> None:
    global _db_species_cache, _db_table_populated_cache
    _db_species_cache = {}
    _db_table_populated_cache = None


@router.put("/species/{code}/enabled")
async def set_species_enabled(
    code: str,
    payload: SpeciesEnabledUpdate,
    _current_user: Dict[str, Any] = Depends(require_team_lead_or_admin),
):
    """Enable/disable one species deployment-wide. Disabling only removes it
    from the annotator-facing picker (see the org-wide floor above) — it does
    not touch, hide, or revalidate any existing annotation using this code."""
    if not _is_db_available():
        raise HTTPException(status_code=400, detail="Oracle backend not enabled")

    from cat.db.oracle import execute, fetch_one

    existing = fetch_one(
        "SELECT spcode FROM cat_coral_species WHERE spcode = :spcode",
        {"spcode": code},
    )
    if not existing:
        raise HTTPException(status_code=404, detail=f"Species code '{code}' not found")

    execute(
        "UPDATE cat_coral_species SET inactive_flag = :flag WHERE spcode = :spcode",
        {"flag": 0 if payload.enabled else 1, "spcode": code},
    )
    _invalidate_species_caches()
    return {"success": True, "code": code, "enabled": payload.enabled}

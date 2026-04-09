"""
API endpoints for coral species lookup and autocomplete.
Supports both CSV-file fallback and Oracle DB-backed mode.
When a DB is available, species are loaded from cat_coral_species
and can be filtered per-project by region columns and flags.
"""
import csv
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/api/coral", tags=["coral"])

# ── In-memory cache (CSV fallback) ──
_species_cache: Optional[List[Dict]] = None

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

        # Flag filters
        if filters.get("hide_inactive", False):
            where_clauses.append("inactive_flag = 0")
        if filters.get("adu_only", False):
            where_clauses.append("adu_flag = -1")
        if filters.get("juv_only", False):
            where_clauses.append("juv_flag = -1")

    where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
    sql = f"SELECT * FROM cat_coral_species{where_sql} ORDER BY spcode"

    rows = fetch_all(sql, params)
    return [
        {
            "code": r.get("spcode", ""),
            "taxon_name": r.get("taxon_name", ""),
            "scientific_name": r.get("scientific_name", ""),
            "genus": r.get("genus", ""),
            "family": r.get("family", ""),
            "morphology": f"{r.get('morphology_1', '') or ''} {r.get('morphology_2', '') or ''}".strip(),
            "class": r.get("class_name", ""),
            "gencode": r.get("gencode", ""),
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


def _get_species_list(filters: Optional[Dict] = None) -> List[Dict]:
    """Return species from DB if available, otherwise CSV (with in-memory filtering)."""
    if _is_db_available():
        try:
            db_rows = _load_species_from_db(filters)
            if db_rows:
                return db_rows
        except Exception as e:
            print(f"⚠️ DB species query failed, falling back to CSV: {e}")

    # CSV fallback — apply filters in memory
    all_species = load_species_list()
    if not filters:
        return all_species

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
    return filtered


# =====================================================================
#  Search / scoring
# =====================================================================

def _score_species(species: Dict, query: str) -> int:
    code = species.get("code", "").lower()
    taxon = species.get("taxon_name", "").lower()
    sci = species.get("scientific_name", "").lower()
    genus = species.get("genus", "").lower()

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


@router.get("/species/{code}")
async def get_species_by_code(code: str):
    """Get detailed information for a specific species code."""
    species_list = _get_species_list()
    code_upper = code.upper()
    for sp in species_list:
        if sp.get("code", "").upper() == code_upper:
            return sp
    raise HTTPException(status_code=404, detail=f"Species code '{code}' not found")


@router.get("/filters")
async def get_available_filters():
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
async def import_species_from_csv():
    """Bulk-load species from the reference CSV into the cat_coral_species DB table."""
    if not _is_db_available():
        raise HTTPException(status_code=400, detail="Oracle backend not enabled")

    from cat.db.oracle import execute, fetch_one

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

    inserted = 0
    updated = 0
    for r in rows_to_insert:
        if not r["spcode"]:
            continue
        existing = fetch_one(
            "SELECT species_id FROM cat_coral_species WHERE spcode = :spcode",
            {"spcode": r["spcode"]},
        )
        if existing:
            execute(
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
            execute(
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

    # Clear the in-memory CSV cache so DB takes over
    global _species_cache
    _species_cache = None

    return {
        "success": True,
        "total_csv_rows": len(rows_to_insert),
        "inserted": inserted,
        "updated": updated,
    }

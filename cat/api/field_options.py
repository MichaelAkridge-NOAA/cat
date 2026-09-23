"""
Team-lead annotation-form configuration, Phase 3
(docs/team-lead-config-plan.md). Every configurable dropdown/autocomplete
option list for the annotation form — previously hardcoded, and duplicated
across annotation.html, the edit modal (annotation-form.js), and the
batch-fill/bulk-update modals (v2-table.js) — now lives in one table.

Same rule as species (Phase 2, cat/api/coral_species.py): disabling an option
only changes what a NEW selection offers. It never touches, hides, or
revalidates an annotation that already has that value saved — the client is
responsible for still rendering a since-disabled value on an existing record
(see annotation-runtime-field-options.js).
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from cat.api.auth import require_auth, require_team_lead_or_admin
from cat.db.config import is_oracle_backend_enabled

router = APIRouter(prefix="/api/config/field-options", tags=["field-options"])

# Every field this page knows how to configure. Kept as an explicit allowlist
# (not "whatever rows exist") so a typo'd field_name in a PUT/POST can't
# silently create a new, never-consumed field.
KNOWN_FIELDS = [
    "transect", "segment", "morph_code",
    "no_colony", "juvenile", "remnant", "ex_bound",
    "juv_substrate",
    # Group lists: one list drives several numbered annotation fields.
    "rdcause", "con", "sev",
]

# Annotation properties each group list applies to (the rest are 1:1).
FIELD_GROUP_MEMBERS = {
    "rdcause": ["rdcause1", "rdcause2", "rdcause3"],
    "con": ["con_1", "con_2", "con_3"],
    "sev": ["sev_1", "sev_2", "sev_3"],
}

# Fields a deployment-wide DEFAULT VALUE makes sense for (Phase 4 candidate,
# docs/team-lead-config-plan.md) — the same set the existing "Set Defaults"
# button already lets an individual annotator capture locally
# (v2-defaults.js captureCurrentFormAsDefaults), now offered as a floor
# beneath that and beneath the per-account preference tier.
KNOWN_DEFAULT_FIELDS = [
    "analyst", "obs_year", "mission_id", "site",
    "transect", "segment", "seglength", "segwidth",
    "spcode", "morph_code",
]


def _ensure_oracle_mode() -> None:
    if not is_oracle_backend_enabled():
        raise HTTPException(status_code=400, detail="Oracle backend not enabled. Set CAT_STORAGE_BACKEND=oracle")


def _check_field(field_name: str) -> None:
    if field_name not in KNOWN_FIELDS:
        raise HTTPException(status_code=404, detail=f"Unknown field '{field_name}'")


def _check_default_field(field_name: str) -> None:
    if field_name not in KNOWN_DEFAULT_FIELDS:
        raise HTTPException(status_code=404, detail=f"'{field_name}' does not support a configured default")


class OptionCreate(BaseModel):
    value: str = Field(min_length=1, max_length=120)
    label: Optional[str] = Field(default=None, max_length=255)


class OptionEnabledUpdate(BaseModel):
    value: str = Field(min_length=1, max_length=120)
    enabled: bool


def _row_out(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "value": row["option_value"],
        "label": row.get("option_label") or row["option_value"],
        "order": row.get("display_order") or 0,
        "enabled": bool(row.get("is_enabled")),
    }


@router.get("")
async def get_all_field_options(_current_user: Dict[str, Any] = Depends(require_auth)):
    """Enabled options for every known field, one call for the whole
    annotation form. Disabled options are omitted — the client merges in an
    existing annotation's own (possibly since-disabled) value itself."""
    _ensure_oracle_mode()
    from cat.db.oracle import fetch_all

    rows = fetch_all(
        """
        SELECT field_name, option_value, option_label, display_order, is_enabled
        FROM cat_annotation_field_options
        WHERE field_name IN ({placeholders})
          AND is_enabled = 1
        ORDER BY field_name, display_order, option_value
        """.format(placeholders=",".join(f"'{f}'" for f in KNOWN_FIELDS)),
    )
    fields: Dict[str, List[Dict[str, Any]]] = {f: [] for f in KNOWN_FIELDS}
    for r in rows:
        fields.setdefault(r["field_name"], []).append(_row_out(r))
    return {"fields": fields}


@router.get("/manage")
async def get_all_field_options_for_management(
    _current_user: Dict[str, Any] = Depends(require_team_lead_or_admin),
):
    """Every option for every field, including disabled ones, for the
    team-lead config page."""
    _ensure_oracle_mode()
    from cat.db.oracle import fetch_all

    rows = fetch_all(
        """
        SELECT field_name, option_value, option_label, display_order, is_enabled
        FROM cat_annotation_field_options
        WHERE field_name IN ({placeholders})
        ORDER BY field_name, display_order, option_value
        """.format(placeholders=",".join(f"'{f}'" for f in KNOWN_FIELDS)),
    )
    fields: Dict[str, List[Dict[str, Any]]] = {f: [] for f in KNOWN_FIELDS}
    for r in rows:
        fields.setdefault(r["field_name"], []).append(_row_out(r))
    return {"fields": fields}


@router.put("/{field_name}/enabled")
async def set_field_option_enabled(
    field_name: str,
    payload: OptionEnabledUpdate,
    _current_user: Dict[str, Any] = Depends(require_team_lead_or_admin),
):
    """Enable/disable one option value for one field. The value is carried in
    the body (not the URL path) because several existing option values start
    with '-' (e.g. '-1' for Yes) or are otherwise awkward as a raw path
    segment."""
    _ensure_oracle_mode()
    _check_field(field_name)
    from cat.db.oracle import execute, fetch_one

    existing = fetch_one(
        "SELECT option_id FROM cat_annotation_field_options WHERE field_name = :f AND option_value = :v",
        {"f": field_name, "v": payload.value},
    )
    if not existing:
        raise HTTPException(status_code=404, detail=f"'{payload.value}' is not a known option of '{field_name}'")

    execute(
        "UPDATE cat_annotation_field_options SET is_enabled = :e WHERE field_name = :f AND option_value = :v",
        {"e": 1 if payload.enabled else 0, "f": field_name, "v": payload.value},
    )
    return {"success": True, "field": field_name, "value": payload.value, "enabled": payload.enabled}


@router.post("/{field_name}")
async def add_field_option(
    field_name: str,
    payload: OptionCreate,
    _current_user: Dict[str, Any] = Depends(require_team_lead_or_admin),
):
    """Add a new option value to a field (e.g. a new morphology code) without
    a code deploy. New options start enabled."""
    _ensure_oracle_mode()
    _check_field(field_name)
    from cat.db.oracle import execute, fetch_one

    existing = fetch_one(
        "SELECT option_id FROM cat_annotation_field_options WHERE field_name = :f AND option_value = :v",
        {"f": field_name, "v": payload.value},
    )
    if existing:
        raise HTTPException(status_code=409, detail=f"'{payload.value}' already exists for '{field_name}'")

    max_order_row = fetch_one(
        "SELECT MAX(display_order) AS m FROM cat_annotation_field_options WHERE field_name = :f",
        {"f": field_name},
    )
    next_order = int((max_order_row or {}).get("m") or 0) + 1

    execute(
        """INSERT INTO cat_annotation_field_options (field_name, option_value, option_label, display_order, is_enabled)
           VALUES (:f, :v, :l, :o, 1)""",
        {"f": field_name, "v": payload.value, "l": payload.label or payload.value, "o": next_order},
    )
    return {"success": True, "field": field_name, "value": payload.value, "label": payload.label or payload.value}


@router.get("/{field_name}/used-values")
async def get_used_values(
    field_name: str,
    _current_user: Dict[str, Any] = Depends(require_team_lead_or_admin),
):
    """Distinct values annotators have actually saved for this field (all
    projects, live annotations), most used first — so a team lead can build
    a list from real data instead of guessing codes. Read-only."""
    _ensure_oracle_mode()
    _check_field(field_name)
    from cat.db.oracle import fetch_all

    members = FIELD_GROUP_MEMBERS.get(field_name, [field_name])
    # Member names come from the fixed allowlist above, never from the request.
    parts = " UNION ALL ".join(
        f"SELECT JSON_VALUE(properties_json, '$.{m}') AS v FROM cat_annotations WHERE deleted_at IS NULL"
        for m in members
    )
    rows = fetch_all(
        f"""
        SELECT TRIM(v) AS v, COUNT(*) AS n FROM ({parts})
        WHERE TRIM(v) IS NOT NULL
        GROUP BY TRIM(v)
        ORDER BY n DESC, v
        FETCH FIRST 200 ROWS ONLY
        """
    )
    return {"field": field_name, "values": [{"value": r["v"], "count": int(r["n"])} for r in rows]}


# ---------------------------------------------------------------------------
# Team-lead field DEFAULTS (Phase 4 candidate) — a separate, smaller concept
# from the option lists above: one default VALUE per field, consulted only
# when a session hasn't set a local default and the account has no saved
# preference for it either (see v2-defaults.js). Setting/clearing a default
# never touches any saved annotation.
# ---------------------------------------------------------------------------

router_defaults = APIRouter(prefix="/api/config/field-defaults", tags=["field-options"])


class DefaultValueUpdate(BaseModel):
    value: Optional[str] = Field(default=None, max_length=255)


@router_defaults.get("")
async def get_field_defaults(_current_user: Dict[str, Any] = Depends(require_auth)):
    """Every currently-configured deployment-wide default, keyed by field
    name. A field with no row here has no team-wide default."""
    _ensure_oracle_mode()
    from cat.db.oracle import fetch_all

    rows = fetch_all(
        "SELECT field_name, default_value FROM cat_annotation_field_defaults WHERE field_name IN ({placeholders})".format(
            placeholders=",".join(f"'{f}'" for f in KNOWN_DEFAULT_FIELDS)
        ),
    )
    return {"defaults": {r["field_name"]: r["default_value"] for r in rows}}


@router_defaults.put("/{field_name}")
async def set_field_default(
    field_name: str,
    payload: DefaultValueUpdate,
    current_user: Dict[str, Any] = Depends(require_team_lead_or_admin),
):
    """Set (or, with an empty/omitted value, clear) the deployment-wide
    default for one field."""
    _ensure_oracle_mode()
    _check_default_field(field_name)
    from cat.db.oracle import execute

    value = (payload.value or "").strip()
    if not value:
        execute("DELETE FROM cat_annotation_field_defaults WHERE field_name = :f", {"f": field_name})
        return {"success": True, "field": field_name, "value": None}

    execute(
        """
        MERGE INTO cat_annotation_field_defaults dst
        USING (SELECT :f AS field_name, :v AS default_value, :u AS updated_by_user_id FROM DUAL) src
        ON (dst.field_name = src.field_name)
        WHEN MATCHED THEN UPDATE SET dst.default_value = src.default_value, dst.updated_at = CURRENT_TIMESTAMP,
            dst.updated_by_user_id = src.updated_by_user_id
        WHEN NOT MATCHED THEN INSERT (field_name, default_value, updated_by_user_id)
            VALUES (src.field_name, src.default_value, src.updated_by_user_id)
        """,
        {"f": field_name, "v": value, "u": current_user.get("user_id")},
    )
    return {"success": True, "field": field_name, "value": value}

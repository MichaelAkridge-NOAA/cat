"""Oracle-backed project API for CAT."""

from datetime import datetime
import json
import logging
import tempfile
import zipfile
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.encoders import jsonable_encoder
from fastapi.responses import Response
from pydantic import BaseModel, Field

from cat.api.auth import require_auth, require_admin
from cat.db import auth as auth_db
from cat.db.config import is_oracle_backend_enabled
from cat.db.oracle import execute, execute_returning_id, execute_rowcount, execute_many, fetch_all, fetch_one, test_connection, get_connection
from cat.db.schema import bootstrap_schema


def _numpy_safe_json(obj):
    """JSON serializer that handles numpy types from geopandas DataFrames."""
    import math
    try:
        import numpy as np
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            if np.isnan(obj):
                return None
            return float(obj)
        if isinstance(obj, (np.bool_,)):
            return bool(obj)
        if isinstance(obj, (np.ndarray,)):
            return obj.tolist()
    except ImportError:
        pass
    # Handle pandas NaT / NaN
    try:
        import pandas as pd
        if pd.isna(obj):
            return None
    except (ImportError, TypeError, ValueError):
        pass
    if isinstance(obj, float) and math.isnan(obj):
        return None
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/db", tags=["db-projects"])


class ProjectCreate(BaseModel):
    project_name: str = Field(min_length=1, max_length=255)
    site: Optional[str] = None
    cruise: Optional[str] = None
    year: Optional[int] = None
    region: Optional[str] = None
    observer: Optional[str] = None
    notes: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class AssetCreate(BaseModel):
    asset_name: str = Field(min_length=1, max_length=255)
    cog_url: str = Field(min_length=1, max_length=4000)
    asset_type: str = Field(default="COG", max_length=30)
    source_uri: Optional[str] = None
    source_epsg: Optional[int] = None
    target_epsg: Optional[int] = None
    bounds: Optional[List[float]] = None


class AnnotationCreate(BaseModel):
    asset_id: Optional[int] = None
    feature: Dict[str, Any]
    properties: Dict[str, Any] = Field(default_factory=dict)
    created_by: Optional[str] = None
    # Client-generated id, re-sent on every retry of the same create so the
    # server can return the row it already made instead of inserting again.
    client_uuid: Optional[str] = Field(default=None, max_length=64)


class OverlayLayerCreate(BaseModel):
    layer_name: str = Field(min_length=1, max_length=255)
    source_uri: Optional[str] = None
    source_epsg: Optional[int] = None
    target_epsg: Optional[int] = None
    style: Dict[str, Any] = Field(default_factory=dict)
    layer_type: Optional[str] = None


class OverlayFeatureCreate(BaseModel):
    feature: Dict[str, Any]
    properties: Dict[str, Any] = Field(default_factory=dict)


class OverlayBufferRequest(BaseModel):
    distance_m: float
    new_layer_name: Optional[str] = None


class OverlayClipRequest(BaseModel):
    clip_layer_id: int
    new_layer_name: Optional[str] = None


class OverlayFeatureResizeRequest(BaseModel):
    width_m: float
    length_m: Optional[float] = None


class LatLng(BaseModel):
    lat: float
    lng: float


class TransectGenerateRequest(BaseModel):
    points: List[LatLng] = Field(min_length=2)
    num_segments: int = Field(default=4, ge=1, le=20)
    segment_length_m: float = Field(default=2.5, gt=0)
    segment_gap_m: float = Field(default=2.5, ge=0)
    segment_width_m: float = Field(default=1.0, gt=0)
    notes: Optional[str] = None


class ProjectUpdate(BaseModel):
    project_name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    site: Optional[str] = None
    cruise: Optional[str] = None
    year: Optional[int] = None
    region: Optional[str] = None
    observer: Optional[str] = None
    notes: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class AnnotationUpdate(BaseModel):
    feature: Optional[Dict[str, Any]] = None
    properties: Optional[Dict[str, Any]] = None
    created_by: Optional[str] = None
    version: Optional[int] = None  # client's current version for optimistic locking (4a)


class AnnotationBulkReplace(BaseModel):
    annotations: List[AnnotationCreate] = Field(default_factory=list)


class AnnotationBulkCreate(BaseModel):
    annotations: List[AnnotationCreate] = Field(default_factory=list)


class CollaboratorAdd(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    role: str = Field(default="viewer")


class CollaboratorRoleUpdate(BaseModel):
    role: str


class SessionStart(BaseModel):
    username: str = Field(min_length=1, max_length=120)


class SessionUpdate(BaseModel):
    total_seconds: Optional[int] = None
    annotation_count: Optional[int] = None
    is_active: Optional[bool] = None


class SessionHeartbeat(BaseModel):
    pass  # body intentionally empty — POST to the endpoint is the signal (4c)



def _ensure_oracle_mode() -> None:
    if not is_oracle_backend_enabled():
        raise HTTPException(
            status_code=400,
            detail="Oracle backend not enabled. Set CAT_STORAGE_BACKEND=oracle",
        )


_PROJECT_ROLE_RANK = {"viewer": 1, "editor": 2, "owner": 3}


def _get_effective_project_role(project_id: int, current_user: Dict[str, Any]) -> Optional[str]:
    """Resolve the caller's effective role on a project: global admins and the
    project owner always resolve to 'owner'; otherwise look up
    cat_project_collaborators. Returns None only if the project doesn't
    exist — every other authenticated caller resolves to at least 'viewer'
    (open-read baseline: any logged-in user can view/report/QC/export any
    project; only editing still requires being the owner or an added
    editor/owner collaborator, enforced by the editor/owner tiers above this
    floor)."""
    if current_user.get("role") == "admin":
        return "owner"
    project = fetch_one(
        "SELECT owner_user_id FROM cat_projects WHERE project_id = :project_id",
        {"project_id": project_id},
    )
    if not project:
        return None
    if project.get("owner_user_id") == current_user.get("user_id"):
        return "owner"
    collab = fetch_one(
        "SELECT role FROM cat_project_collaborators WHERE project_id = :project_id AND user_id = :user_id",
        {"project_id": project_id, "user_id": current_user.get("user_id")},
    )
    if collab:
        return collab["role"]
    return "viewer"


def _require_project_role(project_id: int, current_user: Dict[str, Any], min_role: str) -> str:
    """Raise 404 if the project doesn't exist, 403 if the caller's effective
    role doesn't meet min_role ('viewer' < 'editor' < 'owner'). Returns the
    caller's resolved role on success — call sites that already need the
    project row for other reasons can skip re-fetching it here."""
    role = _get_effective_project_role(project_id, current_user)
    if role is None:
        project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        raise HTTPException(status_code=403, detail="You don't have access to this project")
    if _PROJECT_ROLE_RANK[role] < _PROJECT_ROLE_RANK[min_role]:
        raise HTTPException(status_code=403, detail=f"Requires {min_role} access to this project (you have {role})")
    return role


def _log_activity(project_id: int, user_id: Optional[int], action: str, details: Optional[Dict[str, Any]] = None) -> None:
    """Best-effort per-project activity log entry. Never raises — logging must
    not break the operation it's recording."""
    try:
        execute(
            """
            INSERT INTO cat_project_activity_log (project_id, user_id, action, details_json)
            VALUES (:project_id, :user_id, :action, :details_json)
            """,
            {
                "project_id": project_id,
                "user_id": user_id,
                "action": action,
                "details_json": json.dumps(details) if details is not None else None,
            },
        )
    except Exception:
        pass


def _parse_json_field(value: Any, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return default if default is not None else value
    return default if default is not None else value


def _normalize_project_row(row: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(row)
    normalized["metadata"] = _parse_json_field(normalized.pop("metadata_json", None), default={})
    normalized["year"] = normalized.pop("year_num", None)
    normalized["observer"] = normalized.pop("observer_name", None)
    return normalized


def _normalize_asset_row(row: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(row)
    normalized["bounds"] = _parse_json_field(normalized.pop("bounds_json", None), default=None)
    return normalized


def _normalize_annotation_row(row: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(row)
    feature = _parse_json_field(normalized.pop("feature_geojson", None), default=None)
    properties = _parse_json_field(normalized.pop("properties_json", None), default={})
    normalized["feature"] = feature
    # `feature_geojson` stores a full GeoJSON Feature ({type:"Feature",
    # geometry:{...}, properties:{...}}) — that's what "feature" correctly
    # holds above, and what the single-annotation GET/PUT/POST responses
    # return as-is (the client's own normalizeDbAnnotationResponse() already
    # drills into `.feature.geometry` itself). "geometry" here is a SEPARATE,
    # bare-geometry convenience for callers that just want {type,
    # coordinates} without unwrapping it themselves — e.g. building a
    # FeatureCollection for a map, where geometry has to be the geometry,
    # not another Feature. This used to just be `feature` again (a copy-paste
    # of the line above), which meant any caller trusting the name "geometry"
    # inherited an accidental extra layer of nesting and fed Leaflet/GeoJSON
    # consumers an invalid `{type:"Feature", geometry:{...}}` where a plain
    # geometry was expected — this is exactly what made annotations_geojson()
    # (used by the project drawer's preview map) throw "Invalid GeoJSON
    # object" and abort before the map ever fit to the imagery's bounds.
    normalized["geometry"] = feature.get("geometry") if isinstance(feature, dict) else None
    normalized["properties"] = properties
    # Expose version for optimistic locking (4a); default 1 for legacy rows
    normalized.setdefault("version", 1)
    return normalized


def _normalize_layer_row(row: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(row)
    normalized["style"] = _parse_json_field(normalized.pop("style_json", None), default={})
    return normalized


@router.get("/health")
def db_health() -> Dict[str, Any]:
    _ensure_oracle_mode()
    status = test_connection()
    return {
        "backend": "oracle",
        "connected": status.get("ok", False),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }


@router.post("/bootstrap")
def db_bootstrap(_current_user: Dict[str, Any] = Depends(require_admin)) -> Dict[str, Any]:
    _ensure_oracle_mode()
    return bootstrap_schema()


@router.post("/projects")
def create_project(
    payload: ProjectCreate,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    observer = payload.observer or current_user.get("display_name")

    sql = """
        INSERT INTO cat_projects (
            project_name, site, cruise, year_num, region, observer_name, notes, metadata_json, owner_user_id
        ) VALUES (
            :project_name, :site, :cruise, :year_num, :region, :observer_name, :notes, :metadata_json, :owner_user_id
        ) RETURNING project_id INTO :project_id
    """

    try:
        project_id = execute_returning_id(
            sql,
            {
                "project_name": payload.project_name,
                "site": payload.site,
                "cruise": payload.cruise,
                "year_num": payload.year,
                "region": payload.region,
                "observer_name": observer,
                "notes": payload.notes,
                "metadata_json": json.dumps(payload.metadata),
                "owner_user_id": current_user["user_id"],
            },
            id_column="project_id",
        )
    except Exception as exc:
        message = str(exc)
        if "ORA-00001" in message:
            raise HTTPException(status_code=409, detail="You already have a project with this name")
        raise HTTPException(status_code=500, detail=message)

    project = fetch_one("SELECT * FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    return {"success": True, "project": _normalize_project_row(project)}


@router.get("/projects")
def list_projects(
    limit: int = 50,
    offset: int = 0,
    q: Optional[str] = None,
    region: Optional[str] = None,
    year: Optional[int] = None,
    sort_by: str = "created_at",
    sort_dir: str = "desc",
    scope: str = "mine",
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    limit = max(1, min(limit, 500))
    offset = max(0, offset)

    sort_map = {
        "created_at": "created_at",
        "updated_at": "updated_at",
        "project_name": "project_name",
        "site": "site",
        "year": "year_num",
    }
    order_col = sort_map.get((sort_by or "").lower(), "created_at")
    order_dir = "ASC" if (sort_dir or "").lower() == "asc" else "DESC"

    conditions: List[str] = []
    filter_params: Dict[str, Any] = {}

    if q and q.strip():
        filter_params["q"] = f"%{q.strip()}%"
        conditions.append(
            """
            (
                LOWER(project_name) LIKE LOWER(:q)
                OR LOWER(NVL(site, '')) LIKE LOWER(:q)
                OR LOWER(NVL(cruise, '')) LIKE LOWER(:q)
                OR LOWER(NVL(region, '')) LIKE LOWER(:q)
                OR LOWER(NVL(observer_name, '')) LIKE LOWER(:q)
                OR LOWER(NVL(notes, '')) LIKE LOWER(:q)
            )
            """
        )

    if region and region.strip():
        filter_params["region"] = region.strip()
        conditions.append("region = :region")

    if year is not None:
        filter_params["year"] = year
        conditions.append("year_num = :year")

    scope_sql, scope_params, scope = _scope_where(scope, current_user)
    filter_params.update(scope_params)
    if scope_sql != "1=1":
        conditions.append(scope_sql)

    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_sql = f"SELECT COUNT(*) AS total_count FROM cat_projects {where_sql}"
    count_row = fetch_one(count_sql, filter_params)
    total_count = int((count_row or {}).get("total_count") or 0)

    # Owner display info is joined outside the paged subquery so the WHERE/
    # ORDER BY clauses above (unqualified column names, shared with the count
    # query) don't need touching, and so cat_users.created_at can't collide
    # with cat_projects.created_at under SELECT *.
    # Per-project tallies the project list renders on each card (annotation
    # count, imagery/overlay counts, when it was last worked on). These are
    # correlated subqueries in the OUTER select, deliberately: inside the
    # paged subquery they would be evaluated for every project matching the
    # filter before paging cut it to one screen's worth. Out here they run
    # at most `limit` times, each an indexed lookup on project_id.
    #
    # Counting in SQL rather than reusing aggregate_annotations() (which the
    # QC page uses) matters: that helper pulls every annotation's CLOBs back
    # into Python, so a list of 20 projects would drag thousands of geometry
    # blobs across the wire to render twenty little "412 annotations" chips.
    sql = """
        SELECT p.*, u.display_name AS owner_display_name, u.username AS owner_username,
            (SELECT COUNT(*) FROM cat_annotations a
              WHERE a.project_id = p.project_id AND a.deleted_at IS NULL) AS annotation_count,
            (SELECT COUNT(*) FROM cat_project_assets s
              WHERE s.project_id = p.project_id) AS asset_count,
            (SELECT COUNT(*) FROM cat_overlay_layers l
              WHERE l.project_id = p.project_id) AS overlay_count,
            (SELECT COUNT(*) FROM cat_project_collaborators c
              WHERE c.project_id = p.project_id) AS collaborator_count,
            (SELECT c.role FROM cat_project_collaborators c
              WHERE c.project_id = p.project_id AND c.user_id = :my_user_id) AS collab_role,
            (SELECT MAX(NVL(a.updated_at, a.created_at)) FROM cat_annotations a
              WHERE a.project_id = p.project_id AND a.deleted_at IS NULL) AS last_annotated_at
        FROM (
            SELECT *
            FROM cat_projects
            {where_sql}
            ORDER BY {order_col} {order_dir}, project_id DESC
            OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY
        ) p
        LEFT JOIN cat_users u ON u.user_id = p.owner_user_id
        ORDER BY p.{order_col} {order_dir}, p.project_id DESC
    """.format(where_sql=where_sql, order_col=order_col, order_dir=order_dir)
    my_user_id = current_user.get("user_id")
    rows = fetch_all(sql, {**filter_params, "limit": limit, "offset": offset, "my_user_id": my_user_id})

    is_admin = current_user.get("role") == "admin"
    for r in rows:
        collab_role = r.pop("collab_role", None)
        if is_admin or r.get("owner_user_id") == my_user_id:
            r["my_role"] = "owner"
        else:
            r["my_role"] = collab_role or "viewer"

    _attach_incomplete_counts(rows)

    return {
        "success": True,
        "count": len(rows),
        "total_count": total_count,
        "limit": limit,
        "offset": offset,
        "has_more": (offset + len(rows)) < total_count,
        "sort_by": sort_by,
        "sort_dir": order_dir.lower(),
        "q": q,
        "region": region,
        "year": year,
        "scope": scope,
        "projects": [_normalize_project_row(r) for r in rows],
    }


def _attach_incomplete_counts(rows: List[Dict[str, Any]]) -> None:
    """Add `incomplete_count` (annotations with no species code) to each row.

    Deliberately a SECOND query rather than another subselect in the list
    SQL above. Counting these needs to look inside properties_json, which
    means Oracle's JSON_VALUE — a function whose availability over a plain
    CLOB varies with database version and whether the column carries an
    IS JSON constraint. Folding it into the main query would mean that on a
    database where it isn't available, the entire project list 500s instead
    of merely lacking a progress bar.

    So: run it separately, swallow failure, and leave `incomplete_count`
    absent. The card reads a missing value as "no progress data" and
    renders the annotation count alone (see renderDbProjectList in
    project_creator.html).

    Modifies `rows` in place; callers normalize afterwards.
    """
    project_ids = [r.get("project_id") for r in rows if r.get("project_id") is not None]
    if not project_ids:
        return

    # One bind per id, never string interpolation — same rule as
    # aggregate_annotations().
    id_binds = {f"icid{i}": pid for i, pid in enumerate(project_ids)}
    in_clause = ", ".join(f":{k}" for k in id_binds)

    try:
        counts = fetch_all(
            f"""
            SELECT project_id, COUNT(*) AS incomplete_count
            FROM cat_annotations
            WHERE project_id IN ({in_clause})
              AND deleted_at IS NULL
              AND NVL(TRIM(JSON_VALUE(properties_json, '$.spcode')), '-') IN ('-', '')
            GROUP BY project_id
            """,
            id_binds,
        )
    except Exception as exc:
        logger.info("Skipping incomplete_count (JSON query unavailable): %s", exc)
        return

    by_id = {c["project_id"]: int(c.get("incomplete_count") or 0) for c in counts}
    for row in rows:
        row["incomplete_count"] = by_id.get(row.get("project_id"), 0)


def _visible_project_where(current_user: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """WHERE-clause fragment + binds restricting to projects the caller can
    see. Open-read baseline: every authenticated user can see every
    project (matches _get_effective_project_role's 'viewer' floor) — only
    editing is restricted by role/collaborator status, not visibility.
    Kept as a function (rather than inlining '1=1' at each call site) so
    filter-options/export/qc share one place to change if visibility policy
    is ever narrowed again."""
    return "1=1", {}


def _scope_where(scope: Optional[str], current_user: Dict[str, Any]) -> Tuple[str, Dict[str, Any], str]:
    """WHERE-clause fragment + binds + normalized scope name for the
    Mine/All ownership filter — the "My Projects" vs "All Projects" toggle
    on the Project Manager, extracted here so the QC dashboard and the
    Export page's project list can apply the exact same rule (list_projects
    below used to be the only place this logic lived).

    "mine" (default) is projects I own OR am a collaborator on. "all" drops
    the ownership condition entirely — still subject to _visible_project_where
    wherever the caller applies both. "user:<id>" (used by list_projects,
    not exposed on QC/export yet) scopes to one specific owner.
    """
    scope = (scope or "mine").strip()
    if scope == "all":
        return "1=1", {}, "all"
    if scope.startswith("user:"):
        try:
            owner_id = int(scope.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid scope: expected 'user:<id>'")
        return "owner_user_id = :owner_user_id", {"owner_user_id": owner_id}, scope

    return (
        """
        (owner_user_id = :owner_user_id OR project_id IN (
            SELECT project_id FROM cat_project_collaborators WHERE user_id = :owner_user_id
        ))
        """,
        {"owner_user_id": current_user["user_id"]},
        "mine",
    )


@router.get("/projects/filter-options")
def project_filter_options(current_user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    """Distinct region/year values across projects visible to the caller —
    feeds the region/year filter dropdowns on the export page. Registered
    ahead of /projects/{project_id} below: that route has no int converter
    on its path param, so Starlette would otherwise match this static path
    to it first (project_id="filter-options") and 422 before ever reaching
    this handler."""
    _ensure_oracle_mode()
    visible_where, params = _visible_project_where(current_user)

    regions = fetch_all(
        f"SELECT DISTINCT region FROM cat_projects WHERE {visible_where} AND region IS NOT NULL ORDER BY region",
        params,
    )
    years = fetch_all(
        f"SELECT DISTINCT year_num FROM cat_projects WHERE {visible_where} AND year_num IS NOT NULL ORDER BY year_num DESC",
        params,
    )
    return {
        "success": True,
        "regions": [r["region"] for r in regions],
        "years": [int(y["year_num"]) for y in years],
    }


@router.get("/projects/qc")
def projects_qc(
    project_ids: Optional[str] = None,
    region: Optional[str] = None,
    year: Optional[int] = None,
    scope: Optional[str] = "all",
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Cross-project QC/completeness dashboard. Same project-selection rules
    as the exporter (_resolve_export_project_ids: explicit project_ids, else
    region/year filter, else every project the caller can see) — returns an
    overall rollup plus a per-project breakdown with completeness/consistency
    flags, so a reviewer sees both the aggregate picture and exactly which
    projects need attention. `scope` is the same Mine/All ownership filter
    the Project Manager's project list uses ("mine" = owned + collaborator).
    Registered ahead of /projects/{project_id} for the same routing reason
    as filter-options above."""
    _ensure_oracle_mode()
    ids = _resolve_export_project_ids(project_ids, region, year, current_user, scope)

    if not ids:
        return {"project_ids": [], "rollup": aggregate_annotations([]), "projects": []}

    started = datetime.now()
    project_rows: List[Dict[str, Any]] = []
    for in_clause, binds in _chunked_in(ids):
        project_rows.extend(fetch_all(
            f"SELECT project_id, project_name, region, year_num FROM cat_projects "
            f"WHERE project_id IN ({in_clause})",
            binds,
        ))
    project_rows.sort(key=lambda r: str(r.get("project_name") or ""))

    # One fetch for everything, grouped in memory. This used to re-read every
    # annotation for the rollup and then once more per project (3 queries
    # each), so the page slowed down linearly with the number of projects.
    rows, species_lookup, epsgs_by_project = _load_aggregate_inputs(ids)
    rows_by_project: Dict[int, List[Dict[str, Any]]] = {}
    for r in rows:
        rows_by_project.setdefault(r["project_id"], []).append(r)
    all_epsgs = [e for pid in ids for e in epsgs_by_project.get(pid, [])]
    rollup = _aggregate_rows(rows, species_lookup, _is_geographic(all_epsgs))

    projects = []
    for p in project_rows:
        pid = p["project_id"]
        stats = _aggregate_rows(rows_by_project.get(pid, []), species_lookup,
                                _is_geographic(epsgs_by_project.get(pid, [])))
        missing_spcode = stats["missing_fields"]["spcode"]
        missing_con1 = stats["missing_fields"]["con_1"]
        unrecognized = stats.get("by_unrecognized_species") or []
        unrecognized_total = sum(u["count"] for u in unrecognized)

        flags = []
        if stats["annotation_count"] == 0:
            flags.append({"type": "empty", "count": 0, "message": "No annotations yet"})
        if missing_spcode:
            flags.append({
                "type": "missing_species", "count": missing_spcode,
                "message": f"{missing_spcode} annotation(s) missing species",
            })
        if missing_con1:
            flags.append({
                "type": "missing_condition", "count": missing_con1,
                "message": f"{missing_con1} annotation(s) missing condition",
            })
        if unrecognized:
            codes = ", ".join(u["spcode"] for u in unrecognized[:5])
            flags.append({
                "type": "unrecognized_species", "count": unrecognized_total,
                "message": f"{unrecognized_total} annotation(s) with unrecognized species code(s): {codes}",
            })

        projects.append({
            "project_id": pid,
            "project_name": p.get("project_name"),
            "region": p.get("region"),
            "year": p.get("year_num"),
            "annotation_count": stats["annotation_count"],
            "missing_species": missing_spcode,
            "missing_condition": missing_con1,
            "unrecognized_species_count": unrecognized_total,
            "flags": flags,
        })

    # Projects with the most issues first, so reviewers see problems immediately.
    projects.sort(key=lambda pr: -len(pr["flags"]))

    logger.info(
        "QC: %d project(s), %d annotation(s) in %.0f ms",
        len(ids), len(rows), (datetime.now() - started).total_seconds() * 1000,
    )
    return {"project_ids": ids, "rollup": rollup, "projects": projects}


@router.get("/projects/{project_id}")
def get_project(project_id: int, current_user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    _ensure_oracle_mode()

    project = fetch_one(
        """
        SELECT p.*,
               owner.display_name AS owner_display_name, owner.username AS owner_username,
               mod.display_name AS last_mod_by_display_name, mod.username AS last_mod_by_username
        FROM cat_projects p
        LEFT JOIN cat_users owner ON owner.user_id = p.owner_user_id
        LEFT JOIN cat_users mod ON mod.user_id = p.last_mod_by_user_id
        WHERE p.project_id = :project_id
        """,
        {"project_id": project_id},
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    assets = fetch_all(
        "SELECT * FROM cat_project_assets WHERE project_id = :project_id ORDER BY created_at ASC",
        {"project_id": project_id},
    )
    # Caller's effective role (viewer/editor/owner) so the UI can go read-only.
    my_role = _get_effective_project_role(project_id, current_user) or "viewer"
    normalized = _normalize_project_row(project)
    normalized["my_role"] = my_role
    return {
        "success": True,
        "project": normalized,
        "assets": [_normalize_asset_row(a) for a in assets],
        "my_role": my_role,
    }


@router.get("/projects/{project_id}/snapshot")
def get_project_snapshot(
    project_id: int,
    include_annotations: bool = True,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """
    Return project structure. Pass include_annotations=false to skip the annotation
    payload and load them lazily via GET /annotations (4d).
    """
    _ensure_oracle_mode()

    project = fetch_one(
        """
        SELECT p.*,
               owner.display_name AS owner_display_name, owner.username AS owner_username,
               mod.display_name AS last_mod_by_display_name, mod.username AS last_mod_by_username
        FROM cat_projects p
        LEFT JOIN cat_users owner ON owner.user_id = p.owner_user_id
        LEFT JOIN cat_users mod ON mod.user_id = p.last_mod_by_user_id
        WHERE p.project_id = :project_id
        """,
        {"project_id": project_id},
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    assets = fetch_all(
        "SELECT * FROM cat_project_assets WHERE project_id = :project_id ORDER BY created_at ASC",
        {"project_id": project_id},
    )
    layers = fetch_all(
        "SELECT * FROM cat_overlay_layers WHERE project_id = :project_id ORDER BY display_order ASC, created_at ASC",
        {"project_id": project_id},
    )
    normalized_layers = [_normalize_layer_row(r) for r in layers]

    # Optionally skip annotations for faster initial load (4d)
    if include_annotations:
        annotations = fetch_all(
            """
            SELECT a.*, creator.display_name AS creator_display_name, creator.username AS creator_username
            FROM cat_annotations a
            LEFT JOIN cat_users creator ON creator.user_id = a.created_by_user_id
            WHERE a.project_id = :project_id AND a.deleted_at IS NULL
            ORDER BY a.created_at ASC
            """,
            {"project_id": project_id},
        )
        normalized_annotations = [_normalize_annotation_row(r) for r in annotations]
    else:
        annotation_count_row = fetch_one(
            "SELECT COUNT(*) AS cnt FROM cat_annotations WHERE project_id = :project_id AND deleted_at IS NULL",
            {"project_id": project_id},
        )
        annotations = []
        normalized_annotations = []

    annotation_count = len(annotations) if include_annotations else (annotation_count_row or {}).get("cnt", 0)

    return {
        "success": True,
        "project": _normalize_project_row(project),
        "my_role": _get_effective_project_role(project_id, current_user) or "viewer",
        "assets": [_normalize_asset_row(a) for a in assets],
        "annotations": normalized_annotations,
        "overlay_layers": normalized_layers,
        "annotations_included": include_annotations,
        "counts": {
            "assets": len(assets),
            "annotations": annotation_count,
            "overlay_layers": len(normalized_layers),
        },
    }


@router.put("/projects/{project_id}")
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    existing = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_project_role(project_id, current_user, "editor")

    update_map = {
        "project_name": payload.project_name,
        "site": payload.site,
        "cruise": payload.cruise,
        "year_num": payload.year,
        "region": payload.region,
        "observer_name": payload.observer,
        "notes": payload.notes,
        "metadata_json": json.dumps(payload.metadata) if payload.metadata is not None else None,
    }

    fields = []
    params: Dict[str, Any] = {"project_id": project_id}
    for key, value in update_map.items():
        if value is not None:
            fields.append(f"{key} = :{key}")
            params[key] = value

    if not fields:
        project = fetch_one("SELECT * FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
        return {"success": True, "project": _normalize_project_row(project)}

    fields.append("updated_at = CURRENT_TIMESTAMP")
    fields.append("last_mod_by_user_id = :last_mod_by_user_id")
    params["last_mod_by_user_id"] = current_user["user_id"]
    sql = f"UPDATE cat_projects SET {', '.join(fields)} WHERE project_id = :project_id"
    try:
        execute(sql, params)
    except Exception as exc:
        message = str(exc)
        if "ORA-00001" in message:
            raise HTTPException(status_code=409, detail="You already have a project with this name")
        raise HTTPException(status_code=500, detail=message)

    project = fetch_one("SELECT * FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    updated_fields = [k for k in params if k not in ("project_id", "last_mod_by_user_id")]
    _log_activity(project_id, current_user["user_id"], "project_updated", {"fields": updated_fields})
    return {"success": True, "project": _normalize_project_row(project)}


@router.delete("/projects/{project_id}")
def delete_project(
    project_id: int,
    confirm_name: Optional[str] = None,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Permanently delete a project (annotations, overlays, sessions cascade).

    A project that still has annotations is only deleted when `confirm_name`
    matches its name exactly — a one-click OK used to wipe a whole project.
    The deleted annotations stay recoverable by an admin from
    cat_annotation_history (op HARD_DELETE; no FKs, so it survives)."""
    _ensure_oracle_mode()

    existing = fetch_one(
        "SELECT project_id, project_name FROM cat_projects WHERE project_id = :project_id",
        {"project_id": project_id},
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_project_role(project_id, current_user, "owner")

    counts = fetch_one(
        "SELECT COUNT(*) AS n FROM cat_annotations WHERE project_id = :project_id AND deleted_at IS NULL",
        {"project_id": project_id},
    )
    live = int((counts or {}).get("n") or 0)
    if live and (confirm_name or "").strip() != (existing.get("project_name") or "").strip():
        raise HTTPException(
            status_code=400,
            detail=f"This project has {live} annotation(s). Type the project name exactly to confirm deletion.",
        )

    logger.warning(
        "Project %s (%r) deleted by user %s with %s live annotation(s)",
        project_id, existing.get("project_name"), current_user.get("user_id"), live,
    )
    execute("DELETE FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    return {"success": True, "deleted_project_id": project_id, "deleted_annotation_count": live}


class ProjectDuplicate(BaseModel):
    new_name: Optional[str] = Field(default=None, max_length=255)


def _pick_copy_name(source_name: str, owner_user_id: int) -> str:
    """First free '<name> (copy)', '<name> (copy 2)', ... for this owner
    (uniqueness is (project_name, owner_user_id)), truncated to fit 255."""
    rows = fetch_all(
        "SELECT project_name FROM cat_projects WHERE owner_user_id = :owner_id AND project_name LIKE :prefix",
        {"owner_id": owner_user_id, "prefix": f"{source_name[:200]}%"},
    )
    taken = {r["project_name"] for r in rows}
    for n in range(1, 1000):
        suffix = " (copy)" if n == 1 else f" (copy {n})"
        candidate = source_name[: 255 - len(suffix)] + suffix
        if candidate not in taken:
            return candidate
    raise HTTPException(status_code=409, detail="Could not find a free name for the copy")


@router.post("/projects/{project_id}/duplicate")
def duplicate_project(
    project_id: int,
    payload: ProjectDuplicate,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Copy a project (assets, annotations, overlay layers + features) into a
    new project owned by the caller. Any user who can view the source may
    duplicate it. Collaborators, activity log and sessions are not copied.
    Runs in a single transaction: either the whole copy exists or nothing."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "viewer")

    source = fetch_one("SELECT * FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not source:
        raise HTTPException(status_code=404, detail="Project not found")

    user_id = current_user["user_id"]
    requested = (payload.new_name or "").strip()
    new_name = requested or _pick_copy_name(source["project_name"], user_id)

    try:
        with get_connection() as conn:
            try:
                with conn.cursor() as cursor:
                    out_project = cursor.var(int)
                    cursor.execute(
                        """
                        INSERT INTO cat_projects (
                            project_name, site, cruise, year_num, region, observer_name, notes,
                            metadata_json, owner_user_id, last_mod_by_user_id
                        ) VALUES (
                            :project_name, :site, :cruise, :year_num, :region, :observer_name, :notes,
                            :metadata_json, :owner_user_id, :owner_user_id
                        ) RETURNING project_id INTO :new_project_id
                        """,
                        {
                            "project_name": new_name,
                            "site": source.get("site"),
                            "cruise": source.get("cruise"),
                            "year_num": source.get("year_num"),
                            "region": source.get("region"),
                            "observer_name": source.get("observer_name"),
                            "notes": source.get("notes"),
                            "metadata_json": source.get("metadata_json"),
                            "owner_user_id": user_id,
                            "new_project_id": out_project,
                        },
                    )
                    new_project_id = int(out_project.getvalue()[0])

                    # Assets: copy the URI rows (no imagery is duplicated) and map old -> new id.
                    cursor.execute(
                        "SELECT asset_id FROM cat_project_assets WHERE project_id = :pid ORDER BY asset_id",
                        {"pid": project_id},
                    )
                    old_asset_ids = [r[0] for r in cursor.fetchall()]
                    asset_map: Dict[int, int] = {}
                    for old_id in old_asset_ids:
                        cursor.execute(
                            """
                            INSERT INTO cat_project_assets (
                                project_id, asset_type, asset_name, cog_url, source_uri,
                                source_epsg, target_epsg, bounds_json, is_active
                            )
                            SELECT :new_pid, asset_type, asset_name, cog_url, source_uri,
                                   source_epsg, target_epsg, bounds_json, is_active
                            FROM cat_project_assets WHERE asset_id = :old_id
                            """,
                            {"new_pid": new_project_id, "old_id": old_id},
                        )
                        cursor.execute(
                            "SELECT MAX(asset_id) FROM cat_project_assets WHERE project_id = :new_pid",
                            {"new_pid": new_project_id},
                        )
                        asset_map[old_id] = int(cursor.fetchone()[0])

                    # Annotations (live only), asset ids remapped; original authorship preserved.
                    ann_cols = "feature_geojson, properties_json, created_by, created_by_user_id"
                    for old_id, new_id in asset_map.items():
                        cursor.execute(
                            f"""
                            INSERT INTO cat_annotations (project_id, asset_id, {ann_cols}, last_mod_by_user_id)
                            SELECT :new_pid, :new_asset, {ann_cols}, :owner_id
                            FROM cat_annotations
                            WHERE project_id = :pid AND deleted_at IS NULL AND asset_id = :old_id
                            """,
                            {"new_pid": new_project_id, "new_asset": new_id, "owner_id": user_id, "pid": project_id, "old_id": old_id},
                        )
                    cursor.execute(
                        f"""
                        INSERT INTO cat_annotations (project_id, asset_id, {ann_cols}, last_mod_by_user_id)
                        SELECT :new_pid, NULL, {ann_cols}, :owner_id
                        FROM cat_annotations
                        WHERE project_id = :pid AND deleted_at IS NULL
                          AND (asset_id IS NULL OR asset_id NOT IN (SELECT asset_id FROM cat_project_assets WHERE project_id = :pid))
                        """,
                        {"new_pid": new_project_id, "owner_id": user_id, "pid": project_id},
                    )

                    # Overlay layers (style, order, visibility, type, lock flag) + their features.
                    cursor.execute(
                        "SELECT layer_id FROM cat_overlay_layers WHERE project_id = :pid ORDER BY display_order, layer_id",
                        {"pid": project_id},
                    )
                    old_layer_ids = [r[0] for r in cursor.fetchall()]
                    for old_layer in old_layer_ids:
                        cursor.execute(
                            """
                            INSERT INTO cat_overlay_layers (
                                project_id, layer_name, source_uri, source_epsg, target_epsg,
                                style_json, is_active, display_order, layer_type, is_locked
                            )
                            SELECT :new_pid, layer_name, source_uri, source_epsg, target_epsg,
                                   style_json, is_active, display_order, layer_type, is_locked
                            FROM cat_overlay_layers WHERE layer_id = :old_layer
                            """,
                            {"new_pid": new_project_id, "old_layer": old_layer},
                        )
                        cursor.execute(
                            "SELECT MAX(layer_id) FROM cat_overlay_layers WHERE project_id = :new_pid",
                            {"new_pid": new_project_id},
                        )
                        new_layer = int(cursor.fetchone()[0])
                        # Features come back locked (column default) with no stale lock owner.
                        cursor.execute(
                            """
                            INSERT INTO cat_overlay_features (layer_id, feature_geojson, properties_json)
                            SELECT :new_layer, feature_geojson, properties_json
                            FROM cat_overlay_features WHERE layer_id = :old_layer ORDER BY feature_id
                            """,
                            {"new_layer": new_layer, "old_layer": old_layer},
                        )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    except HTTPException:
        raise
    except Exception as exc:
        if "ORA-00001" in str(exc):
            raise HTTPException(status_code=409, detail="You already have a project with this name")
        logger.exception("duplicate_project failed for %s", project_id)
        raise HTTPException(status_code=500, detail=str(exc))

    _log_activity(new_project_id, user_id, "project_duplicated", {"source_project_id": project_id})
    project = fetch_one("SELECT * FROM cat_projects WHERE project_id = :project_id", {"project_id": new_project_id})
    return {"success": True, "project": _normalize_project_row(project)}


# ---------------------------------------------------------------------------
# Per-project collaborators (owner/editor/viewer ACL) + activity log
# ---------------------------------------------------------------------------

def _normalize_collaborator_row(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "user_id": row["user_id"],
        "username": row.get("username"),
        "display_name": row.get("display_name"),
        "role": row["role"],
        "added_at": row.get("created_at"),
    }


@router.get("/projects/{project_id}/collaborators")
def list_collaborators(
    project_id: int,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "viewer")

    owner = fetch_one(
        """
        SELECT u.user_id, u.username, u.display_name
        FROM cat_projects p JOIN cat_users u ON u.user_id = p.owner_user_id
        WHERE p.project_id = :project_id
        """,
        {"project_id": project_id},
    )
    collaborators = fetch_all(
        """
        SELECT c.user_id, c.role, c.created_at, u.username, u.display_name
        FROM cat_project_collaborators c
        JOIN cat_users u ON u.user_id = c.user_id
        WHERE c.project_id = :project_id
        ORDER BY c.created_at ASC
        """,
        {"project_id": project_id},
    )
    result = []
    if owner:
        result.append({**_normalize_collaborator_row({**owner, "role": "owner"})})
    result.extend(_normalize_collaborator_row(r) for r in collaborators)
    return {"success": True, "collaborators": result}


@router.post("/projects/{project_id}/collaborators")
def add_collaborator(
    project_id: int,
    payload: CollaboratorAdd,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "owner")

    if payload.role not in ("editor", "viewer"):
        raise HTTPException(status_code=400, detail="role must be 'editor' or 'viewer'")

    target_user = auth_db.get_user_by_username(payload.username)
    if not target_user:
        raise HTTPException(status_code=404, detail=f"No user found with username '{payload.username}'")

    project = fetch_one("SELECT owner_user_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if project and project.get("owner_user_id") == target_user["user_id"]:
        raise HTTPException(status_code=400, detail="This user already owns the project")

    try:
        execute(
            """
            INSERT INTO cat_project_collaborators (project_id, user_id, role, added_by_user_id)
            VALUES (:project_id, :user_id, :role, :added_by_user_id)
            """,
            {
                "project_id": project_id,
                "user_id": target_user["user_id"],
                "role": payload.role,
                "added_by_user_id": current_user["user_id"],
            },
        )
    except Exception as exc:
        message = str(exc)
        if "ORA-00001" in message:
            raise HTTPException(status_code=409, detail="This user is already a collaborator on this project")
        raise HTTPException(status_code=500, detail=message)

    _log_activity(project_id, current_user["user_id"], "collaborator_added",
                  {"user_id": target_user["user_id"], "username": target_user["username"], "role": payload.role})
    return {"success": True}


@router.put("/projects/{project_id}/collaborators/{user_id}")
def update_collaborator_role(
    project_id: int,
    user_id: int,
    payload: CollaboratorRoleUpdate,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "owner")

    if payload.role not in ("editor", "viewer"):
        raise HTTPException(status_code=400, detail="role must be 'editor' or 'viewer'")

    existing = fetch_one(
        "SELECT collaborator_id FROM cat_project_collaborators WHERE project_id = :project_id AND user_id = :user_id",
        {"project_id": project_id, "user_id": user_id},
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Collaborator not found")

    execute(
        "UPDATE cat_project_collaborators SET role = :role WHERE project_id = :project_id AND user_id = :user_id",
        {"project_id": project_id, "user_id": user_id, "role": payload.role},
    )
    _log_activity(project_id, current_user["user_id"], "collaborator_role_changed", {"user_id": user_id, "role": payload.role})
    return {"success": True}


@router.delete("/projects/{project_id}/collaborators/{user_id}")
def remove_collaborator(
    project_id: int,
    user_id: int,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "owner")

    execute(
        "DELETE FROM cat_project_collaborators WHERE project_id = :project_id AND user_id = :user_id",
        {"project_id": project_id, "user_id": user_id},
    )
    _log_activity(project_id, current_user["user_id"], "collaborator_removed", {"user_id": user_id})
    return {"success": True}


@router.get("/projects/{project_id}/activity")
def list_project_activity(
    project_id: int,
    limit: int = 100,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "viewer")

    rows = fetch_all(
        """
        SELECT l.log_id, l.action, l.details_json, l.created_at, u.username, u.display_name
        FROM cat_project_activity_log l
        LEFT JOIN cat_users u ON u.user_id = l.user_id
        WHERE l.project_id = :project_id
        ORDER BY l.created_at DESC
        FETCH FIRST :limit ROWS ONLY
        """,
        {"project_id": project_id, "limit": max(1, min(limit, 500))},
    )
    activity = [
        {
            "log_id": r["log_id"],
            "action": r["action"],
            "details": _parse_json_field(r.get("details_json"), default={}),
            "created_at": r.get("created_at"),
            "username": r.get("username"),
            "display_name": r.get("display_name"),
        }
        for r in rows
    ]
    return {"success": True, "activity": activity}


@router.get("/projects/{project_id}/assets")
def list_project_assets(
    project_id: int,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """A project's imagery/elevation assets on their own.

    /snapshot already returns these, but it also returns every annotation in
    the project — fine when opening the annotator, absurd for a details
    panel that only wants to know which COGs exist and where their tiles
    live. Separate endpoint so the panel costs one small query.
    """
    _ensure_oracle_mode()

    project = fetch_one(
        "SELECT project_id FROM cat_projects WHERE project_id = :project_id",
        {"project_id": project_id},
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    rows = fetch_all(
        "SELECT * FROM cat_project_assets WHERE project_id = :project_id "
        "ORDER BY created_at ASC",
        {"project_id": project_id},
    )
    return {
        "success": True,
        "count": len(rows),
        "assets": [_normalize_asset_row(r) for r in rows],
    }


@router.post("/projects/{project_id}/assets")
def add_project_asset(
    project_id: int,
    payload: AssetCreate,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    sql = """
        INSERT INTO cat_project_assets (
            project_id, asset_type, asset_name, cog_url,
            source_uri, source_epsg, target_epsg, bounds_json
        ) VALUES (
            :project_id, :asset_type, :asset_name, :cog_url,
            :source_uri, :source_epsg, :target_epsg, :bounds_json
        ) RETURNING asset_id INTO :asset_id
    """

    asset_id = execute_returning_id(
        sql,
        {
            "project_id": project_id,
            "asset_type": payload.asset_type.upper(),
            "asset_name": payload.asset_name,
            "cog_url": payload.cog_url,
            "source_uri": payload.source_uri,
            "source_epsg": payload.source_epsg,
            "target_epsg": payload.target_epsg,
            "bounds_json": json.dumps(payload.bounds) if payload.bounds else None,
        },
        id_column="asset_id",
    )

    asset = fetch_one("SELECT * FROM cat_project_assets WHERE asset_id = :asset_id", {"asset_id": asset_id})
    return {"success": True, "asset": _normalize_asset_row(asset)}


def _existing_by_client_uuid(project_id: int, client_uuid: Optional[str]) -> Optional[Dict[str, Any]]:
    """Row already created for this client_uuid, if any (retry-safe creates).

    Raises 410 if that annotation has since been deleted — a late retry of
    its create must not bring it back — and 409 if the UUID belongs to a
    different project (a client bug; never silently cross projects).
    """
    if not client_uuid:
        return None
    row = fetch_one(
        "SELECT * FROM cat_annotations WHERE client_uuid = :client_uuid",
        {"client_uuid": client_uuid},
    )
    if not row:
        return None
    if int(row.get("project_id")) != int(project_id):
        raise HTTPException(status_code=409, detail="client_uuid already used in another project")
    if row.get("deleted_at") is not None:
        raise HTTPException(
            status_code=410,
            detail={"message": "Annotation was deleted", "annotation_id": row.get("annotation_id")},
        )
    return row


def _is_unique_violation(exc: Exception) -> bool:
    return "ORA-00001" in str(exc)


@router.post("/projects/{project_id}/annotations")
def create_annotation(
    project_id: int,
    payload: AnnotationCreate,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_project_role(project_id, current_user, "editor")

    # Retry of a create that already went through: hand back that row.
    existing = _existing_by_client_uuid(project_id, payload.client_uuid)
    if existing:
        return {"success": True, "annotation": _normalize_annotation_row(existing), "duplicate": True}

    created_by = payload.created_by or current_user.get("display_name")

    sql = """
        INSERT INTO cat_annotations (
            project_id, asset_id, feature_geojson, properties_json, created_by, created_by_user_id, client_uuid
        ) VALUES (
            :project_id, :asset_id, :feature_geojson, :properties_json, :created_by, :created_by_user_id, :client_uuid
        ) RETURNING annotation_id INTO :annotation_id
    """

    try:
        annotation_id = execute_returning_id(
            sql,
            {
                "project_id": project_id,
                "asset_id": payload.asset_id,
                "feature_geojson": json.dumps(payload.feature),
                "properties_json": json.dumps(payload.properties),
                "created_by": created_by,
                "created_by_user_id": current_user["user_id"],
                "client_uuid": payload.client_uuid,
            },
            id_column="annotation_id",
        )
    except Exception as exc:
        # Two identical POSTs raced; the other one inserted first.
        if payload.client_uuid and _is_unique_violation(exc):
            existing = _existing_by_client_uuid(project_id, payload.client_uuid)
            if existing:
                return {"success": True, "annotation": _normalize_annotation_row(existing), "duplicate": True}
        raise

    row = fetch_one(
        "SELECT * FROM cat_annotations WHERE annotation_id = :annotation_id",
        {"annotation_id": annotation_id},
    )
    _log_activity(project_id, current_user["user_id"], "annotation_created", {"annotation_id": annotation_id})
    return {"success": True, "annotation": _normalize_annotation_row(row)}


@router.get("/projects/{project_id}/annotations")
def list_annotations(
    project_id: int,
    limit: int = 500,
    offset: int = 0,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    sql = """
        SELECT a.*, creator.display_name AS creator_display_name, creator.username AS creator_username
        FROM cat_annotations a
        LEFT JOIN cat_users creator ON creator.user_id = a.created_by_user_id
        WHERE a.project_id = :project_id AND a.deleted_at IS NULL
        ORDER BY a.created_at ASC
        OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY
    """
    rows = fetch_all(
        sql,
        {
            "project_id": project_id,
            "offset": max(0, offset),
            "limit": max(1, min(limit, 5000)),
        },
    )
    normalized = [_normalize_annotation_row(r) for r in rows]
    return {"success": True, "count": len(normalized), "annotations": normalized}


@router.put("/projects/{project_id}/annotations/{annotation_id}")
def update_annotation(
    project_id: int,
    annotation_id: int,
    payload: AnnotationUpdate,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    existing = fetch_one(
        """
        SELECT annotation_id, version, deleted_at, properties_json
        FROM cat_annotations
        WHERE project_id = :project_id AND annotation_id = :annotation_id
        """,
        {"project_id": project_id, "annotation_id": annotation_id},
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Annotation not found")
    _require_project_role(project_id, current_user, "editor")

    # A soft-deleted row answers 410, not 404. The client used to treat 404
    # as "never existed", drop the id and re-POST the annotation as new —
    # which resurrected annotations another user (or tab) had deleted.
    if existing.get("deleted_at") is not None:
        raise HTTPException(
            status_code=410,
            detail={"message": "Annotation was deleted", "annotation_id": annotation_id},
        )

    # Never let a PUT blank out every property of an annotation that has
    # some. An unreadable properties CLOB used to reach the client as {},
    # and the next autosave wrote that {} straight back over the real data.
    stored = existing.get("properties_json")
    if payload.properties is not None and stored not in (None, "", "{}"):
        # Stored properties that don't parse reached the client as {} — any
        # PUT built from that would replace the real (if damaged) record with
        # a near-empty one. Refuse and leave the stored text for an admin.
        try:
            json.loads(stored) if isinstance(stored, str) else None
        except (TypeError, ValueError):
            logger.error("Annotation %s in project %s has unreadable properties_json; refusing overwrite", annotation_id, project_id)
            raise HTTPException(
                status_code=422,
                detail="This annotation's stored data could not be read; it was not overwritten. Ask an admin to repair it.",
            )
    if payload.properties is not None and len(payload.properties) == 0:
        if stored not in (None, "", "{}"):
            raise HTTPException(
                status_code=422,
                detail="Refusing to replace this annotation's properties with an empty set",
            )

    fields = []
    params: Dict[str, Any] = {"project_id": project_id, "annotation_id": annotation_id}

    if payload.feature is not None:
        fields.append("feature_geojson = :feature_geojson")
        params["feature_geojson"] = json.dumps(payload.feature)
    if payload.properties is not None:
        fields.append("properties_json = :properties_json")
        params["properties_json"] = json.dumps(payload.properties)
    if payload.created_by is not None:
        fields.append("created_by = :created_by")
        params["created_by"] = payload.created_by

    if fields:
        fields.append("updated_at = CURRENT_TIMESTAMP")
        fields.append("last_mod_by_user_id = :last_mod_by_user_id")
        params["last_mod_by_user_id"] = current_user["user_id"]
        fields.append("version = NVL(version, 1) + 1")  # increment version (4a)

        # Optimistic locking (4a) as one compare-and-set UPDATE. The old
        # SELECT-then-UPDATE let two writers holding the same version both
        # pass the check and both write.
        where = "project_id = :project_id AND annotation_id = :annotation_id AND deleted_at IS NULL"
        if payload.version is not None:
            where += " AND NVL(version, 1) = :expected_version"
            params["expected_version"] = payload.version

        updated = execute_rowcount(
            f"UPDATE cat_annotations SET {', '.join(fields)} WHERE {where}",
            params,
        )
        if updated == 0:
            current_row = fetch_one(
                "SELECT * FROM cat_annotations WHERE project_id = :project_id AND annotation_id = :annotation_id",
                {"project_id": project_id, "annotation_id": annotation_id},
            )
            if not current_row:
                raise HTTPException(status_code=404, detail="Annotation not found")
            if current_row.get("deleted_at") is not None:
                raise HTTPException(
                    status_code=410,
                    detail={"message": "Annotation was deleted", "annotation_id": annotation_id},
                )
            # HTTPException.detail skips FastAPI's encoder, so datetimes in
            # current_annotation must be made JSON-safe here (Task 7 round 2).
            raise HTTPException(
                status_code=409,
                detail=jsonable_encoder({
                    "message": "Version conflict — annotation was modified by another session",
                    "current_version": current_row.get("version") or 1,
                    "client_version": payload.version,
                    "current_annotation": _normalize_annotation_row(current_row),
                }),
            )
        _log_activity(project_id, current_user["user_id"], "annotation_updated", {"annotation_id": annotation_id})

    row = fetch_one(
        "SELECT * FROM cat_annotations WHERE project_id = :project_id AND annotation_id = :annotation_id",
        {"project_id": project_id, "annotation_id": annotation_id},
    )
    return {"success": True, "annotation": _normalize_annotation_row(row)}


@router.delete("/projects/{project_id}/annotations/{annotation_id}")
def delete_annotation(
    project_id: int,
    annotation_id: int,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Soft-delete: marks deleted_at, does NOT remove the row (4b)."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "editor")

    existing = fetch_one(
        """
        SELECT annotation_id
        FROM cat_annotations
        WHERE project_id = :project_id AND annotation_id = :annotation_id AND deleted_at IS NULL
        """,
        {"project_id": project_id, "annotation_id": annotation_id},
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Annotation not found")

    # Bump version/updated_at too, so other open tabs see the delete as a
    # change instead of holding a "current" copy they later write back.
    execute(
        """
        UPDATE cat_annotations
        SET deleted_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            last_mod_by_user_id = :last_mod_by_user_id,
            version = NVL(version, 1) + 1
        WHERE project_id = :project_id AND annotation_id = :annotation_id
        """,
        {"project_id": project_id, "annotation_id": annotation_id, "last_mod_by_user_id": current_user["user_id"]},
    )
    _log_activity(project_id, current_user["user_id"], "annotation_deleted", {"annotation_id": annotation_id})
    return {"success": True, "deleted_annotation_id": annotation_id}


@router.post("/projects/{project_id}/annotations/{annotation_id}/restore")
def restore_annotation(
    project_id: int,
    annotation_id: int,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Restore a soft-deleted annotation (undo delete) (4b)."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "editor")

    existing = fetch_one(
        """
        SELECT annotation_id
        FROM cat_annotations
        WHERE project_id = :project_id AND annotation_id = :annotation_id AND deleted_at IS NOT NULL
        """,
        {"project_id": project_id, "annotation_id": annotation_id},
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Annotation not found or not deleted")

    # Bump version so open tabs holding the deleted copy see a change, and
    # record who restored it (the history trigger captures the before-state).
    execute(
        """
        UPDATE cat_annotations
        SET deleted_at = NULL,
            updated_at = CURRENT_TIMESTAMP,
            last_mod_by_user_id = :last_mod_by_user_id,
            version = NVL(version, 1) + 1
        WHERE project_id = :project_id AND annotation_id = :annotation_id
        """,
        {"project_id": project_id, "annotation_id": annotation_id, "last_mod_by_user_id": current_user["user_id"]},
    )
    _log_activity(project_id, current_user["user_id"], "annotation_restored", {"annotation_id": annotation_id})
    row = fetch_one(
        "SELECT * FROM cat_annotations WHERE annotation_id = :annotation_id",
        {"annotation_id": annotation_id},
    )
    return {"success": True, "annotation": _normalize_annotation_row(row)}


def _normalize_history_row(row: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(row)
    feature = _parse_json_field(normalized.pop("feature_geojson", None), default=None)
    normalized["feature"] = feature
    normalized["geometry"] = feature.get("geometry") if isinstance(feature, dict) and feature.get("type") == "Feature" else feature
    normalized["properties"] = _parse_json_field(normalized.pop("properties_json", None), default={})
    return normalized


@router.get("/projects/{project_id}/annotations/versions")
def annotation_versions(
    project_id: int,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """id + version of every live annotation — what the page's change poll
    needs, without shipping every geometry every minute. Uncapped, so the
    poll also sees deletions (ids that disappeared) on any project size."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "viewer")
    rows = fetch_all(
        """
        SELECT annotation_id, NVL(version, 1) AS version, last_mod_by_user_id
        FROM cat_annotations
        WHERE project_id = :project_id AND deleted_at IS NULL
        """,
        {"project_id": project_id},
    )
    return {
        "success": True,
        "count": len(rows),
        "annotations": [
            {"annotation_id": r["annotation_id"], "version": r["version"], "last_mod_by_user_id": r.get("last_mod_by_user_id")}
            for r in rows
        ],
    }


@router.get("/projects/{project_id}/annotations/history")
def list_project_annotation_history(
    project_id: int,
    op: Optional[str] = None,
    limit: int = 200,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Recent changes to a project's annotations, newest first — the place to
    find something that was deleted or overwritten. `op` filters by
    UPDATE / DELETE / RESTORE / HARD_DELETE. Each entry is the annotation as
    it was just BEFORE that change."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "viewer")

    params: Dict[str, Any] = {"project_id": project_id, "limit": max(1, min(int(limit), 2000))}
    op_sql = ""
    if op:
        op_sql = "AND h.op = :op"
        params["op"] = op.upper()
    rows = fetch_all(
        f"""
        SELECT h.*, u.display_name AS changed_by_display_name, u.username AS changed_by_username,
               CASE WHEN a.annotation_id IS NULL THEN 'missing'
                    WHEN a.deleted_at IS NOT NULL THEN 'deleted'
                    ELSE 'live' END AS current_state
        FROM cat_annotation_history h
        LEFT JOIN cat_users u ON u.user_id = h.changed_by_user_id
        LEFT JOIN cat_annotations a ON a.annotation_id = h.annotation_id
        WHERE h.project_id = :project_id {op_sql}
        ORDER BY h.changed_at DESC, h.history_id DESC
        FETCH FIRST :limit ROWS ONLY
        """,
        params,
    )
    entries = [_normalize_history_row(r) for r in rows]

    # Annotations soft-deleted before the history table existed (i.e. under
    # an older version) have no DELETE entry, but the row is still there and
    # restorable. List them too so they can be found and brought back.
    if not op or op.upper() == "DELETE":
        legacy = fetch_all(
            """
            SELECT a.annotation_id, a.project_id, NVL(a.version, 1) AS version, a.deleted_at,
                   a.feature_geojson, a.properties_json, a.created_by, a.created_by_user_id,
                   a.client_uuid, a.last_mod_by_user_id AS changed_by_user_id,
                   a.deleted_at AS changed_at,
                   u.display_name AS changed_by_display_name, u.username AS changed_by_username
            FROM cat_annotations a
            LEFT JOIN cat_users u ON u.user_id = a.last_mod_by_user_id
            WHERE a.project_id = :project_id AND a.deleted_at IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM cat_annotation_history h
                  WHERE h.annotation_id = a.annotation_id AND h.op = 'DELETE'
              )
            ORDER BY a.deleted_at DESC
            FETCH FIRST :limit ROWS ONLY
            """,
            {"project_id": project_id, "limit": params["limit"]},
        )
        for r in legacy:
            e = _normalize_history_row(r)
            e.update({"history_id": None, "op": "DELETE", "current_state": "deleted", "legacy": True})
            entries.append(e)
        entries.sort(key=lambda e: str(e.get("changed_at") or ""), reverse=True)
        entries = entries[: params["limit"]]

    return {"success": True, "count": len(entries), "history": entries}


@router.get("/projects/{project_id}/annotations/{annotation_id}/history")
def get_annotation_history(
    project_id: int,
    annotation_id: int,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Every earlier state of one annotation, newest first."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "viewer")
    rows = fetch_all(
        """
        SELECT h.*, u.display_name AS changed_by_display_name, u.username AS changed_by_username
        FROM cat_annotation_history h
        LEFT JOIN cat_users u ON u.user_id = h.changed_by_user_id
        WHERE h.project_id = :project_id AND h.annotation_id = :annotation_id
        ORDER BY h.changed_at DESC, h.history_id DESC
        """,
        {"project_id": project_id, "annotation_id": annotation_id},
    )
    entries = [_normalize_history_row(r) for r in rows]
    return {"success": True, "count": len(entries), "history": entries}


@router.post("/projects/{project_id}/annotations/{annotation_id}/history/{history_id}/restore")
def restore_annotation_version(
    project_id: int,
    annotation_id: int,
    history_id: int,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Put an annotation back to a saved earlier state (and undelete it).

    Goes through a normal versioned UPDATE, so the state being replaced is
    itself captured in history and the restore can be undone the same way.
    If the row is gone entirely (hard-deleted by the old bulk-replace), the
    content is re-created as a new annotation.
    """
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "editor")

    snap = fetch_one(
        """
        SELECT * FROM cat_annotation_history
        WHERE history_id = :history_id AND project_id = :project_id AND annotation_id = :annotation_id
        """,
        {"history_id": history_id, "project_id": project_id, "annotation_id": annotation_id},
    )
    if not snap:
        raise HTTPException(status_code=404, detail="History entry not found")

    current = fetch_one(
        "SELECT annotation_id FROM cat_annotations WHERE project_id = :project_id AND annotation_id = :annotation_id",
        {"project_id": project_id, "annotation_id": annotation_id},
    )
    if current:
        execute(
            """
            UPDATE cat_annotations
            SET feature_geojson = :feature_geojson,
                properties_json = :properties_json,
                deleted_at = NULL,
                updated_at = CURRENT_TIMESTAMP,
                last_mod_by_user_id = :last_mod_by_user_id,
                version = NVL(version, 1) + 1
            WHERE project_id = :project_id AND annotation_id = :annotation_id
            """,
            {
                "feature_geojson": snap.get("feature_geojson"),
                "properties_json": snap.get("properties_json"),
                "last_mod_by_user_id": current_user["user_id"],
                "project_id": project_id,
                "annotation_id": annotation_id,
            },
        )
        restored_id = annotation_id
    else:
        restored_id = execute_returning_id(
            """
            INSERT INTO cat_annotations (
                project_id, feature_geojson, properties_json, created_by, created_by_user_id, last_mod_by_user_id
            ) VALUES (
                :project_id, :feature_geojson, :properties_json, :created_by, :created_by_user_id, :last_mod_by_user_id
            ) RETURNING annotation_id INTO :annotation_id
            """,
            {
                "project_id": project_id,
                "feature_geojson": snap.get("feature_geojson"),
                "properties_json": snap.get("properties_json"),
                "created_by": snap.get("created_by"),
                "created_by_user_id": snap.get("created_by_user_id"),
                "last_mod_by_user_id": current_user["user_id"],
            },
            id_column="annotation_id",
        )

    _log_activity(
        project_id,
        current_user["user_id"],
        "annotation_version_restored",
        {"annotation_id": restored_id, "from_history_id": history_id, "original_annotation_id": annotation_id},
    )
    row = fetch_one("SELECT * FROM cat_annotations WHERE annotation_id = :annotation_id", {"annotation_id": restored_id})
    return {"success": True, "annotation": _normalize_annotation_row(row), "recreated": restored_id != annotation_id}


@router.post("/projects/{project_id}/annotations/bulk-replace")
def bulk_replace_annotations(
    project_id: int,
    payload: AnnotationBulkReplace,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Removed. This hard-DELETEd every annotation in the project (every
    user's, plus soft-deleted history) and re-inserted only the caller's
    copy — the tab-close save beacon and "Clear all" both went through it and
    it was the main cause of lost and resurrected annotations. Kept as a 410
    so tabs still running the old page JS get a refusal, not a wipe."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "editor")
    _log_activity(project_id, current_user["user_id"], "annotations_bulk_replace_refused", {"count": len(payload.annotations)})
    raise HTTPException(
        status_code=410,
        detail="bulk-replace has been removed; annotations are saved individually. Reload the page.",
    )


@router.post("/projects/{project_id}/annotations/bulk-create")
def bulk_create_annotations(
    project_id: int,
    payload: AnnotationBulkCreate,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Additive bulk insert: appends the given annotations without touching
    any existing rows for the project (unlike bulk-replace, there is no
    DELETE here). Intended for batch-inserting AI-detected annotations
    (e.g. SAM3) on top of pre-existing hand-drawn ones."""
    _ensure_oracle_mode()

    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_project_role(project_id, current_user, "editor")

    insert_sql = """
        INSERT INTO cat_annotations (
            project_id, asset_id, feature_geojson, properties_json, created_by, created_by_user_id, client_uuid
        ) VALUES (
            :project_id, :asset_id, :feature_geojson, :properties_json, :created_by, :created_by_user_id, :client_uuid
        ) RETURNING annotation_id INTO :annotation_id
    """

    # Each insert uses its own execute_returning_id() call (own connection +
    # commit): the endpoint is purely additive, so a partial failure
    # mid-batch leaves nothing destroyed — and with client_uuids the client
    # can simply re-send the whole batch: items that already made it are
    # recognised and returned, not inserted twice.
    inserted_ids: List[int] = []
    for ann in payload.annotations:
        try:
            existing = _existing_by_client_uuid(project_id, ann.client_uuid)
        except HTTPException as exc:
            if exc.status_code == 410:
                continue  # deleted since the first attempt — leave it deleted
            raise
        if existing:
            inserted_ids.append(existing["annotation_id"])
            continue
        annotation_id = execute_returning_id(
            insert_sql,
            {
                "project_id": project_id,
                "asset_id": ann.asset_id,
                "feature_geojson": json.dumps(ann.feature),
                "properties_json": json.dumps(ann.properties),
                "created_by": ann.created_by or current_user.get("display_name"),
                "created_by_user_id": current_user["user_id"],
                "client_uuid": ann.client_uuid,
            },
            id_column="annotation_id",
        )
        inserted_ids.append(annotation_id)

    if not inserted_ids:
        return {"success": True, "count": 0, "annotations": []}

    # Oracle rejects an IN (...) list with more than 1000 expressions
    # (ORA-01795), so read back in chunks rather than one unbounded clause.
    # The inserts above already committed independently, so a chunk failure
    # here would still leave prior chunks (and all inserts) intact.
    CHUNK_SIZE = 500
    rows_by_id: Dict[int, Any] = {}
    for i in range(0, len(inserted_ids), CHUNK_SIZE):
        chunk = inserted_ids[i:i + CHUNK_SIZE]
        id_params = {f"id_{j}": aid for j, aid in enumerate(chunk)}
        in_clause = ", ".join(f":{key}" for key in id_params)
        chunk_rows = fetch_all(
            f"SELECT * FROM cat_annotations WHERE annotation_id IN ({in_clause})",
            id_params,
        )
        for row in chunk_rows:
            rows_by_id[row["annotation_id"]] = row
    normalized = [
        _normalize_annotation_row(rows_by_id[aid])
        for aid in inserted_ids
        if aid in rows_by_id
    ]
    _log_activity(project_id, current_user["user_id"], "annotations_bulk_created", {"count": len(normalized)})
    return {"success": True, "count": len(normalized), "annotations": normalized}


@router.get("/projects/{project_id}/annotations/geojson")
def annotations_geojson(
    project_id: int,
    limit: Optional[int] = None,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    # `limit` is optional and defaults to "all", which is what the annotation
    # page needs — it is drawing the project, so a partial set would be a bug
    # there. The details drawer's preview map passes a cap instead, so opening
    # a panel on a 5,000-annotation project doesn't pull every geometry CLOB
    # just to sketch an outline.
    params: Dict[str, Any] = {"project_id": project_id}
    limit_sql = ""
    if limit is not None:
        params["limit"] = max(1, min(int(limit), 20000))
        limit_sql = "FETCH FIRST :limit ROWS ONLY"

    rows = fetch_all(
        f"""
        SELECT a.*, creator.display_name AS creator_display_name, creator.username AS creator_username
        FROM cat_annotations a
        LEFT JOIN cat_users creator ON creator.user_id = a.created_by_user_id
        WHERE a.project_id = :project_id AND a.deleted_at IS NULL
        ORDER BY a.created_at ASC
        {limit_sql}
        """,
        params,
    )

    features = []
    for row in rows:
        normalized = _normalize_annotation_row(row)
        features.append(
            {
                "type": "Feature",
                # The bare geometry, not normalized["feature"] (a whole
                # nested Feature) — see _normalize_annotation_row.
                "geometry": normalized.get("geometry"),
                "id": normalized.get("annotation_id"),
                # Server-owned fields go LAST so a stale copy stored inside
                # properties_json can't override the real id; version is
                # needed by the client's optimistic locking (without it every
                # refreshed annotation was assumed version 1 and the next PUT
                # 409'd).
                "properties": {
                    **(normalized.get("properties") or {}),
                    "annotation_id": normalized.get("annotation_id"),
                    "version": normalized.get("version") or 1,
                    "client_uuid": normalized.get("client_uuid"),
                    "created_by_user_id": normalized.get("created_by_user_id"),
                    "creator_display_name": normalized.get("creator_display_name") or normalized.get("creator_username"),
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "project_id": project_id,
        "feature_count": len(features),
        "features": features,
    }


# ---------------------------------------------------------------------------
# Per-project annotation report aggregation (C1)
# ---------------------------------------------------------------------------

def _ring_planar_area(ring: List[Any]) -> float:
    """Shoelace area of a single ring in the raw coordinate units (abs value)."""
    n = len(ring)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        s += (x1 * y2) - (x2 * y1)
    return abs(s) / 2.0


def _ring_geodesic_area(ring: List[Any]) -> float:
    """Spherical-earth geodesic area of a lng/lat ring, in m^2 (abs value).

    Uses the standard spherical-excess approximation (same formula as Google
    Maps' geometry library): treats coordinates as [lng, lat] degrees on a
    sphere of WGS84 equatorial radius. Good to well under 1% for reef-scale
    polygons; we only use it when the asset CRS is trustworthy lng/lat (4326).
    """
    import math
    n = len(ring)
    if n < 3:
        return 0.0
    radius = 6378137.0  # WGS84 equatorial radius (meters)
    area = 0.0
    for i in range(n):
        p1 = ring[i]
        p2 = ring[(i + 1) % n]
        area += math.radians(p2[0] - p1[0]) * (
            2 + math.sin(math.radians(p1[1])) + math.sin(math.radians(p2[1]))
        )
    return abs(area * radius * radius / 2.0)


def _poly_area_from_rings(rings: List[Any], ring_area) -> float:
    """Polygon area = outer ring minus holes (never negative)."""
    outer = ring_area(rings[0])
    holes = sum(ring_area(r) for r in rings[1:] if r and len(r) >= 3)
    return max(outer - holes, 0.0)


def _annotation_area(gtype: str, coords: Any, geographic: bool) -> Optional[float]:
    """Area for a Polygon/MultiPolygon, or None if coords are absent/malformed.

    Returns None (→ counted as missing) rather than raising on bad input.
    """
    ring_area = _ring_geodesic_area if geographic else _ring_planar_area
    try:
        if gtype == "Polygon":
            if not isinstance(coords, list) or not coords or not coords[0]:
                return None
            return _poly_area_from_rings(coords, ring_area)
        if gtype == "MultiPolygon":
            if not isinstance(coords, list) or not coords:
                return None
            total = 0.0
            any_valid = False
            for poly in coords:
                if not isinstance(poly, list) or not poly or not poly[0]:
                    continue
                total += _poly_area_from_rings(poly, ring_area)
                any_valid = True
            return total if any_valid else None
    except Exception:
        return None
    return None


def _haversine_distance_m(p1: Any, p2: Any) -> float:
    """Great-circle distance between two [lng, lat] degree points, in meters.

    Same WGS84 spherical-earth convention as _ring_geodesic_area (no pyproj
    dependency) -- adequate accuracy for reef-scale annotation measurements.
    """
    import math
    radius = 6378137.0  # WGS84 equatorial radius (meters)
    lon1, lat1 = math.radians(p1[0]), math.radians(p1[1])
    lon2, lat2 = math.radians(p2[0]), math.radians(p2[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(a)))


def _planar_distance(p1: Any, p2: Any) -> float:
    """Euclidean distance between two points in raw coordinate units."""
    return ((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2) ** 0.5


def _line_length(coords: List[Any], geographic: bool) -> float:
    """Sum of consecutive-vertex distances along a LineString's coordinates."""
    dist = _haversine_distance_m if geographic else _planar_distance
    total = 0.0
    for i in range(len(coords) - 1):
        total += dist(coords[i], coords[i + 1])
    return total


def _annotation_length(gtype: str, coords: Any, geographic: bool) -> Optional[float]:
    """Length for a LineString/MultiLineString, or None if coords are absent/malformed.

    Mirrors _annotation_area's contract: returns None (-> counted as missing)
    rather than raising on bad input.
    """
    try:
        if gtype == "LineString":
            if not isinstance(coords, list) or len(coords) < 2:
                return None
            return _line_length(coords, geographic)
        if gtype == "MultiLineString":
            if not isinstance(coords, list) or not coords:
                return None
            total = 0.0
            any_valid = False
            for line in coords:
                if not isinstance(line, list) or len(line) < 2:
                    continue
                total += _line_length(line, geographic)
                any_valid = True
            return total if any_valid else None
    except Exception:
        return None
    return None


def _polygon_max_diameter_line(geometry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Given a Polygon/MultiPolygon GeoJSON geometry, return a 2-point
    LineString geometry dict spanning its longest chord (the two points on
    its convex hull that are farthest apart), or None if the geometry is
    absent/malformed/degenerate.

    Used to derive a "max diameter" line annotation from a SAM3 polygon
    segment. Distances are measured with _haversine_distance_m -- these
    geometries are always EPSG:4326 lng/lat by the time they reach this
    layer (see cat/api/segmentation.py's LOCAL_CS-VRT resolution upstream).
    """
    try:
        from shapely.geometry import shape as shapely_shape

        geom = shapely_shape(geometry)
        if geom.is_empty:
            return None
        hull = geom.convex_hull
        hull_coords = list(hull.exterior.coords) if hull.geom_type == "Polygon" else list(hull.coords)
        if len(hull_coords) < 2:
            return None

        best_pair = None
        best_dist = -1.0
        for i in range(len(hull_coords)):
            for j in range(i + 1, len(hull_coords)):
                d = _haversine_distance_m(hull_coords[i], hull_coords[j])
                if d > best_dist:
                    best_dist = d
                    best_pair = (hull_coords[i], hull_coords[j])

        if best_pair is None or best_dist <= 0:
            return None

        return {
            "type": "LineString",
            "coordinates": [[best_pair[0][0], best_pair[0][1]], [best_pair[1][0], best_pair[1][1]]],
        }
    except Exception:
        return None


def _chunked_in(ids: List[Any], size: int = 500):
    """Yield (in_clause, binds) pairs for id lists of any length. Oracle rejects
    an IN list longer than 1000 expressions (ORA-01795)."""
    ids = list(ids)
    for i in range(0, len(ids), size):
        chunk = ids[i:i + size]
        binds = {f"pid{j}": pid for j, pid in enumerate(chunk)}
        yield ", ".join(f":{k}" for k in binds), binds


def _load_species_lookup() -> Dict[str, Dict[str, Any]]:
    # {spcode: {"name": taxon_name, "genus": genus}}. The table may be empty;
    # unknown/absent spcodes fall back to the code as the name.
    lookup: Dict[str, Dict[str, Any]] = {}
    try:
        for s in fetch_all("SELECT spcode, taxon_name, genus FROM cat_coral_species"):
            code = s.get("spcode")
            if code:
                lookup[code] = {"name": s.get("taxon_name"), "genus": s.get("genus")}
    except Exception:
        lookup = {}
    return lookup


def _load_aggregate_inputs(project_ids: List[int]):
    """One pass over the database for any number of projects: every live
    annotation (with its project_id), the species lookup, and each project's
    active-asset EPSGs. Callers group in memory — the QC page used to run all
    of this once for the rollup and then again for every single project."""
    rows: List[Dict[str, Any]] = []
    epsgs_by_project: Dict[int, List[Optional[int]]] = {}
    for in_clause, binds in _chunked_in(project_ids):
        rows.extend(fetch_all(
            "SELECT project_id, feature_geojson, properties_json FROM cat_annotations "
            f"WHERE project_id IN ({in_clause}) AND deleted_at IS NULL",
            binds,
        ))
        try:
            for a in fetch_all(
                "SELECT project_id, source_epsg, target_epsg FROM cat_project_assets "
                f"WHERE project_id IN ({in_clause}) AND NVL(is_active, 1) = 1",
                binds,
            ):
                epsg = None
                for key in ("target_epsg", "source_epsg"):
                    v = a.get(key)
                    if v is not None:
                        try:
                            epsg = int(v)
                            break
                        except (TypeError, ValueError):
                            pass
                epsgs_by_project.setdefault(a["project_id"], []).append(epsg)
        except Exception:
            epsgs_by_project = {}
    return rows, _load_species_lookup(), epsgs_by_project


def _is_geographic(epsgs: List[Optional[int]]) -> bool:
    # See the area-unit note in _aggregate_rows: metric only when EVERY active
    # asset is trustworthy geographic (EPSG 4326).
    return bool(epsgs) and all(e == 4326 for e in epsgs)


def aggregate_annotations(project_ids: List[int]) -> Dict[str, Any]:
    """Aggregate non-deleted annotations across one or more projects.

    Signature takes a list of project ids on purpose: a future cross-site
    rollup will call this with many ids. Returns every report field except
    project_id/project_name (the endpoint layers those on). Per-row parsing is
    fully defensive — a single malformed annotation is counted toward
    annotation_count but can never abort or 500 the whole report.
    """
    if not project_ids:
        return _aggregate_rows([], {}, False)
    rows, species_lookup, epsgs_by_project = _load_aggregate_inputs(project_ids)
    all_epsgs = [e for pid in project_ids for e in epsgs_by_project.get(pid, [])]
    return _aggregate_rows(rows, species_lookup, _is_geographic(all_epsgs))


def _aggregate_rows(rows: List[Dict[str, Any]], species_lookup: Dict[str, Dict[str, Any]], geographic: bool) -> Dict[str, Any]:
    """The per-row aggregation behind aggregate_annotations(), on rows already
    fetched — so one fetch can feed a rollup and every per-project breakdown.

    Area unit (deliberate): a metric (m^2) area is only honest when the source
    raster is truly georeferenced AND the stored coordinates are real lng/lat
    degrees. LOCAL_CS / unknown-EPSG rasters store relabeled pixel space, so
    by default a planar shoelace area is reported with unit="relative"; only
    when every active asset is EPSG 4326 (geographic=True) is a spherical
    geodesic area in m^2 used. We never present a possibly-wrong m^2.
    """
    area_unit = "m^2" if geographic else "relative"

    species_counts: Dict[str, int] = {}
    condition_counts: Dict[str, int] = {}
    shape_counts: Dict[str, int] = {}
    unrecognized_species_counts: Dict[str, int] = {}  # spcode present but not in cat_coral_species
    missing_spcode = 0
    missing_con1 = 0
    total_area_value = 0.0
    area_computable = 0
    area_missing = 0
    total_length_value = 0.0
    length_computable = 0
    length_missing = 0
    derived_row_count = 0  # rows tagged as derived from another detection (e.g. a
    # SAM3 "max diameter" line saved alongside its source polygon) -- excluded
    # from species/condition/shape/annotation counts so a "save both" SAM3 run
    # doesn't silently double colony counts, but still measured (total_length).

    for row in rows:
        try:
            props = _parse_json_field(row.get("properties_json"), default={})
            if not isinstance(props, dict):
                props = {}
            feat = _parse_json_field(row.get("feature_geojson"), default=None)

            is_derived = bool(props.get("derived_from"))
            if is_derived:
                derived_row_count += 1

            geom = feat.get("geometry") if isinstance(feat, dict) else None
            gtype = geom.get("type") if isinstance(geom, dict) else None

            if not is_derived:
                spcode = props.get("spcode")
                if spcode is None or (isinstance(spcode, str) and not spcode.strip()):
                    missing_spcode += 1
                else:
                    species_counts[spcode] = species_counts.get(spcode, 0) + 1
                    if spcode not in species_lookup:
                        unrecognized_species_counts[spcode] = unrecognized_species_counts.get(spcode, 0) + 1

                con1 = props.get("con_1")
                if con1 is None or (isinstance(con1, str) and not con1.strip()):
                    missing_con1 += 1
                else:
                    condition_counts[con1] = condition_counts.get(con1, 0) + 1

                if gtype:
                    shape_counts[gtype] = shape_counts.get(gtype, 0) + 1

                if gtype in ("Polygon", "MultiPolygon"):
                    coords = geom.get("coordinates") if isinstance(geom, dict) else None
                    area = _annotation_area(gtype, coords, geographic)
                    if area is None:
                        area_missing += 1
                    else:
                        total_area_value += area
                        area_computable += 1

            if gtype in ("LineString", "MultiLineString"):
                coords = geom.get("coordinates") if isinstance(geom, dict) else None
                length = _annotation_length(gtype, coords, geographic)
                if length is None:
                    length_missing += 1
                else:
                    total_length_value += length
                    length_computable += 1
        except Exception:
            # A single unparseable row is tolerated: it still counts toward
            # annotation_count (len(rows)) but contributes to no breakdown.
            continue

    by_species = [
        {
            "spcode": code,
            "name": (species_lookup.get(code) or {}).get("name") or code,
            "count": cnt,
        }
        for code, cnt in species_counts.items()
    ]
    by_species.sort(key=lambda d: (-d["count"], str(d["spcode"])))

    by_condition = [{"condition": k, "count": c} for k, c in condition_counts.items()]
    by_condition.sort(key=lambda d: (-d["count"], str(d["condition"])))

    by_shape_type = [{"shape_type": k, "count": c} for k, c in shape_counts.items()]
    by_shape_type.sort(key=lambda d: (-d["count"], str(d["shape_type"])))

    by_unrecognized_species = [{"spcode": k, "count": c} for k, c in unrecognized_species_counts.items()]
    by_unrecognized_species.sort(key=lambda d: (-d["count"], str(d["spcode"])))

    length_unit = "m" if geographic else "relative"

    return {
        "annotation_count": len(rows) - derived_row_count,
        "by_species": by_species,
        "by_condition": by_condition,
        "by_shape_type": by_shape_type,
        # spcode values that were present but don't match any row in
        # cat_coral_species — likely typos/stale codes, a data-consistency
        # signal distinct from "missing" (empty) spcode above.
        "by_unrecognized_species": by_unrecognized_species,
        "total_area": {
            "value": round(total_area_value, 6),
            "unit": area_unit,
            "computable_count": area_computable,
            "missing_count": area_missing,
        },
        "total_length": {
            "value": round(total_length_value, 6),
            "unit": length_unit,
            "computable_count": length_computable,
            "missing_count": length_missing,
        },
        "missing_fields": {"spcode": missing_spcode, "con_1": missing_con1},
    }


@router.get("/projects/{project_id}/report")
def project_report(project_id: int, _current_user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    _ensure_oracle_mode()
    project = fetch_one("SELECT * FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    stats = aggregate_annotations([project_id])
    return {
        "project_id": project_id,
        "project_name": project.get("project_name") or project.get("PROJECT_NAME"),
        **stats,
    }


# ---------------------------------------------------------------------------
# Multi-project export (region/year filtered) — CAT v10 roadmap item 2
# ---------------------------------------------------------------------------

def _resolve_export_project_ids(
    project_ids_csv: Optional[str],
    region: Optional[str],
    year: Optional[int],
    current_user: Dict[str, Any],
    scope: Optional[str] = "all",
) -> List[int]:
    """Resolve which project ids an export/QC run covers: an explicit
    comma-separated project_ids list takes priority over region/year
    filters. Always intersected with the caller's visible projects (see
    _visible_project_where) and with the Mine/All ownership scope (see
    _scope_where — same "mine" = owned + collaborator rule the Project
    Manager's own list uses). Defaults to "all" rather than "mine" so a
    request that omits scope (an old bookmark, a script hitting the API
    directly) keeps seeing what it always has; the QC and Export page UIs
    pass scope explicitly."""
    visible_where, params = _visible_project_where(current_user)
    scope_sql, scope_params, _scope = _scope_where(scope, current_user)
    params.update(scope_params)

    base_conditions = [visible_where]
    if scope_sql != "1=1":
        base_conditions.append(scope_sql)

    if project_ids_csv and project_ids_csv.strip():
        try:
            requested = [int(x) for x in project_ids_csv.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="project_ids must be a comma-separated list of integers")
        if not requested:
            return []
        id_binds = {f"pid{i}": pid for i, pid in enumerate(requested)}
        in_clause = ", ".join(f":{k}" for k in id_binds)
        rows = fetch_all(
            f"SELECT project_id FROM cat_projects WHERE project_id IN ({in_clause}) AND {' AND '.join(base_conditions)}",
            {**id_binds, **params},
        )
        return [r["project_id"] for r in rows]

    conditions = list(base_conditions)
    if region and region.strip():
        params["region"] = region.strip()
        conditions.append("region = :region")
    if year is not None:
        params["year"] = year
        conditions.append("year_num = :year")

    rows = fetch_all(f"SELECT project_id FROM cat_projects WHERE {' AND '.join(conditions)}", params)
    return [r["project_id"] for r in rows]


def _fetch_export_annotations(ids: List[int]) -> Tuple[Dict[int, Dict[str, Any]], List[Dict[str, Any]]]:
    """Shared fetch for both export formats: project id -> {name, region,
    year} map, and every non-deleted annotation row (normalized) across the
    given project ids."""
    id_binds = {f"pid{i}": pid for i, pid in enumerate(ids)}
    in_clause = ", ".join(f":{k}" for k in id_binds)

    projects = fetch_all(
        f"SELECT project_id, project_name, region, year_num FROM cat_projects WHERE project_id IN ({in_clause})",
        id_binds,
    )
    project_by_id = {
        p["project_id"]: {"name": p.get("project_name"), "region": p.get("region"), "year": p.get("year_num")}
        for p in projects
    }

    rows = fetch_all(
        f"SELECT * FROM cat_annotations WHERE project_id IN ({in_clause}) AND deleted_at IS NULL "
        "ORDER BY project_id, created_at ASC",
        id_binds,
    )
    return project_by_id, [_normalize_annotation_row(r) for r in rows]


def _species_taxon_lookup() -> Dict[str, str]:
    """spcode -> taxon_name map for CSV export enrichment. Empty on failure
    (species table missing/unreachable) rather than aborting the export —
    the taxon_name column just comes back blank."""
    try:
        return {
            s.get("spcode"): s.get("taxon_name")
            for s in fetch_all("SELECT spcode, taxon_name FROM cat_coral_species")
            if s.get("spcode")
        }
    except Exception:
        return {}


@router.get("/projects/export/geojson")
def export_projects_geojson(
    project_ids: Optional[str] = None,
    region: Optional[str] = None,
    year: Optional[int] = None,
    scope: Optional[str] = "all",
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Response:
    """Combined GeoJSON export across one or more projects, selected either by
    an explicit project_ids list or by region/year filter. Every feature
    carries project_id/project_name in its properties so a multi-project
    export stays attributable once downloaded. `scope` is the Mine/All
    ownership filter (see _scope_where)."""
    _ensure_oracle_mode()
    ids = _resolve_export_project_ids(project_ids, region, year, current_user, scope)

    features = []
    if ids:
        project_by_id, annotations = _fetch_export_annotations(ids)
        for normalized in annotations:
            pid = normalized.get("project_id")
            proj = project_by_id.get(pid) or {}
            features.append(
                {
                    "type": "Feature",
                    # Bare geometry — normalized["feature"] is a whole
                    # nested Feature and would make every exported feature's
                    # geometry invalid GeoJSON (a Feature where a geometry
                    # is expected), unreadable by QGIS/ArcGIS/geopandas.
                    "geometry": normalized.get("geometry"),
                    "properties": {
                        "annotation_id": normalized.get("annotation_id"),
                        "project_id": pid,
                        "project_name": proj.get("name"),
                        "project_region": proj.get("region"),
                        "project_year": proj.get("year"),
                        **(normalized.get("properties") or {}),
                    },
                }
            )

    payload = {
        "type": "FeatureCollection",
        "project_ids": ids,
        "feature_count": len(features),
        "features": features,
    }
    filename = f"cat_export_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.geojson"
    return Response(
        content=json.dumps(payload, default=_numpy_safe_json),
        media_type="application/geo+json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/projects/export/csv")
def export_projects_csv(
    project_ids: Optional[str] = None,
    region: Optional[str] = None,
    year: Optional[int] = None,
    scope: Optional[str] = "all",
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Response:
    """Flat CSV export across one or more projects (same selection rules as
    the GeoJSON export). One row per annotation; geometry is summarized as
    its type only (full geometry belongs in the GeoJSON export, not a flat
    table) plus a raw properties_json catch-all column for anything not
    broken out into its own column. spcode is enriched with its taxon_name
    from cat_coral_species so the CSV is usable without a separate species
    lookup. `scope` is the Mine/All ownership filter (see _scope_where)."""
    _ensure_oracle_mode()
    import csv
    import io

    ids = _resolve_export_project_ids(project_ids, region, year, current_user, scope)
    species_lookup = _species_taxon_lookup() if ids else {}

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "project_id", "project_name", "project_region", "project_year",
        "annotation_id", "created_at", "geometry_type",
        "spcode", "taxon_name", "con_1", "properties_json",
    ])

    if ids:
        project_by_id, annotations = _fetch_export_annotations(ids)
        for normalized in annotations:
            pid = normalized.get("project_id")
            proj = project_by_id.get(pid) or {}
            props = normalized.get("properties") or {}
            # Bare geometry, not the whole Feature — normalized["feature"]'s
            # own "type" is always the literal string "Feature", which is
            # what made the geometry_type column below read "Feature" for
            # every single row ever exported instead of Polygon/LineString/
            # Point.
            geom = normalized.get("geometry") or {}
            spcode = props.get("spcode")
            writer.writerow([
                pid,
                proj.get("name"),
                proj.get("region"),
                proj.get("year"),
                normalized.get("annotation_id"),
                normalized.get("created_at"),
                geom.get("type") if isinstance(geom, dict) else None,
                spcode,
                species_lookup.get(spcode) if spcode else None,
                props.get("con_1"),
                json.dumps(props, default=_numpy_safe_json),
            ])

    filename = f"cat_export_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/projects/{project_id}/overlay-layers")
def create_overlay_layer(
    project_id: int,
    payload: OverlayLayerCreate,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    sql = """
        INSERT INTO cat_overlay_layers (
            project_id, layer_name, source_uri, source_epsg, target_epsg, style_json, layer_type
        ) VALUES (
            :project_id, :layer_name, :source_uri, :source_epsg, :target_epsg, :style_json, :layer_type
        ) RETURNING layer_id INTO :layer_id
    """

    layer_id = execute_returning_id(
        sql,
        {
            "project_id": project_id,
            "layer_name": payload.layer_name,
            "source_uri": payload.source_uri,
            "source_epsg": payload.source_epsg,
            "target_epsg": payload.target_epsg,
            "style_json": json.dumps(payload.style),
            "layer_type": payload.layer_type,
        },
        id_column="layer_id",
    )

    layer = fetch_one("SELECT * FROM cat_overlay_layers WHERE layer_id = :layer_id", {"layer_id": layer_id})
    return {"success": True, "layer": _normalize_layer_row(layer)}


@router.get("/projects/{project_id}/overlay-layers")
def list_overlay_layers(project_id: int, _current_user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    _ensure_oracle_mode()

    rows = fetch_all(
        "SELECT * FROM cat_overlay_layers WHERE project_id = :project_id ORDER BY display_order ASC, created_at ASC",
        {"project_id": project_id},
    )
    return {"success": True, "count": len(rows), "layers": [_normalize_layer_row(r) for r in rows]}


def _utm_epsg_for_lonlat(lon: float, lat: float) -> int:
    """Pick a UTM zone EPSG code so meter-based transect/segment math is accurate."""
    zone = int((lon + 180) / 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def _build_transect_geometry(
    points: List["LatLng"],
    num_segments: int,
    segment_length_m: float,
    segment_gap_m: float,
    segment_width_m: float,
):
    """
    Given a clicked lat/lng path (2+ points — a straight baseline, or an arbitrary
    multi-point path for a bent/irregular transect), build evenly spaced horizontal
    transect lines and their corresponding segment rectangles along it, in meters,
    reprojected back to EPSG:4326. Mirrors arcgis_scripts_v11's non-camera
    _generate_transect_lines/_create_transect_segments layout (fixed segment length +
    gap, perpendicular buffer for segments) without the raster/mask auto-placement.

    Each individual transect line/segment stays straight (spanning only
    segment_length_m), but their placement follows the drawn path's arc length, so a
    multi-point path naturally bends the overall layout at its vertices.

    Returns (transect_features, segment_features), each a list of
    (geojson_geometry_dict, properties_dict) tuples in EPSG:4326.
    """
    import math
    from pyproj import Transformer
    from shapely.geometry import LineString, Polygon, mapping

    utm_epsg = _utm_epsg_for_lonlat(points[0].lng, points[0].lat)
    to_utm = Transformer.from_crs(4326, utm_epsg, always_xy=True)
    to_wgs84 = Transformer.from_crs(utm_epsg, 4326, always_xy=True)

    utm_coords = [to_utm.transform(p.lng, p.lat) for p in points]
    path = LineString(utm_coords)
    path_len = path.length
    if path_len < 1e-6:
        raise HTTPException(status_code=400, detail="Drawn points are too close together")

    step = segment_length_m + segment_gap_m
    required_len = num_segments * segment_length_m + (num_segments - 1) * segment_gap_m
    if path_len < required_len:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Drawn path is only {path_len:.1f}m long — need at least {required_len:.1f}m "
                f"for {num_segments} segments of {segment_length_m}m with {segment_gap_m}m gaps. "
                "Draw a longer path or reduce the segment count."
            ),
        )

    half_w = segment_width_m / 2.0

    # Vertical "tick" lines — short reference marks crossing the transect 1m into
    # each of the first 3 horizontal segments (the 1m/6m/11m marks), matching the
    # ArcGIS pipeline's transect shapefile convention. Purely a visual/field
    # reference; they don't affect the segment quadrats. Derived from the same
    # chord as their horizontal segment (not a separately-sampled tangent) so a
    # tick is always exactly perpendicular to its own transect line, even where
    # the drawn path bends nearby.
    tick_offset_m = 1.0
    tick_length_m = 1.0
    half_tick = tick_length_m / 2.0

    transect_features = []
    segment_features = []
    for i in range(num_segments):
        s = i * step
        e = s + segment_length_m
        p_s = path.interpolate(s)
        p_e = path.interpolate(e)
        sx, sy = p_s.x, p_s.y
        ex, ey = p_e.x, p_e.y

        dx, dy = ex - sx, ey - sy
        seg_len = math.hypot(dx, dy) or 1.0
        ux, uy = dx / seg_len, dy / seg_len
        px, py = -uy, ux  # perpendicular unit vector, local to this sub-segment

        line = LineString([to_wgs84.transform(sx, sy), to_wgs84.transform(ex, ey)])
        trans_id = f"T{i + 1}H"
        transect_features.append((
            mapping(line),
            {
                "Trans_ID": trans_id,
                "Start_m": round(s, 2),
                "End_m": round(e, 2),
                "Length_m": segment_length_m,
                "Method": "User-drawn",
            },
        ))

        corners_utm = [
            (sx + px * half_w, sy + py * half_w),
            (ex + px * half_w, ey + py * half_w),
            (ex - px * half_w, ey - py * half_w),
            (sx - px * half_w, sy - py * half_w),
        ]
        corners_wgs = [to_wgs84.transform(cx, cy) for cx, cy in corners_utm]
        polygon = Polygon(corners_wgs + [corners_wgs[0]])
        segment_features.append((
            mapping(polygon),
            {
                "Seg_ID": f"S{i + 1}",
                "Trans_ID": trans_id,
                "Width_m": segment_width_m,
                "Area_m2": round(segment_length_m * segment_width_m, 3),
            },
        ))

        if i < 3:
            # Point tick_offset_m along this segment's own chord (not the raw path)
            # so it stays exactly on and perpendicular to T{i+1}H.
            cx, cy = sx + ux * tick_offset_m, sy + uy * tick_offset_m
            tick_line = LineString([
                to_wgs84.transform(cx + px * half_tick, cy + py * half_tick),
                to_wgs84.transform(cx - px * half_tick, cy - py * half_tick),
            ])
            transect_features.append((
                mapping(tick_line),
                {
                    "Trans_ID": f"T{i + 1}V",
                    "Length_m": tick_length_m,
                    "Method": "User-drawn",
                },
            ))

    return transect_features, segment_features


@router.post("/projects/{project_id}/overlay-layers/generate-transect")
def generate_transect_layers(
    project_id: int,
    payload: TransectGenerateRequest,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """
    Create a paired transect + segment overlay layer from a user-drawn path
    (2 or more clicked map points — a straight baseline, or an arbitrary
    multi-point path for a bent/irregular transect), reproducing the standard
    2.5m segment / 5m spacing convention used by the ArcGIS pipeline, without
    any raster/mask auto-placement.
    """
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        transect_features, segment_features = _build_transect_geometry(
            payload.points,
            payload.num_segments,
            payload.segment_length_m,
            payload.segment_gap_m,
            payload.segment_width_m,
        )
    except ImportError:
        raise HTTPException(status_code=500, detail="pyproj/shapely not installed")

    def _create_layer(layer_name: str, layer_type: str, style: Dict[str, Any], features) -> Dict[str, Any]:
        layer_id = execute_returning_id(
            """
            INSERT INTO cat_overlay_layers (
                project_id, layer_name, source_epsg, target_epsg, style_json, layer_type
            ) VALUES (
                :project_id, :layer_name, :source_epsg, :target_epsg, :style_json, :layer_type
            ) RETURNING layer_id INTO :layer_id
            """,
            {
                "project_id": project_id,
                "layer_name": layer_name,
                "source_epsg": 4326,
                "target_epsg": 4326,
                "style_json": json.dumps(style),
                "layer_type": layer_type,
            },
            id_column="layer_id",
        )

        rows = []
        for geometry, properties in features:
            if payload.notes:
                properties = {**properties, "Notes": payload.notes}
            feature_geojson = {"type": "Feature", "geometry": geometry, "properties": properties}
            rows.append({
                "layer_id": layer_id,
                "feature_geojson": json.dumps(feature_geojson),
                "properties_json": json.dumps(properties),
            })
        if rows:
            try:
                execute_many(
                    """
                    INSERT INTO cat_overlay_features (layer_id, feature_geojson, properties_json)
                    VALUES (:layer_id, :feature_geojson, :properties_json)
                    """,
                    rows,
                )
            except Exception:
                _drop_failed_layer(layer_id)
                raise

        layer = fetch_one("SELECT * FROM cat_overlay_layers WHERE layer_id = :layer_id", {"layer_id": layer_id})
        return _normalize_layer_row(layer)

    stamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    transect_layer = _create_layer(
        f"Transect ({stamp})",
        "transect",
        {"color": "#ff8c00", "weight": 3, "opacity": 0.9},
        transect_features,
    )
    try:
        segment_layer = _create_layer(
            f"Segments ({stamp})",
            "segment",
            {"color": "#1e90ff", "weight": 1, "opacity": 0.8, "fillOpacity": 0.25},
            segment_features,
        )
    except Exception:
        # All or nothing: don't leave a transect without its segments.
        _drop_failed_layer(transect_layer["layer_id"])
        raise

    return {"success": True, "transect_layer": transect_layer, "segment_layer": segment_layer}


@router.post("/projects/{project_id}/overlay-layers/{layer_id}/features")
def create_overlay_feature(
    project_id: int,
    layer_id: int,
    payload: OverlayFeatureCreate,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    layer = fetch_one(
        """
        SELECT layer_id FROM cat_overlay_layers
        WHERE project_id = :project_id AND layer_id = :layer_id
        """,
        {"project_id": project_id, "layer_id": layer_id},
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Overlay layer not found")

    sql = """
        INSERT INTO cat_overlay_features (
            layer_id, feature_geojson, properties_json
        ) VALUES (
            :layer_id, :feature_geojson, :properties_json
        ) RETURNING feature_id INTO :feature_id
    """

    feature_id = execute_returning_id(
        sql,
        {
            "layer_id": layer_id,
            "feature_geojson": json.dumps(payload.feature),
            "properties_json": json.dumps(payload.properties),
        },
        id_column="feature_id",
    )

    feature = fetch_one("SELECT * FROM cat_overlay_features WHERE feature_id = :feature_id", {"feature_id": feature_id})
    return {
        "success": True,
        "feature": {
            **feature,
            "feature": _parse_json_field(feature.get("feature_geojson"), default=None),
            "properties": _parse_json_field(feature.get("properties_json"), default={}),
        },
    }


@router.get("/projects/{project_id}/overlay-layers/{layer_id}/features")
def list_overlay_features(
    project_id: int, layer_id: int, _current_user: Dict[str, Any] = Depends(require_auth)
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    layer = fetch_one(
        """
        SELECT layer_id FROM cat_overlay_layers
        WHERE project_id = :project_id AND layer_id = :layer_id
        """,
        {"project_id": project_id, "layer_id": layer_id},
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Overlay layer not found")

    rows = fetch_all(
        "SELECT * FROM cat_overlay_features WHERE layer_id = :layer_id ORDER BY created_at ASC",
        {"layer_id": layer_id},
    )
    normalized = [
        {
            **r,
            "feature": _parse_json_field(r.get("feature_geojson"), default=None),
            "properties": _parse_json_field(r.get("properties_json"), default={}),
        }
        for r in rows
    ]
    return {"success": True, "count": len(normalized), "features": normalized}


@router.post("/projects/{project_id}/overlay-layers/{layer_id}/buffer")
def buffer_overlay_layer(
    project_id: int,
    layer_id: int,
    payload: OverlayBufferRequest,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Buffer every feature in an overlay layer by distance_m, writing the
    result into a new 'derived' overlay layer (the source layer is untouched).
    Buffering is done in a local UTM projection (same _utm_epsg_for_lonlat
    helper generate-transect uses below) since features are stored in
    EPSG:4326 degrees and a degree-space buffer would be badly distorted."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "editor")

    layer = fetch_one(
        "SELECT * FROM cat_overlay_layers WHERE project_id = :project_id AND layer_id = :layer_id",
        {"project_id": project_id, "layer_id": layer_id},
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Overlay layer not found")

    rows = fetch_all(
        "SELECT feature_geojson, properties_json FROM cat_overlay_features WHERE layer_id = :layer_id",
        {"layer_id": layer_id},
    )
    if not rows:
        raise HTTPException(status_code=400, detail="Source layer has no features to buffer")

    try:
        from pyproj import Transformer
        from shapely.geometry import shape, mapping
        from shapely.ops import transform as shapely_transform
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=f"Missing required package: {exc}")

    # Geometry work first (a bad geometry is skipped and counted), then the
    # layer + all its features in one go, so a DB failure can't leave a
    # partial layer. (DB errors used to be swallowed per feature too.)
    out_features = []
    skipped = 0
    for row in rows:
        try:
            geom_dict = _parse_json_field(row.get("feature_geojson"), default=None)
            if not geom_dict:
                skipped += 1
                continue
            geom = shape(geom_dict)
            centroid = geom.centroid
            utm_epsg = _utm_epsg_for_lonlat(centroid.x, centroid.y)
            to_utm = Transformer.from_crs(4326, utm_epsg, always_xy=True)
            to_wgs84 = Transformer.from_crs(utm_epsg, 4326, always_xy=True)
            buffered_utm = shapely_transform(to_utm.transform, geom).buffer(payload.distance_m)
            buffered_wgs84 = shapely_transform(to_wgs84.transform, buffered_utm)
            out_features.append((json.dumps(mapping(buffered_wgs84)), row.get("properties_json")))
        except Exception:
            skipped += 1

    new_layer_name = payload.new_layer_name or f"{layer['layer_name']} (buffered {payload.distance_m}m)"
    new_layer_id = _create_derived_layer(project_id, new_layer_name, out_features)

    _log_activity(project_id, current_user["user_id"], "overlay_layer_buffered",
                  {"source_layer_id": layer_id, "new_layer_id": new_layer_id, "distance_m": payload.distance_m})
    new_layer = fetch_one("SELECT * FROM cat_overlay_layers WHERE layer_id = :layer_id", {"layer_id": new_layer_id})
    return {"success": True, "layer": _normalize_layer_row(new_layer),
            "feature_count": len(out_features), "skipped_count": skipped}


@router.post("/projects/{project_id}/overlay-layers/{layer_id}/clip")
def clip_overlay_layer(
    project_id: int,
    layer_id: int,
    payload: OverlayClipRequest,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Clip every feature in an overlay layer against the (unioned) geometry
    of another overlay layer, writing the result into a new 'derived' layer."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "editor")

    layer = fetch_one(
        "SELECT * FROM cat_overlay_layers WHERE project_id = :project_id AND layer_id = :layer_id",
        {"project_id": project_id, "layer_id": layer_id},
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Source overlay layer not found")
    clip_layer = fetch_one(
        "SELECT * FROM cat_overlay_layers WHERE project_id = :project_id AND layer_id = :layer_id",
        {"project_id": project_id, "layer_id": payload.clip_layer_id},
    )
    if not clip_layer:
        raise HTTPException(status_code=404, detail="Clip layer not found")

    source_rows = fetch_all(
        "SELECT feature_geojson, properties_json FROM cat_overlay_features WHERE layer_id = :layer_id",
        {"layer_id": layer_id},
    )
    clip_rows = fetch_all(
        "SELECT feature_geojson FROM cat_overlay_features WHERE layer_id = :layer_id",
        {"layer_id": payload.clip_layer_id},
    )
    if not source_rows:
        raise HTTPException(status_code=400, detail="Source layer has no features to clip")
    if not clip_rows:
        raise HTTPException(status_code=400, detail="Clip layer has no features")

    try:
        from shapely.geometry import shape, mapping
        from shapely.ops import unary_union
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=f"Missing required package: {exc}")

    clip_geoms = []
    for r in clip_rows:
        g = _parse_json_field(r.get("feature_geojson"), default=None)
        if not g:
            continue
        try:
            clip_geoms.append(shape(g))
        except Exception:
            continue
    if not clip_geoms:
        raise HTTPException(status_code=400, detail="Clip layer has no valid geometries")
    clip_union = unary_union(clip_geoms)

    out_features = []
    skipped = 0
    for row in source_rows:
        try:
            geom_dict = _parse_json_field(row.get("feature_geojson"), default=None)
            if not geom_dict:
                skipped += 1
                continue
            intersection = shape(geom_dict).intersection(clip_union)
            if intersection.is_empty:
                continue  # outside the clip area: expected, not an error
            out_features.append((json.dumps(mapping(intersection)), row.get("properties_json")))
        except Exception:
            skipped += 1

    new_layer_name = payload.new_layer_name or f"{layer['layer_name']} (clipped)"
    new_layer_id = _create_derived_layer(project_id, new_layer_name, out_features)

    _log_activity(project_id, current_user["user_id"], "overlay_layer_clipped",
                  {"source_layer_id": layer_id, "clip_layer_id": payload.clip_layer_id, "new_layer_id": new_layer_id})
    new_layer = fetch_one("SELECT * FROM cat_overlay_layers WHERE layer_id = :layer_id", {"layer_id": new_layer_id})
    return {"success": True, "layer": _normalize_layer_row(new_layer),
            "feature_count": len(out_features), "skipped_count": skipped}


@router.post("/projects/{project_id}/overlay-layers/upload-shapefile")
async def upload_shapefile_to_layer(
    project_id: int,
    file: UploadFile = File(...),
    layer_type: Optional[str] = Form(None),
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """
    Upload a shapefile ZIP (containing .shp, .shx, .dbf, .prj) and create an overlay layer.
    Automatically imports all features from the shapefile into the layer.
    """
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    # Verify project exists
    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Validate file is ZIP
    if not file.filename.lower().endswith('.zip'):
        raise HTTPException(status_code=400, detail="File must be a ZIP archive containing shapefile components")

    try:
        import geopandas as gpd
    except ImportError:
        raise HTTPException(status_code=500, detail="geopandas not installed. Run: pip install geopandas")

    try:
        # Create temp directory for extraction
        with tempfile.TemporaryDirectory() as tmpdir:
            zip_path = Path(tmpdir) / file.filename
            
            # Save uploaded ZIP
            with open(zip_path, 'wb') as f:
                content = await file.read()
                f.write(content)

            # Extract ZIP
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(tmpdir)

            # Find the .shp file
            shp_files = list(Path(tmpdir).rglob('*.shp'))
            if not shp_files:
                raise HTTPException(status_code=400, detail="No .shp file found in ZIP archive")

            shp_path = shp_files[0]
            layer_name = shp_path.stem

            # Read shapefile with geopandas
            gdf = gpd.read_file(shp_path)

            # Store original CRS
            source_epsg = gdf.crs.to_epsg() if gdf.crs else None

            # Reproject to WGS84 (EPSG:4326) for web display
            if gdf.crs and gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(epsg=4326)

            # Create overlay layer
            layer_id = execute_returning_id(
                """
                INSERT INTO cat_overlay_layers (
                    project_id, layer_name, source_uri, source_epsg, target_epsg, style_json, layer_type
                ) VALUES (
                    :project_id, :layer_name, :source_uri, :source_epsg, :target_epsg, :style_json, :layer_type
                ) RETURNING layer_id INTO :layer_id
                """,
                {
                    "project_id": project_id,
                    "layer_name": layer_name,
                    "source_uri": file.filename,
                    "source_epsg": source_epsg,
                    "target_epsg": 4326,
                    "style_json": json.dumps({"color": "#00ff00", "weight": 2, "opacity": 0.7}),
                    "layer_type": layer_type,
                },
                id_column="layer_id",
            )

            # Bulk import features. If anything fails from here on, drop the
            # layer just created (features cascade) so a failed upload doesn't
            # leave an empty or partial layer behind.
            try:
                features_data = []
                for idx, row in gdf.iterrows():
                    geom = row.geometry
                    properties = {k: v for k, v in row.items() if k != 'geometry'}

                    # Convert to GeoJSON
                    feature_geojson = {
                        "type": "Feature",
                        "geometry": json.loads(gpd.GeoSeries([geom]).to_json())['features'][0]['geometry'],
                        "properties": properties
                    }

                    features_data.append({
                        "layer_id": layer_id,
                        "feature_geojson": json.dumps(feature_geojson, default=_numpy_safe_json),
                        "properties_json": json.dumps(properties, default=_numpy_safe_json)
                    })

                if features_data:
                    execute_many(
                        """
                        INSERT INTO cat_overlay_features (layer_id, feature_geojson, properties_json)
                        VALUES (:layer_id, :feature_geojson, :properties_json)
                        """,
                        features_data
                    )
            except Exception:
                _drop_failed_layer(layer_id)
                raise

            return {
                "success": True,
                "layer_id": layer_id,
                "layer_name": layer_name,
                "feature_count": len(features_data),
                "source_epsg": source_epsg,
                "message": f"Imported {len(features_data)} features from {layer_name}"
            }

    except HTTPException:
        raise
    except Exception as e:
        # Full traceback to the server log, not to the browser.
        logger.exception("Shapefile upload failed for project %s", project_id)
        raise HTTPException(status_code=500, detail=f"Error processing shapefile: {e}")


def _create_derived_layer(project_id: int, layer_name: str, features: List[Tuple[str, Any]]) -> int:
    """Create a 'derived' overlay layer with its features (feature_geojson,
    properties_json pairs); if the feature insert fails, the layer is removed
    again and the error raised."""
    new_layer_id = execute_returning_id(
        """
        INSERT INTO cat_overlay_layers (project_id, layer_name, layer_type, style_json)
        VALUES (:project_id, :layer_name, 'derived', :style_json)
        RETURNING layer_id INTO :layer_id
        """,
        {"project_id": project_id, "layer_name": layer_name, "style_json": json.dumps({})},
        id_column="layer_id",
    )
    if features:
        try:
            execute_many(
                """
                INSERT INTO cat_overlay_features (layer_id, feature_geojson, properties_json)
                VALUES (:layer_id, :feature_geojson, :properties_json)
                """,
                [{"layer_id": new_layer_id, "feature_geojson": g, "properties_json": p} for g, p in features],
            )
        except Exception:
            _drop_failed_layer(new_layer_id)
            raise
    return new_layer_id


def _drop_failed_layer(layer_id: int) -> None:
    """Remove a layer whose feature import failed part-way (its features go
    with it via ON DELETE CASCADE). Never masks the original error."""
    try:
        execute("DELETE FROM cat_overlay_layers WHERE layer_id = :layer_id", {"layer_id": layer_id})
    except Exception:
        logger.exception("Could not remove partially imported overlay layer %s", layer_id)


def _import_shapefile_from_dir(
    project_id: int, tmpdir: str, source_filename: str, layer_type: Optional[str] = None
) -> Dict[str, Any]:
    """
    Shared helper: given a temp directory containing shapefile components,
    read the .shp with geopandas, reproject to 4326, and import into the DB.
    Returns the result dict.
    """
    try:
        import geopandas as gpd
    except ImportError:
        raise HTTPException(status_code=500, detail="geopandas not installed. Run: pip install geopandas")

    shp_files = list(Path(tmpdir).rglob('*.shp'))
    if not shp_files:
        raise HTTPException(status_code=400, detail="No .shp file found in the uploaded files")

    shp_path = shp_files[0]
    layer_name = shp_path.stem

    gdf = gpd.read_file(shp_path)
    source_epsg = gdf.crs.to_epsg() if gdf.crs else None

    if gdf.crs and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)

    layer_id = execute_returning_id(
        """
        INSERT INTO cat_overlay_layers (
            project_id, layer_name, source_uri, source_epsg, target_epsg, style_json, layer_type
        ) VALUES (
            :project_id, :layer_name, :source_uri, :source_epsg, :target_epsg, :style_json, :layer_type
        ) RETURNING layer_id INTO :layer_id
        """,
        {
            "project_id": project_id,
            "layer_name": layer_name,
            "source_uri": source_filename,
            "source_epsg": source_epsg,
            "target_epsg": 4326,
            "style_json": json.dumps({"color": "#00ff00", "weight": 2, "opacity": 0.7}),
            "layer_type": layer_type,
        },
        id_column="layer_id",
    )

    try:
        features_data = []
        for idx, row in gdf.iterrows():
            geom = row.geometry
            properties = {k: v for k, v in row.items() if k != 'geometry'}
            feature_geojson = {
                "type": "Feature",
                "geometry": json.loads(gpd.GeoSeries([geom]).to_json())['features'][0]['geometry'],
                "properties": properties
            }
            features_data.append({
                "layer_id": layer_id,
                "feature_geojson": json.dumps(feature_geojson, default=_numpy_safe_json),
                "properties_json": json.dumps(properties, default=_numpy_safe_json)
            })

        if features_data:
            execute_many(
                """
                INSERT INTO cat_overlay_features (layer_id, feature_geojson, properties_json)
                VALUES (:layer_id, :feature_geojson, :properties_json)
                """,
                features_data
            )
    except Exception:
        _drop_failed_layer(layer_id)
        raise

    return {
        "success": True,
        "layer_id": layer_id,
        "layer_name": layer_name,
        "feature_count": len(features_data),
        "source_epsg": source_epsg,
        "message": f"Imported {len(features_data)} features from {layer_name}"
    }


@router.post("/projects/{project_id}/overlay-layers/upload-shapefile-files")
async def upload_shapefile_loose_files(
    project_id: int,
    files: List[UploadFile] = File(...),
    layer_type: Optional[str] = Form(None),
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """
    Upload loose shapefile component files (.shp, .shx, .dbf, .prj, etc.).
    Accepts multiple files that together form one shapefile.
    """
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Validate we got at least a .shp
    extensions = {Path(f.filename).suffix.lower() for f in files}
    if '.shp' not in extensions:
        raise HTTPException(status_code=400, detail="Must include at least a .shp file. Recommended: .shp, .shx, .dbf, .prj")

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            shp_filename = None
            for f in files:
                fname = Path(f.filename).name  # strip any directory prefix
                dest = Path(tmpdir) / fname
                content = await f.read()
                with open(dest, 'wb') as out:
                    out.write(content)
                if fname.lower().endswith('.shp'):
                    shp_filename = fname

            return _import_shapefile_from_dir(project_id, tmpdir, shp_filename or "shapefile", layer_type=layer_type)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Shapefile upload failed for project %s", project_id)
        raise HTTPException(status_code=500, detail=f"Error processing shapefile files: {e}")


# Must be registered BEFORE "/overlay-layers/{layer_id}": routes match in
# order, and that one would take "reorder" as a layer id and 422 (which is
# what happened — every layer-management Save with a changed order failed,
# losing its show/hide changes too).
class _LayerOrderItem(BaseModel):
    layer_id: int
    display_order: int


class LayerReorder(BaseModel):
    layer_orders: List[_LayerOrderItem] = Field(min_length=1)


@router.put("/projects/{project_id}/overlay-layers/reorder")
def reorder_overlay_layers(
    project_id: int,
    payload: LayerReorder,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Set display_order for the project's overlay layers, all-or-nothing."""
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    rows = [
        {"project_id": project_id, "layer_id": item.layer_id, "display_order": item.display_order}
        for item in payload.layer_orders
    ]
    with get_connection() as conn:
        try:
            with conn.cursor() as cursor:
                cursor.executemany(
                    "UPDATE cat_overlay_layers SET display_order = :display_order "
                    "WHERE project_id = :project_id AND layer_id = :layer_id",
                    rows,
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {"success": True, "updated_count": len(rows)}


@router.put("/projects/{project_id}/overlay-layers/{layer_id}")
def update_overlay_layer(
    project_id: int,
    layer_id: int,
    payload: Dict[str, Any],
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Update overlay layer metadata (name, style, is_active, display_order, is_locked)"""
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    # Verify layer exists and belongs to project
    layer = fetch_one(
        "SELECT * FROM cat_overlay_layers WHERE project_id = :project_id AND layer_id = :layer_id",
        {"project_id": project_id, "layer_id": layer_id}
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Overlay layer not found")

    # Build dynamic update based on provided fields
    update_fields = []
    params = {"project_id": project_id, "layer_id": layer_id}

    if "layer_name" in payload:
        update_fields.append("layer_name = :layer_name")
        params["layer_name"] = payload["layer_name"]
    
    if "style_json" in payload:
        update_fields.append("style_json = :style_json")
        params["style_json"] = json.dumps(payload["style_json"]) if isinstance(payload["style_json"], dict) else payload["style_json"]
    
    if "is_active" in payload:
        update_fields.append("is_active = :is_active")
        params["is_active"] = 1 if payload["is_active"] else 0
    
    if "display_order" in payload:
        update_fields.append("display_order = :display_order")
        params["display_order"] = payload["display_order"]

    if "layer_type" in payload:
        update_fields.append("layer_type = :layer_type")
        params["layer_type"] = payload["layer_type"]

    if "is_locked" in payload:
        update_fields.append("is_locked = :is_locked")
        params["is_locked"] = 1 if payload["is_locked"] else 0

    if not update_fields:
        return {"success": True, "message": "No fields to update"}

    sql = f"UPDATE cat_overlay_layers SET {', '.join(update_fields)} WHERE project_id = :project_id AND layer_id = :layer_id"
    execute(sql, params)

    return {"success": True, "layer_id": layer_id, "updated_fields": list(payload.keys())}


@router.delete("/projects/{project_id}/overlay-layers/{layer_id}")
def delete_overlay_layer(
    project_id: int,
    layer_id: int,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Delete overlay layer and all associated features"""
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    # Verify layer exists
    layer = fetch_one(
        "SELECT * FROM cat_overlay_layers WHERE project_id = :project_id AND layer_id = :layer_id",
        {"project_id": project_id, "layer_id": layer_id}
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Overlay layer not found")

    # Delete features first (due to FK constraint)
    execute("DELETE FROM cat_overlay_features WHERE layer_id = :layer_id", {"layer_id": layer_id})
    
    # Delete layer
    execute(
        "DELETE FROM cat_overlay_layers WHERE project_id = :project_id AND layer_id = :layer_id",
        {"project_id": project_id, "layer_id": layer_id}
    )

    return {"success": True, "layer_id": layer_id, "message": "Layer deleted"}


@router.put("/projects/{project_id}/overlay-layers/{layer_id}/features/{feature_id}")
def update_overlay_feature(
    project_id: int,
    layer_id: int,
    feature_id: int,
    payload: Dict[str, Any],
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Update an overlay feature's geometry and/or properties.

    Accepts JSON body with optional keys:
      - feature: GeoJSON geometry object (or full Feature)
      - properties: dict of updated properties
      - is_locked: 0/1 — lock gate for move/rotate/vertex-edit on this feature
    """
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "editor")

    # Verify feature belongs to the correct layer/project chain
    row = fetch_one(
        """
        SELECT f.feature_id, f.layer_id
        FROM cat_overlay_features f
        JOIN cat_overlay_layers l ON f.layer_id = l.layer_id
        WHERE l.project_id = :project_id
          AND l.layer_id   = :layer_id
          AND f.feature_id = :feature_id
        """,
        {"project_id": project_id, "layer_id": layer_id, "feature_id": feature_id},
    )
    if not row:
        raise HTTPException(status_code=404, detail="Overlay feature not found")

    update_fields = []
    params = {"feature_id": feature_id}

    if "feature" in payload:
        # Accept either a full GeoJSON Feature or just a geometry object
        geom = payload["feature"]
        if isinstance(geom, dict) and geom.get("type") == "Feature":
            # Caller sent a full Feature — store it as-is
            update_fields.append("feature_geojson = :feature_geojson")
            params["feature_geojson"] = json.dumps(geom)
            # Keep the separate properties_json column in step with the
            # Feature's own properties (e.g. Width_m/Length_m/Area_m2 after a
            # vertex edit) unless the caller sent explicit properties below.
            # Otherwise the two copies drift and resize/exports read stale sizes.
            if "properties" not in payload and isinstance(geom.get("properties"), dict):
                update_fields.append("properties_json = :properties_json")
                params["properties_json"] = json.dumps(geom["properties"])
        else:
            # Caller sent just the geometry
            feature_obj = {"type": "Feature", "geometry": geom, "properties": payload.get("properties", {})}
            update_fields.append("feature_geojson = :feature_geojson")
            params["feature_geojson"] = json.dumps(feature_obj)

    if "properties" in payload:
        update_fields.append("properties_json = :properties_json")
        params["properties_json"] = json.dumps(payload["properties"])

    if "is_locked" in payload:
        is_locked = 1 if payload["is_locked"] else 0
        update_fields.append("is_locked = :is_locked")
        params["is_locked"] = is_locked
        if is_locked:
            update_fields.append("locked_by_user_id = NULL")
            update_fields.append("locked_at = NULL")
        else:
            update_fields.append("locked_by_user_id = :locked_by_user_id")
            update_fields.append("locked_at = CURRENT_TIMESTAMP")
            params["locked_by_user_id"] = current_user.get("user_id")

    if not update_fields:
        return {"success": True, "message": "No fields to update"}

    sql = f"UPDATE cat_overlay_features SET {', '.join(update_fields)} WHERE feature_id = :feature_id"
    execute(sql, params)

    return {"success": True, "feature_id": feature_id, "message": "Feature updated"}


@router.put("/projects/{project_id}/overlay-layers/{layer_id}/features/{feature_id}/width")
def resize_overlay_feature_width(
    project_id: int,
    layer_id: int,
    feature_id: int,
    payload: OverlayFeatureResizeRequest,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Recompute a segment's rectangle at a new width and/or length, keeping
    its centerpoint fixed in place. This is the "resize" affordance for
    segments — hand-dragging the buffer polygon's own vertices (there can be
    100+) is what used to crash the tab, and a vertex was never individually
    meaningful anyway since it's mechanically derived from the transect line
    + a width/length. Only supported for features carrying a Width_m
    property (segments produced by generate-transect) — the corner order is
    relied on to identify the width edges (corners[0]-corners[3] and
    corners[1]-corners[2], per _build_transect_geometry's construction
    order, which our own move/rotate code preserves). length_m is optional
    and defaults to the segment's current Length_m, so existing callers that
    only ever sent width_m keep working unchanged."""
    _ensure_oracle_mode()
    _require_project_role(project_id, current_user, "editor")

    if payload.width_m <= 0:
        raise HTTPException(status_code=400, detail="Width must be greater than 0")
    if payload.length_m is not None and payload.length_m <= 0:
        raise HTTPException(status_code=400, detail="Length must be greater than 0")

    row = fetch_one(
        """
        SELECT f.* FROM cat_overlay_features f
        JOIN cat_overlay_layers l ON f.layer_id = l.layer_id
        WHERE l.project_id = :project_id AND f.layer_id = :layer_id AND f.feature_id = :feature_id
        """,
        {"project_id": project_id, "layer_id": layer_id, "feature_id": feature_id},
    )
    if not row:
        raise HTTPException(status_code=404, detail="Overlay feature not found")

    geom_dict = _parse_json_field(row.get("feature_geojson"), default=None)
    props = _parse_json_field(row.get("properties_json"), default={}) or {}
    if not geom_dict or "Width_m" not in props:
        raise HTTPException(status_code=400, detail="This feature isn't a resizable segment (no Width_m)")

    geometry = geom_dict.get("geometry") if geom_dict.get("type") == "Feature" else geom_dict
    coords = (geometry or {}).get("coordinates")
    if not geometry or geometry.get("type") != "Polygon" or not coords or len(coords[0]) < 5:
        raise HTTPException(status_code=400, detail="Feature geometry isn't a resizable rectangle")

    ring = coords[0]
    c0, c1, c2, c3 = ring[0], ring[1], ring[2], ring[3]

    try:
        import math
        from pyproj import Transformer
        from shapely.geometry import Polygon, mapping
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=f"Missing required package: {exc}")

    utm_epsg = _utm_epsg_for_lonlat(c0[0], c0[1])
    to_utm = Transformer.from_crs(4326, utm_epsg, always_xy=True)
    to_wgs84 = Transformer.from_crs(utm_epsg, 4326, always_xy=True)

    u0, u1, u2, u3 = (to_utm.transform(x, y) for (x, y) in (c0, c1, c2, c3))

    def midpoint(a, b):
        return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)

    start = midpoint(u0, u3)
    end = midpoint(u1, u2)
    dx, dy = end[0] - start[0], end[1] - start[1]
    chord_len = math.hypot(dx, dy) or 1.0
    ux, uy = dx / chord_len, dy / chord_len
    px, py = -uy, ux  # perpendicular unit vector

    # Length resize keeps the segment's centerpoint fixed and extends/shrinks
    # symmetrically along the chord direction, mirroring how width already
    # keeps the centerline fixed and extends/shrinks perpendicular to it.
    new_length = payload.length_m if payload.length_m is not None else chord_len
    center = ((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0)
    half_l = new_length / 2.0
    start = (center[0] - ux * half_l, center[1] - uy * half_l)
    end = (center[0] + ux * half_l, center[1] + uy * half_l)

    half_w = payload.width_m / 2.0
    new_corners_utm = [
        (start[0] + px * half_w, start[1] + py * half_w),
        (end[0] + px * half_w, end[1] + py * half_w),
        (end[0] - px * half_w, end[1] - py * half_w),
        (start[0] - px * half_w, start[1] - py * half_w),
    ]
    new_corners_wgs = [to_wgs84.transform(cx, cy) for cx, cy in new_corners_utm]
    polygon = Polygon(new_corners_wgs + [new_corners_wgs[0]])

    new_props = {**props, "Width_m": payload.width_m, "Area_m2": round(new_length * payload.width_m, 3)}
    if payload.length_m is not None:
        new_props["Length_m"] = new_length
    new_feature_geojson = {"type": "Feature", "geometry": mapping(polygon), "properties": new_props}

    execute(
        "UPDATE cat_overlay_features SET feature_geojson = :feature_geojson, properties_json = :properties_json WHERE feature_id = :feature_id",
        {
            "feature_geojson": json.dumps(new_feature_geojson),
            "properties_json": json.dumps(new_props),
            "feature_id": feature_id,
        },
    )

    return {
        "success": True,
        "feature": {
            "feature_id": feature_id,
            "feature": new_feature_geojson,
            "properties": new_props,
        },
    }


@router.post("/projects/{project_id}/sessions/start")
def start_session(
    project_id: int, payload: SessionStart, _current_user: Dict[str, Any] = Depends(require_auth)
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Sessions belong to the logged-in account (the page used to send the
    # Analyst field, often still empty = "unknown" when the project loads,
    # so everyone's time piled up under one name and totals never matched).
    username = (_current_user.get("username") or payload.username or "unknown")[:120]

    # Auto-close stale sessions (no heartbeat for >2h) across all users on this project (4c)
    execute(
        """
        UPDATE cat_annotation_sessions
        SET is_active = 0, end_time = CURRENT_TIMESTAMP
        WHERE project_id = :project_id AND is_active = 1
          AND last_heartbeat < CURRENT_TIMESTAMP - INTERVAL '2' HOUR
        """,
        {"project_id": project_id},
    )

    # End any previously active session for this user on this project
    execute(
        """
        UPDATE cat_annotation_sessions
        SET is_active = 0, end_time = CURRENT_TIMESTAMP
        WHERE project_id = :project_id AND username = :username AND is_active = 1
        """,
        {"project_id": project_id, "username": username},
    )

    # This person's time on this project from earlier sessions, so the page's
    # "Total" continues instead of restarting from zero on every load.
    prior = fetch_one(
        """
        SELECT NVL(SUM(total_seconds), 0) AS total_seconds, NVL(SUM(annotation_count), 0) AS annotation_count
        FROM cat_annotation_sessions
        WHERE project_id = :project_id AND username = :username
        """,
        {"project_id": project_id, "username": username},
    ) or {}

    session_id = execute_returning_id(
        """
        INSERT INTO cat_annotation_sessions (
            project_id, username, is_active
        ) VALUES (
            :project_id, :username, 1
        ) RETURNING session_id INTO :session_id
        """,
        {"project_id": project_id, "username": username},
        id_column="session_id",
    )

    session = fetch_one("SELECT * FROM cat_annotation_sessions WHERE session_id = :session_id", {"session_id": session_id})
    return {
        "success": True,
        "session": session,
        "prior_total_seconds": int(prior.get("total_seconds") or 0),
        "prior_annotation_count": int(prior.get("annotation_count") or 0),
    }


@router.put("/projects/{project_id}/sessions/{session_id}")
def update_session(
    project_id: int, session_id: int, payload: SessionUpdate, _current_user: Dict[str, Any] = Depends(require_auth)
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    session = fetch_one(
        """
        SELECT session_id FROM cat_annotation_sessions
        WHERE project_id = :project_id AND session_id = :session_id
        """,
        {"project_id": project_id, "session_id": session_id},
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    fields = []
    params: Dict[str, Any] = {"project_id": project_id, "session_id": session_id}
    if payload.total_seconds is not None:
        fields.append("total_seconds = :total_seconds")
        params["total_seconds"] = payload.total_seconds
    if payload.annotation_count is not None:
        fields.append("annotation_count = :annotation_count")
        params["annotation_count"] = payload.annotation_count
    if payload.is_active is not None:
        fields.append("is_active = :is_active")
        params["is_active"] = 1 if payload.is_active else 0
    if fields:
        # A progress update also keeps the session from being auto-closed.
        fields.append("last_heartbeat = CURRENT_TIMESTAMP")

    if fields:
        execute(
            f"UPDATE cat_annotation_sessions SET {', '.join(fields)} WHERE project_id = :project_id AND session_id = :session_id",
            params,
        )

    updated = fetch_one(
        "SELECT * FROM cat_annotation_sessions WHERE project_id = :project_id AND session_id = :session_id",
        {"project_id": project_id, "session_id": session_id},
    )
    return {"success": True, "session": updated}


@router.post("/projects/{project_id}/sessions/{session_id}/end")
def end_session(
    project_id: int, session_id: int, _current_user: Dict[str, Any] = Depends(require_auth)
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    session = fetch_one(
        """
        SELECT session_id FROM cat_annotation_sessions
        WHERE project_id = :project_id AND session_id = :session_id
        """,
        {"project_id": project_id, "session_id": session_id},
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    execute(
        """
        UPDATE cat_annotation_sessions
        SET is_active = 0,
            end_time = CURRENT_TIMESTAMP
        WHERE project_id = :project_id AND session_id = :session_id
        """,
        {"project_id": project_id, "session_id": session_id},
    )

    updated = fetch_one(
        "SELECT * FROM cat_annotation_sessions WHERE project_id = :project_id AND session_id = :session_id",
        {"project_id": project_id, "session_id": session_id},
    )
    return {"success": True, "session": updated}


@router.post("/projects/{project_id}/sessions/{session_id}/heartbeat")
def session_heartbeat(
    project_id: int, session_id: int, _current_user: Dict[str, Any] = Depends(require_auth)
) -> Dict[str, Any]:
    """Keep a session alive — call every ~5 minutes to prevent stale-session cleanup (4c)."""
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "editor")

    execute(
        """
        UPDATE cat_annotation_sessions
        SET last_heartbeat = CURRENT_TIMESTAMP
        WHERE project_id = :project_id AND session_id = :session_id AND is_active = 1
        """,
        {"project_id": project_id, "session_id": session_id},
    )
    return {"success": True, "session_id": session_id}


@router.get("/projects/{project_id}/sessions/stats")
def session_stats(
    project_id: int, username: Optional[str] = None, _current_user: Dict[str, Any] = Depends(require_auth)
) -> Dict[str, Any]:
    _ensure_oracle_mode()
    _require_project_role(project_id, _current_user, "viewer")

    if username:
        sql = """
            SELECT
                COUNT(*) AS session_count,
                NVL(SUM(total_seconds), 0) AS total_seconds,
                NVL(SUM(annotation_count), 0) AS annotation_count
            FROM cat_annotation_sessions
            WHERE project_id = :project_id AND username = :username
        """
        params = {"project_id": project_id, "username": username}
    else:
        sql = """
            SELECT
                COUNT(*) AS session_count,
                NVL(SUM(total_seconds), 0) AS total_seconds,
                NVL(SUM(annotation_count), 0) AS annotation_count
            FROM cat_annotation_sessions
            WHERE project_id = :project_id
        """
        params = {"project_id": project_id}

    totals = fetch_one(sql, params) or {"session_count": 0, "total_seconds": 0, "annotation_count": 0}

    return {
        "success": True,
        "project_id": project_id,
        "username": username,
        "stats": totals,
    }


# ---------------------------------------------------------------------------
# Team-lead compare view: several projects from the same site, layered.
# Read-only. Uses the same "all projects" visibility every signed-in user
# already has on the Project Manager.
# ---------------------------------------------------------------------------

@router.get("/compare/sites")
def compare_sites(current_user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    """Sites that have at least one project, with how many projects and
    annotations each has — the compare page's site picker."""
    _ensure_oracle_mode()
    rows = fetch_all(
        """
        SELECT UPPER(TRIM(p.site)) AS site,
               COUNT(DISTINCT p.project_id) AS project_count,
               COUNT(a.annotation_id) AS annotation_count
        FROM cat_projects p
        LEFT JOIN cat_annotations a ON a.project_id = p.project_id AND a.deleted_at IS NULL
        WHERE p.site IS NOT NULL AND TRIM(p.site) IS NOT NULL
        GROUP BY UPPER(TRIM(p.site))
        ORDER BY UPPER(TRIM(p.site))
        """
    )
    return {"success": True, "sites": rows}


@router.get("/compare/site-projects")
def compare_site_projects(site: str, current_user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    """Every project at one site, with its annotators (and their counts) and
    its imagery, so the page can layer them over one map."""
    _ensure_oracle_mode()
    site_key = (site or "").strip().upper()
    if not site_key:
        raise HTTPException(status_code=400, detail="site is required")

    projects = fetch_all(
        """
        SELECT p.project_id, p.project_name, p.site, p.year_num AS year, p.cruise, p.created_at,
               owner.display_name AS owner_display_name, owner.username AS owner_username
        FROM cat_projects p
        LEFT JOIN cat_users owner ON owner.user_id = p.owner_user_id
        WHERE UPPER(TRIM(p.site)) = :site
        ORDER BY p.year_num DESC NULLS LAST, p.created_at DESC
        """,
        {"site": site_key},
    )
    if not projects:
        return {"success": True, "site": site_key, "projects": []}

    ids = [p["project_id"] for p in projects]
    by_id = {p["project_id"]: dict(p, annotators=[], assets=[], annotation_count=0) for p in projects}

    # Chunked IN lists: Oracle caps them at 1000 expressions.
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        binds = {f"p{j}": pid for j, pid in enumerate(chunk)}
        in_sql = ", ".join(f":{k}" for k in binds)
        for row in fetch_all(
            f"""
            SELECT a.project_id,
                   a.created_by_user_id AS user_id,
                   NVL(u.display_name, NVL(u.username, NVL(a.created_by, 'Unknown'))) AS annotator,
                   COUNT(*) AS annotation_count
            FROM cat_annotations a
            LEFT JOIN cat_users u ON u.user_id = a.created_by_user_id
            WHERE a.project_id IN ({in_sql}) AND a.deleted_at IS NULL
            GROUP BY a.project_id, a.created_by_user_id,
                     NVL(u.display_name, NVL(u.username, NVL(a.created_by, 'Unknown')))
            ORDER BY COUNT(*) DESC
            """,
            binds,
        ):
            entry = by_id[row["project_id"]]
            entry["annotators"].append(
                {"user_id": row["user_id"], "annotator": row["annotator"], "annotation_count": row["annotation_count"]}
            )
            entry["annotation_count"] += int(row["annotation_count"] or 0)
        for row in fetch_all(
            f"""
            SELECT project_id, asset_id, asset_name, asset_type, cog_url
            FROM cat_project_assets
            WHERE project_id IN ({in_sql}) AND NVL(is_active, 1) = 1
            ORDER BY asset_id
            """,
            binds,
        ):
            by_id[row["project_id"]]["assets"].append(
                {k: row[k] for k in ("asset_id", "asset_name", "asset_type", "cog_url")}
            )

    return {"success": True, "site": site_key, "projects": [by_id[pid] for pid in ids]}


# ---------------------------------------------------------------------------
# Time & activity report: who spent how long on what, plus a friendly
# leaderboard. Read-only; same all-projects visibility as the project list.
# ---------------------------------------------------------------------------

def _activity_filters(project_id: Optional[int], site: Optional[str], days: Optional[int], alias: str, time_col: str):
    conds: List[str] = []
    params: Dict[str, Any] = {}
    if project_id is not None:
        conds.append(f"{alias}.project_id = :project_id")
        params["project_id"] = project_id
    if site and site.strip():
        conds.append("UPPER(TRIM(p.site)) = :site")
        params["site"] = site.strip().upper()
    if days:
        conds.append(f"{alias}.{time_col} >= SYSTIMESTAMP - NUMTODSINTERVAL(:days, 'DAY')")
        params["days"] = max(1, min(int(days), 3650))
    return (" AND " + " AND ".join(conds)) if conds else "", params


def _day_of(value: Any) -> Any:
    return value.date() if hasattr(value, "date") else str(value)[:10]


@router.get("/activity/report")
def activity_report(
    project_id: Optional[int] = None,
    site: Optional[str] = None,
    days: Optional[int] = None,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Time per annotator and project, recent sessions and leaderboards.

    Session time comes from cat_annotation_sessions (active time the page
    reports every minute); annotation counts from cat_annotations by the
    account that created them. Filters: one project, one site, last N days.
    """
    _ensure_oracle_mode()

    s_where, s_params = _activity_filters(project_id, site, days, "s", "start_time")
    sessions = fetch_all(
        f"""
        SELECT s.session_id, s.project_id, p.project_name, p.site, s.username,
               u.user_id, NVL(u.display_name, s.username) AS annotator,
               s.start_time, s.end_time, NVL(s.total_seconds, 0) AS total_seconds,
               NVL(s.annotation_count, 0) AS annotation_count, s.is_active, s.last_heartbeat
        FROM cat_annotation_sessions s
        JOIN cat_projects p ON p.project_id = s.project_id
        LEFT JOIN cat_users u ON LOWER(u.username) = LOWER(s.username)
        WHERE 1=1 {s_where}
        ORDER BY s.start_time DESC
        """,
        s_params,
    )

    # Who is annotating right now: a live session that reported in the last
    # 10 minutes (the page reports every minute while its timer runs).
    now_row = fetch_one(
        f"""
        SELECT COUNT(DISTINCT LOWER(s.username)) AS n
        FROM cat_annotation_sessions s
        JOIN cat_projects p ON p.project_id = s.project_id
        WHERE s.is_active = 1 AND s.last_heartbeat >= SYSTIMESTAMP - INTERVAL '10' MINUTE {s_where}
        """,
        s_params,
    ) or {}
    active_now = int(now_row.get("n") or 0)
    # Every page load opens a session; ones that never recorded any time
    # (quick look, reload) would only pad counts and averages.
    sessions = [s for s in sessions if int(s.get("total_seconds") or 0) > 0 or s.get("is_active") == 1]

    a_where, a_params = _activity_filters(project_id, site, days, "a", "created_at")
    created = fetch_all(
        f"""
        SELECT a.project_id, p.project_name, p.site, a.created_by_user_id AS user_id,
               NVL(u.display_name, NVL(u.username, NVL(a.created_by, 'Unknown'))) AS annotator,
               COUNT(*) AS annotations,
               COUNT(DISTINCT TRUNC(a.created_at)) AS days_active,
               MAX(a.created_at) AS last_created
        FROM cat_annotations a
        JOIN cat_projects p ON p.project_id = a.project_id
        LEFT JOIN cat_users u ON u.user_id = a.created_by_user_id
        WHERE a.deleted_at IS NULL {a_where}
        GROUP BY a.project_id, p.project_name, p.site, a.created_by_user_id,
                 NVL(u.display_name, NVL(u.username, NVL(a.created_by, 'Unknown')))
        """,
        a_params,
    )

    # Distinct calendar days each person created annotations on (across all
    # projects in scope; summing per-project counts would double-count days).
    days_by_user: Dict[Any, int] = {}
    for row in fetch_all(
        f"""
        SELECT a.created_by_user_id AS user_id, COUNT(DISTINCT TRUNC(a.created_at)) AS days_active
        FROM cat_annotations a
        JOIN cat_projects p ON p.project_id = a.project_id
        WHERE a.deleted_at IS NULL {a_where}
        GROUP BY a.created_by_user_id
        """,
        a_params,
    ):
        days_by_user[row["user_id"]] = int(row["days_active"] or 0)

    # Distinct species per annotator needs JSON_VALUE over the properties
    # CLOB, which is not available on every Oracle setup: optional extra.
    species_by_user: Dict[Any, int] = {}
    try:
        for row in fetch_all(
            f"""
            SELECT a.created_by_user_id AS user_id,
                   COUNT(DISTINCT UPPER(TRIM(JSON_VALUE(a.properties_json, '$.spcode')))) AS species
            FROM cat_annotations a
            JOIN cat_projects p ON p.project_id = a.project_id
            WHERE a.deleted_at IS NULL {a_where}
            GROUP BY a.created_by_user_id
            """,
            a_params,
        ):
            species_by_user[row["user_id"]] = int(row["species"] or 0)
    except Exception as exc:  # depends on DB features
        logger.info("Species-variety stat unavailable: %s", exc)

    # ---- per annotator ----------------------------------------------------
    people: Dict[str, Dict[str, Any]] = {}

    def person(user_id: Any, name: str) -> Dict[str, Any]:
        key = f"u{user_id}" if user_id is not None else f"n{(name or 'Unknown').lower()}"
        if key not in people:
            people[key] = {
                "user_id": user_id, "annotator": name or "Unknown", "total_seconds": 0, "sessions": 0,
                "longest_session_seconds": 0, "annotations": 0, "projects": set(), "session_days": set(),
                "annotation_days": 0, "last_active": None, "species": species_by_user.get(user_id),
            }
        return people[key]

    def later(a: Any, b: Any) -> Any:
        if a is None:
            return b
        if b is None:
            return a
        return a if a >= b else b

    for s in sessions:
        p = person(s["user_id"], s["annotator"])
        secs = int(s["total_seconds"] or 0)
        p["total_seconds"] += secs
        p["sessions"] += 1 if secs > 0 else 0  # a live session with no time yet isn't counted in averages
        p["longest_session_seconds"] = max(p["longest_session_seconds"], secs)
        p["projects"].add(s["project_id"])
        if s.get("start_time") is not None and secs > 0:
            p["session_days"].add(_day_of(s["start_time"]))
        p["last_active"] = later(p["last_active"], s.get("last_heartbeat") or s.get("start_time"))
    for c in created:
        p = person(c["user_id"], c["annotator"])
        p["annotations"] += int(c["annotations"] or 0)
        p["annotation_days"] = days_by_user.get(c["user_id"], p["annotation_days"])
        p["projects"].add(c["project_id"])
        p["last_active"] = later(p["last_active"], c.get("last_created"))

    annotators = []
    for p in people.values():
        hours = p["total_seconds"] / 3600.0
        annotators.append({
            "user_id": p["user_id"],
            "annotator": p["annotator"],
            "total_seconds": p["total_seconds"],
            "sessions": p["sessions"],
            "avg_session_seconds": int(p["total_seconds"] / p["sessions"]) if p["sessions"] else 0,
            "longest_session_seconds": p["longest_session_seconds"],
            "annotations": p["annotations"],
            "annotations_per_hour": round(p["annotations"] / hours, 1) if hours >= 0.25 else None,
            "seconds_per_annotation": int(p["total_seconds"] / p["annotations"]) if p["annotations"] and p["total_seconds"] else None,
            "projects": len(p["projects"]),
            "days_active": max(len(p["session_days"]), p["annotation_days"]),
            "species": p["species"],
            "last_active": p["last_active"],
        })
    annotators.sort(key=lambda r: (r["total_seconds"], r["annotations"]), reverse=True)

    # ---- per project ------------------------------------------------------
    projects: Dict[int, Dict[str, Any]] = {}

    def project_row(pid: int, name: Any, site_name: Any) -> Dict[str, Any]:
        return projects.setdefault(pid, {"project_id": pid, "project_name": name, "site": site_name,
                                         "total_seconds": 0, "sessions": 0, "annotations": 0, "annotators": set()})

    for s in sessions:
        pr = project_row(s["project_id"], s["project_name"], s["site"])
        pr["total_seconds"] += int(s["total_seconds"] or 0)
        pr["sessions"] += 1
        pr["annotators"].add(s["annotator"])
    for c in created:
        pr = project_row(c["project_id"], c["project_name"], c["site"])
        pr["annotations"] += int(c["annotations"] or 0)
        pr["annotators"].add(c["annotator"])
    project_rows = []
    for pr in projects.values():
        row = dict(pr)
        row["annotators"] = sorted(a for a in pr["annotators"] if a)
        project_rows.append(row)
    project_rows.sort(key=lambda r: (r["total_seconds"], r["annotations"]), reverse=True)

    # ---- leaderboards -----------------------------------------------------
    def top(key: str, label: str, fmt: str, min_filter=None, n: int = 5) -> Dict[str, Any]:
        pool = [a for a in annotators if a.get(key) and (min_filter is None or min_filter(a))]
        pool.sort(key=lambda a: a[key], reverse=True)
        return {"key": key, "label": label, "format": fmt,
                "entries": [{"annotator": a["annotator"], "value": a[key]} for a in pool[:n]]}

    leaderboards = [
        top("total_seconds", "⏱️ Most time annotating", "duration"),
        top("annotations", "🪸 Most annotations", "count"),
        top("annotations_per_hour", "⚡ Fastest pace (annotations / hour)", "rate",
            min_filter=lambda a: a["annotations"] >= 10),
        top("longest_session_seconds", "🏃 Longest single session", "duration"),
        top("species", "🔎 Most species recorded", "count"),
        top("days_active", "📅 Most days active", "count"),
        top("projects", "🗺️ Most projects worked on", "count"),
    ]

    return jsonable_encoder({
        "success": True,
        "filters": {"project_id": project_id, "site": site, "days": days},
        "totals": {
            "total_seconds": sum(a["total_seconds"] for a in annotators),
            "annotations": sum(a["annotations"] for a in annotators),
            "sessions": len(sessions),
            "annotators": len(annotators),
            "projects": len(project_rows),
            "active_now": active_now,
        },
        "annotators": annotators,
        "projects": project_rows,
        "leaderboards": leaderboards,
        "recent_sessions": [
            {k: s.get(k) for k in ("session_id", "project_id", "project_name", "site", "annotator", "start_time",
                                   "end_time", "total_seconds", "annotation_count", "is_active")}
            for s in sessions[:100]
        ],
    })

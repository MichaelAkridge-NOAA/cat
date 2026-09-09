"""Oracle-backed project API for CAT."""

from datetime import datetime
import json
import tempfile
import zipfile
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field

from cat.api.auth import require_auth
from cat.db import auth as auth_db
from cat.db.config import is_oracle_backend_enabled
from cat.db.oracle import execute, execute_returning_id, execute_many, fetch_all, fetch_one, test_connection, get_connection
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
    cat_project_collaborators. Returns None if the project doesn't exist or
    the caller has no access to it."""
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
    return collab["role"] if collab else None


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
    normalized["geometry"] = feature
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
def db_bootstrap() -> Dict[str, Any]:
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

    scope = (scope or "mine").strip()
    if scope == "all":
        pass
    elif scope.startswith("user:"):
        try:
            owner_id = int(scope.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid scope: expected 'user:<id>'")
        filter_params["owner_user_id"] = owner_id
        conditions.append("owner_user_id = :owner_user_id")
    else:
        filter_params["owner_user_id"] = current_user["user_id"]
        # "mine" includes projects I own AND projects I'm a collaborator on.
        conditions.append(
            """
            (owner_user_id = :owner_user_id OR project_id IN (
                SELECT project_id FROM cat_project_collaborators WHERE user_id = :owner_user_id
            ))
            """
        )
        scope = "mine"

    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_sql = f"SELECT COUNT(*) AS total_count FROM cat_projects {where_sql}"
    count_row = fetch_one(count_sql, filter_params)
    total_count = int((count_row or {}).get("total_count") or 0)

    # Owner display info is joined outside the paged subquery so the WHERE/
    # ORDER BY clauses above (unqualified column names, shared with the count
    # query) don't need touching, and so cat_users.created_at can't collide
    # with cat_projects.created_at under SELECT *.
    sql = """
        SELECT p.*, u.display_name AS owner_display_name, u.username AS owner_username
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
    rows = fetch_all(sql, {**filter_params, "limit": limit, "offset": offset})
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
        "scope": scope,
        "projects": [_normalize_project_row(r) for r in rows],
    }


@router.get("/projects/{project_id}")
def get_project(project_id: int) -> Dict[str, Any]:
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
    return {
        "success": True,
        "project": _normalize_project_row(project),
        "assets": [_normalize_asset_row(a) for a in assets],
    }


@router.get("/projects/{project_id}/snapshot")
def get_project_snapshot(project_id: int, include_annotations: bool = True) -> Dict[str, Any]:
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
            "SELECT * FROM cat_annotations WHERE project_id = :project_id AND deleted_at IS NULL ORDER BY created_at ASC",
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
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    existing = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_project_role(project_id, current_user, "owner")

    execute("DELETE FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    return {"success": True, "deleted_project_id": project_id}


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


@router.post("/projects/{project_id}/assets")
def add_project_asset(
    project_id: int,
    payload: AssetCreate,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

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

    created_by = payload.created_by or current_user.get("display_name")

    sql = """
        INSERT INTO cat_annotations (
            project_id, asset_id, feature_geojson, properties_json, created_by, created_by_user_id
        ) VALUES (
            :project_id, :asset_id, :feature_geojson, :properties_json, :created_by, :created_by_user_id
        ) RETURNING annotation_id INTO :annotation_id
    """

    annotation_id = execute_returning_id(
        sql,
        {
            "project_id": project_id,
            "asset_id": payload.asset_id,
            "feature_geojson": json.dumps(payload.feature),
            "properties_json": json.dumps(payload.properties),
            "created_by": created_by,
            "created_by_user_id": current_user["user_id"],
        },
        id_column="annotation_id",
    )

    row = fetch_one(
        "SELECT * FROM cat_annotations WHERE annotation_id = :annotation_id",
        {"annotation_id": annotation_id},
    )
    _log_activity(project_id, current_user["user_id"], "annotation_created", {"annotation_id": annotation_id})
    return {"success": True, "annotation": _normalize_annotation_row(row)}


@router.get("/projects/{project_id}/annotations")
def list_annotations(project_id: int, limit: int = 500, offset: int = 0) -> Dict[str, Any]:
    _ensure_oracle_mode()

    sql = """
        SELECT *
        FROM cat_annotations
        WHERE project_id = :project_id AND deleted_at IS NULL
        ORDER BY created_at ASC
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
        SELECT annotation_id, version
        FROM cat_annotations
        WHERE project_id = :project_id AND annotation_id = :annotation_id AND deleted_at IS NULL
        """,
        {"project_id": project_id, "annotation_id": annotation_id},
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Annotation not found")
    _require_project_role(project_id, current_user, "editor")

    # Optimistic locking: if client sends a version, verify it matches (4a)
    if payload.version is not None:
        current_version = existing.get("version") or 1
        if payload.version != current_version:
            current_row = fetch_one(
                "SELECT * FROM cat_annotations WHERE annotation_id = :annotation_id",
                {"annotation_id": annotation_id},
            )
            # Task 7 round 2 fix: HTTPException.detail is passed straight to
            # json.dumps() by Starlette's default exception handler (unlike a
            # normal route return value, which FastAPI runs through
            # jsonable_encoder). current_annotation carries raw datetime
            # columns (created_at/updated_at), which made json.dumps() blow up
            # with "Object of type datetime is not JSON serializable" — the
            # client saw a 500, never the intended 409, so conflict recovery
            # could never run.
            raise HTTPException(
                status_code=409,
                detail=jsonable_encoder({
                    "message": "Version conflict — annotation was modified by another session",
                    "current_version": current_version,
                    "client_version": payload.version,
                    "current_annotation": _normalize_annotation_row(current_row) if current_row else None,
                }),
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
        execute(
            f"UPDATE cat_annotations SET {', '.join(fields)} WHERE project_id = :project_id AND annotation_id = :annotation_id",
            params,
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

    execute(
        """
        UPDATE cat_annotations
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE project_id = :project_id AND annotation_id = :annotation_id
        """,
        {"project_id": project_id, "annotation_id": annotation_id},
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

    execute(
        """
        UPDATE cat_annotations
        SET deleted_at = NULL
        WHERE project_id = :project_id AND annotation_id = :annotation_id
        """,
        {"project_id": project_id, "annotation_id": annotation_id},
    )
    row = fetch_one(
        "SELECT * FROM cat_annotations WHERE annotation_id = :annotation_id",
        {"annotation_id": annotation_id},
    )
    return {"success": True, "annotation": _normalize_annotation_row(row)}


@router.post("/projects/{project_id}/annotations/bulk-replace")
def bulk_replace_annotations(
    project_id: int,
    payload: AnnotationBulkReplace,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _require_project_role(project_id, current_user, "editor")

    insert_sql = """
        INSERT INTO cat_annotations (
            project_id, asset_id, feature_geojson, properties_json, created_by, created_by_user_id
        ) VALUES (
            :project_id, :asset_id, :feature_geojson, :properties_json, :created_by, :created_by_user_id
        )
    """

    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM cat_annotations WHERE project_id = :project_id", {"project_id": project_id})

            for ann in payload.annotations:
                cursor.execute(
                    insert_sql,
                    {
                        "project_id": project_id,
                        "asset_id": ann.asset_id,
                        "feature_geojson": json.dumps(ann.feature),
                        "properties_json": json.dumps(ann.properties),
                        "created_by": ann.created_by or current_user.get("display_name"),
                        "created_by_user_id": current_user["user_id"],
                    },
                )
        conn.commit()

    rows = fetch_all(
        "SELECT * FROM cat_annotations WHERE project_id = :project_id ORDER BY created_at ASC",
        {"project_id": project_id},
    )
    normalized = [_normalize_annotation_row(r) for r in rows]
    _log_activity(project_id, current_user["user_id"], "annotations_bulk_replaced", {"count": len(normalized)})
    return {"success": True, "count": len(normalized), "annotations": normalized}


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
            project_id, asset_id, feature_geojson, properties_json, created_by, created_by_user_id
        ) VALUES (
            :project_id, :asset_id, :feature_geojson, :properties_json, :created_by, :created_by_user_id
        ) RETURNING annotation_id INTO :annotation_id
    """

    # Each insert uses its own execute_returning_id() call (own connection +
    # commit) rather than one shared cursor/transaction like bulk-replace,
    # because this endpoint is purely additive: inserts are independent of
    # each other, so a partial failure mid-batch (some AI detections saved,
    # others not) is acceptable here — there's no destructive step (no
    # DELETE) that a shared transaction would need to protect.
    inserted_ids: List[int] = []
    for ann in payload.annotations:
        annotation_id = execute_returning_id(
            insert_sql,
            {
                "project_id": project_id,
                "asset_id": ann.asset_id,
                "feature_geojson": json.dumps(ann.feature),
                "properties_json": json.dumps(ann.properties),
                "created_by": ann.created_by or current_user.get("display_name"),
                "created_by_user_id": current_user["user_id"],
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
def annotations_geojson(project_id: int) -> Dict[str, Any]:
    _ensure_oracle_mode()

    rows = fetch_all(
        "SELECT * FROM cat_annotations WHERE project_id = :project_id AND deleted_at IS NULL ORDER BY created_at ASC",
        {"project_id": project_id},
    )

    features = []
    for row in rows:
        normalized = _normalize_annotation_row(row)
        features.append(
            {
                "type": "Feature",
                "geometry": normalized.get("feature"),
                "properties": {
                    "annotation_id": normalized.get("annotation_id"),
                    **(normalized.get("properties") or {}),
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


def aggregate_annotations(project_ids: List[int]) -> Dict[str, Any]:
    """Aggregate non-deleted annotations across one or more projects.

    Signature takes a list of project ids on purpose: a future cross-site
    rollup will call this with many ids. Returns every report field except
    project_id/project_name (the endpoint layers those on). Per-row parsing is
    fully defensive — a single malformed annotation is counted toward
    annotation_count but can never abort or 500 the whole report.
    """
    empty: Dict[str, Any] = {
        "annotation_count": 0,
        "by_species": [],
        "by_condition": [],
        "by_shape_type": [],
        "total_area": {"value": 0.0, "unit": "relative", "computable_count": 0, "missing_count": 0},
        "total_length": {"value": 0.0, "unit": "relative", "computable_count": 0, "missing_count": 0},
        "missing_fields": {"spcode": 0, "con_1": 0},
    }
    if not project_ids:
        return empty

    # Safe IN-clause: one bind per id (:pid0, :pid1, …) — never string-interpolate ids.
    id_binds = {f"pid{i}": pid for i, pid in enumerate(project_ids)}
    in_clause = ", ".join(f":{k}" for k in id_binds)

    rows = fetch_all(
        "SELECT feature_geojson, properties_json FROM cat_annotations "
        f"WHERE project_id IN ({in_clause}) AND deleted_at IS NULL",
        id_binds,
    )

    # Species lookup {spcode: {"name": taxon_name, "genus": genus}}. The table
    # may be empty; unknown/absent spcodes fall back to the code as the name.
    species_lookup: Dict[str, Dict[str, Any]] = {}
    try:
        for s in fetch_all("SELECT spcode, taxon_name, genus FROM cat_coral_species"):
            code = s.get("spcode")
            if code:
                species_lookup[code] = {"name": s.get("taxon_name"), "genus": s.get("genus")}
    except Exception:
        species_lookup = {}

    # --- Area unit decision (deliberate; see note) -------------------------
    # A metric (m^2) area is only honest when the source raster is truly
    # georeferenced AND the stored coordinates are real lng/lat degrees. The QA
    # fixture (and any LOCAL_CS COG) has a NULL/unknown asset EPSG, so its
    # coordinates are relabeled pixel space — a computed m^2 would be
    # meaningless. We therefore default to a planar shoelace area in the raw
    # coordinate units labeled unit="relative", and only switch to a spherical
    # geodesic area in m^2 when the active asset carries a trustworthy
    # geographic EPSG (4326 = true lng/lat degrees). We never present a
    # possibly-wrong m^2. Projected EPSGs are left as "relative" here because we
    # cannot reliably tell (without pyproj) whether the stored coords are meters
    # or degrees.
    area_unit = "relative"
    geographic = False
    try:
        asset_rows = fetch_all(
            "SELECT source_epsg, target_epsg FROM cat_project_assets "
            f"WHERE project_id IN ({in_clause}) AND NVL(is_active, 1) = 1",
            id_binds,
        )
        # Resolve ONE epsg per active asset (prefer target, then source). An
        # asset with no resolvable epsg disqualifies the whole set: going metric
        # requires EVERY active asset to be trustworthy geographic, otherwise a
        # mixed project (one 4326 asset + one null/pixel-space asset) — or a
        # future multi-project rollup — would mislabel pixel areas as m^2.
        def _resolve_epsg(a):
            for key in ("target_epsg", "source_epsg"):
                v = a.get(key)
                if v is not None:
                    try:
                        return int(v)
                    except (TypeError, ValueError):
                        pass
            return None
        resolved = [_resolve_epsg(a) for a in asset_rows]
        if resolved and all(e == 4326 for e in resolved):
            area_unit = "m^2"
            geographic = True
    except Exception:
        area_unit = "relative"
        geographic = False

    species_counts: Dict[str, int] = {}
    condition_counts: Dict[str, int] = {}
    shape_counts: Dict[str, int] = {}
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

    length_unit = "m" if geographic else "relative"

    return {
        "annotation_count": len(rows) - derived_row_count,
        "by_species": by_species,
        "by_condition": by_condition,
        "by_shape_type": by_shape_type,
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
def project_report(project_id: int) -> Dict[str, Any]:
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


@router.post("/projects/{project_id}/overlay-layers")
def create_overlay_layer(
    project_id: int,
    payload: OverlayLayerCreate,
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    _ensure_oracle_mode()

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
def list_overlay_layers(project_id: int) -> Dict[str, Any]:
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
            execute_many(
                """
                INSERT INTO cat_overlay_features (layer_id, feature_geojson, properties_json)
                VALUES (:layer_id, :feature_geojson, :properties_json)
                """,
                rows,
            )

        layer = fetch_one("SELECT * FROM cat_overlay_layers WHERE layer_id = :layer_id", {"layer_id": layer_id})
        return _normalize_layer_row(layer)

    stamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    transect_layer = _create_layer(
        f"Transect ({stamp})",
        "transect",
        {"color": "#ff8c00", "weight": 3, "opacity": 0.9},
        transect_features,
    )
    segment_layer = _create_layer(
        f"Segments ({stamp})",
        "segment",
        {"color": "#1e90ff", "weight": 1, "opacity": 0.8, "fillOpacity": 0.25},
        segment_features,
    )

    return {"success": True, "transect_layer": transect_layer, "segment_layer": segment_layer}


@router.post("/projects/{project_id}/overlay-layers/{layer_id}/features")
def create_overlay_feature(
    project_id: int,
    layer_id: int,
    payload: OverlayFeatureCreate,
    _current_user: Dict[str, Any] = Depends(require_auth),
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
def list_overlay_features(project_id: int, layer_id: int) -> Dict[str, Any]:
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

    new_layer_name = payload.new_layer_name or f"{layer['layer_name']} (buffered {payload.distance_m}m)"
    new_layer_id = execute_returning_id(
        """
        INSERT INTO cat_overlay_layers (project_id, layer_name, layer_type, style_json)
        VALUES (:project_id, :layer_name, 'derived', :style_json)
        RETURNING layer_id INTO :layer_id
        """,
        {"project_id": project_id, "layer_name": new_layer_name, "style_json": json.dumps({})},
        id_column="layer_id",
    )

    buffered_count = 0
    for row in rows:
        try:
            geom_dict = _parse_json_field(row.get("feature_geojson"), default=None)
            if not geom_dict:
                continue
            geom = shape(geom_dict)
            centroid = geom.centroid
            utm_epsg = _utm_epsg_for_lonlat(centroid.x, centroid.y)
            to_utm = Transformer.from_crs(4326, utm_epsg, always_xy=True)
            to_wgs84 = Transformer.from_crs(utm_epsg, 4326, always_xy=True)
            buffered_utm = shapely_transform(to_utm.transform, geom).buffer(payload.distance_m)
            buffered_wgs84 = shapely_transform(to_wgs84.transform, buffered_utm)

            execute(
                """
                INSERT INTO cat_overlay_features (layer_id, feature_geojson, properties_json)
                VALUES (:layer_id, :feature_geojson, :properties_json)
                """,
                {
                    "layer_id": new_layer_id,
                    "feature_geojson": json.dumps(mapping(buffered_wgs84)),
                    "properties_json": row.get("properties_json"),
                },
            )
            buffered_count += 1
        except Exception:
            continue

    _log_activity(project_id, current_user["user_id"], "overlay_layer_buffered",
                  {"source_layer_id": layer_id, "new_layer_id": new_layer_id, "distance_m": payload.distance_m})
    new_layer = fetch_one("SELECT * FROM cat_overlay_layers WHERE layer_id = :layer_id", {"layer_id": new_layer_id})
    return {"success": True, "layer": _normalize_layer_row(new_layer), "feature_count": buffered_count}


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

    new_layer_name = payload.new_layer_name or f"{layer['layer_name']} (clipped)"
    new_layer_id = execute_returning_id(
        """
        INSERT INTO cat_overlay_layers (project_id, layer_name, layer_type, style_json)
        VALUES (:project_id, :layer_name, 'derived', :style_json)
        RETURNING layer_id INTO :layer_id
        """,
        {"project_id": project_id, "layer_name": new_layer_name, "style_json": json.dumps({})},
        id_column="layer_id",
    )

    clipped_count = 0
    for row in source_rows:
        try:
            geom_dict = _parse_json_field(row.get("feature_geojson"), default=None)
            if not geom_dict:
                continue
            intersection = shape(geom_dict).intersection(clip_union)
            if intersection.is_empty:
                continue
            execute(
                """
                INSERT INTO cat_overlay_features (layer_id, feature_geojson, properties_json)
                VALUES (:layer_id, :feature_geojson, :properties_json)
                """,
                {
                    "layer_id": new_layer_id,
                    "feature_geojson": json.dumps(mapping(intersection)),
                    "properties_json": row.get("properties_json"),
                },
            )
            clipped_count += 1
        except Exception:
            continue

    _log_activity(project_id, current_user["user_id"], "overlay_layer_clipped",
                  {"source_layer_id": layer_id, "clip_layer_id": payload.clip_layer_id, "new_layer_id": new_layer_id})
    new_layer = fetch_one("SELECT * FROM cat_overlay_layers WHERE layer_id = :layer_id", {"layer_id": new_layer_id})
    return {"success": True, "layer": _normalize_layer_row(new_layer), "feature_count": clipped_count}


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

            # Bulk import features
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

            return {
                "success": True,
                "layer_id": layer_id,
                "layer_name": layer_name,
                "feature_count": len(features_data),
                "source_epsg": source_epsg,
                "message": f"Imported {len(features_data)} features from {layer_name}"
            }

    except Exception as e:
        import traceback
        raise HTTPException(status_code=500, detail=f"Error processing shapefile: {str(e)}\n{traceback.format_exc()}")


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
        import traceback
        raise HTTPException(status_code=500, detail=f"Error processing shapefile files: {str(e)}\n{traceback.format_exc()}")


@router.put("/projects/{project_id}/overlay-layers/{layer_id}")
def update_overlay_layer(
    project_id: int,
    layer_id: int,
    payload: Dict[str, Any],
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Update overlay layer metadata (name, style, is_active, display_order)"""
    _ensure_oracle_mode()

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
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Update an overlay feature's geometry and/or properties.
    
    Accepts JSON body with optional keys:
      - feature: GeoJSON geometry object (or full Feature)
      - properties: dict of updated properties
    """
    _ensure_oracle_mode()

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
        else:
            # Caller sent just the geometry
            feature_obj = {"type": "Feature", "geometry": geom, "properties": payload.get("properties", {})}
            update_fields.append("feature_geojson = :feature_geojson")
            params["feature_geojson"] = json.dumps(feature_obj)

    if "properties" in payload:
        update_fields.append("properties_json = :properties_json")
        params["properties_json"] = json.dumps(payload["properties"])

    if not update_fields:
        return {"success": True, "message": "No fields to update"}

    sql = f"UPDATE cat_overlay_features SET {', '.join(update_fields)} WHERE feature_id = :feature_id"
    execute(sql, params)

    return {"success": True, "feature_id": feature_id, "message": "Feature updated"}


@router.put("/projects/{project_id}/overlay-layers/reorder")
def reorder_overlay_layers(
    project_id: int,
    payload: Dict[str, Any],
    _current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    """Reorder overlay layers by updating display_order"""
    _ensure_oracle_mode()

    # Expect payload: {"layer_orders": [{"layer_id": 1, "display_order": 0}, ...]}
    layer_orders = payload.get("layer_orders", [])
    
    if not layer_orders:
        raise HTTPException(status_code=400, detail="No layer orders provided")

    # Update each layer's display_order
    for item in layer_orders:
        execute(
            "UPDATE cat_overlay_layers SET display_order = :display_order WHERE project_id = :project_id AND layer_id = :layer_id",
            {
                "project_id": project_id,
                "layer_id": item["layer_id"],
                "display_order": item["display_order"]
            }
        )

    return {"success": True, "updated_count": len(layer_orders)}


@router.post("/projects/{project_id}/sessions/start")
def start_session(project_id: int, payload: SessionStart) -> Dict[str, Any]:
    _ensure_oracle_mode()

    project = fetch_one("SELECT project_id FROM cat_projects WHERE project_id = :project_id", {"project_id": project_id})
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

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
        {"project_id": project_id, "username": payload.username},
    )

    session_id = execute_returning_id(
        """
        INSERT INTO cat_annotation_sessions (
            project_id, username, is_active
        ) VALUES (
            :project_id, :username, 1
        ) RETURNING session_id INTO :session_id
        """,
        {"project_id": project_id, "username": payload.username},
        id_column="session_id",
    )

    session = fetch_one("SELECT * FROM cat_annotation_sessions WHERE session_id = :session_id", {"session_id": session_id})
    return {"success": True, "session": session}


@router.put("/projects/{project_id}/sessions/{session_id}")
def update_session(project_id: int, session_id: int, payload: SessionUpdate) -> Dict[str, Any]:
    _ensure_oracle_mode()

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
def end_session(project_id: int, session_id: int) -> Dict[str, Any]:
    _ensure_oracle_mode()

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
def session_heartbeat(project_id: int, session_id: int) -> Dict[str, Any]:
    """Keep a session alive — call every ~5 minutes to prevent stale-session cleanup (4c)."""
    _ensure_oracle_mode()

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
def session_stats(project_id: int, username: Optional[str] = None) -> Dict[str, Any]:
    _ensure_oracle_mode()

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

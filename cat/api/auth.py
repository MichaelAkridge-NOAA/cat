"""User login/session API for CAT (Oracle mode only)."""

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field

from cat.db import auth as auth_db
from cat.db.config import get_auth_settings, is_oracle_backend_enabled

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _ensure_oracle_mode() -> None:
    if not is_oracle_backend_enabled():
        raise HTTPException(
            status_code=400,
            detail="Oracle backend not enabled. Set CAT_STORAGE_BACKEND=oracle",
        )


def _public_user(user: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "user_id": user["user_id"],
        "username": user["username"],
        "email": user["email"],
        "display_name": user.get("display_name"),
        "first_name": user.get("first_name"),
        "last_name": user.get("last_name"),
        "initials": user.get("initials"),
        "role": user["role"],
    }


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SignupRequest(BaseModel):
    username: str = Field(min_length=3, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    first_name: Optional[str] = Field(default=None, max_length=120)
    last_name: Optional[str] = Field(default=None, max_length=120)
    initials: Optional[str] = Field(default=None, max_length=10)
    display_name: Optional[str] = Field(default=None, max_length=120)


class LoginRequest(BaseModel):
    username: str
    password: str


class PreferencesUpdate(BaseModel):
    preferences: Dict[str, Any] = Field(default_factory=dict)
    display_name: Optional[str] = Field(default=None, max_length=120)
    first_name: Optional[str] = Field(default=None, max_length=120)
    last_name: Optional[str] = Field(default=None, max_length=120)
    initials: Optional[str] = Field(default=None, max_length=10)


class PasswordChangeRequest(BaseModel):
    old_password: str
    new_password: str = Field(min_length=8, max_length=128)


class AdminUserUpdate(BaseModel):
    role: Optional[str] = None
    is_active: Optional[bool] = None
    display_name: Optional[str] = Field(default=None, max_length=120)
    first_name: Optional[str] = Field(default=None, max_length=120)
    last_name: Optional[str] = Field(default=None, max_length=120)
    initials: Optional[str] = Field(default=None, max_length=10)


class AdminPasswordReset(BaseModel):
    new_password: str = Field(min_length=8, max_length=128)


# ---------------------------------------------------------------------------
# Auth dependencies
# ---------------------------------------------------------------------------

def get_current_user(request: Request) -> Optional[Dict[str, Any]]:
    if not is_oracle_backend_enabled():
        return None
    cookie_name = get_auth_settings().session_cookie_name
    token = request.cookies.get(cookie_name)
    if not token:
        return None
    return auth_db.validate_session(token)


def require_auth(current_user: Optional[Dict[str, Any]] = Depends(get_current_user)) -> Dict[str, Any]:
    if current_user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return current_user


def require_admin(current_user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    if current_user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return current_user


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/signup")
def signup(payload: SignupRequest) -> Dict[str, Any]:
    _ensure_oracle_mode()
    try:
        user = auth_db.create_user(
            username=payload.username,
            email=payload.email,
            password=payload.password,
            display_name=payload.display_name,
            first_name=payload.first_name,
            last_name=payload.last_name,
            initials=payload.initials,
            role="annotator",
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"success": True, "user": _public_user(user)}


@router.post("/login")
def login(payload: LoginRequest, response: Response) -> Dict[str, Any]:
    _ensure_oracle_mode()
    auth_db.purge_expired_sessions()

    user = auth_db.get_user_by_username(payload.username)
    if user is None or not user["is_active"] or not auth_db.verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    auth_settings = get_auth_settings()
    raw_token = auth_db.create_session(user["user_id"], ttl_hours=auth_settings.session_max_age_hours)
    auth_db.update_last_login(user["user_id"])

    response.set_cookie(
        key=auth_settings.session_cookie_name,
        value=raw_token,
        httponly=True,
        samesite="lax",
        secure=auth_settings.session_cookie_secure,
        max_age=auth_settings.session_max_age_hours * 3600,
        path="/",
    )
    return {"success": True, "user": _public_user(user)}


@router.post("/logout")
def logout(request: Request, response: Response) -> Dict[str, Any]:
    auth_settings = get_auth_settings()
    token = request.cookies.get(auth_settings.session_cookie_name)
    if is_oracle_backend_enabled() and token:
        auth_db.delete_session(token)
    response.delete_cookie(key=auth_settings.session_cookie_name, path="/")
    return {"success": True}


@router.get("/me")
def me(current_user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    preferences = auth_db.get_preferences(current_user["user_id"])
    return {"success": True, "user": _public_user(current_user), "preferences": preferences}


@router.put("/preferences")
def put_preferences(
    payload: PreferencesUpdate,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    preferences = auth_db.update_preferences(current_user["user_id"], payload.preferences)
    auth_db.update_profile(
        current_user["user_id"],
        display_name=payload.display_name,
        first_name=payload.first_name,
        last_name=payload.last_name,
        initials=payload.initials,
    )
    return {"success": True, "preferences": preferences}


@router.put("/password")
def put_password(
    payload: PasswordChangeRequest,
    current_user: Dict[str, Any] = Depends(require_auth),
) -> Dict[str, Any]:
    ok = auth_db.change_own_password(current_user["user_id"], payload.old_password, payload.new_password)
    if not ok:
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    return {"success": True}


# ---------------------------------------------------------------------------
# Admin user management
# ---------------------------------------------------------------------------

@router.get("/admin/users")
def admin_list_users(_admin: Dict[str, Any] = Depends(require_admin)) -> Dict[str, Any]:
    users = auth_db.list_users()
    return {"success": True, "users": [_public_user(u) | {"is_active": bool(u["is_active"]), "last_login": u.get("last_login")} for u in users]}


@router.put("/admin/users/{user_id}")
def admin_update_user(
    user_id: int,
    payload: AdminUserUpdate,
    _admin: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    if auth_db.get_user_by_id(user_id) is None:
        raise HTTPException(status_code=404, detail="User not found")
    if payload.role is not None:
        try:
            auth_db.set_user_role(user_id, payload.role)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    if payload.is_active is not None:
        auth_db.set_user_active(user_id, payload.is_active)
    auth_db.update_profile(
        user_id,
        display_name=payload.display_name,
        first_name=payload.first_name,
        last_name=payload.last_name,
        initials=payload.initials,
    )
    return {"success": True, "user": _public_user(auth_db.get_user_by_id(user_id))}


@router.post("/admin/users/{user_id}/reset-password")
def admin_reset_password(
    user_id: int,
    payload: AdminPasswordReset,
    _admin: Dict[str, Any] = Depends(require_admin),
) -> Dict[str, Any]:
    if auth_db.get_user_by_id(user_id) is None:
        raise HTTPException(status_code=404, detail="User not found")
    auth_db.admin_reset_password(user_id, payload.new_password)
    return {"success": True}

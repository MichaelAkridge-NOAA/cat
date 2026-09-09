"""Oracle-backed user accounts and sessions for CAT.

Public surface
--------------
Passwords: hash_password(), verify_password()
Users:     create_user(), get_user_by_id(), get_user_by_username(),
           get_user_by_email(), list_users(), set_user_role(),
           set_user_active(), admin_reset_password(), update_last_login(),
           get_preferences(), update_preferences(), change_own_password()
Sessions:  create_session(), validate_session(), delete_session(),
           purge_expired_sessions()

Only used when CAT_STORAGE_BACKEND=oracle. All access goes through
cat/db/oracle.py's execute()/execute_returning_id()/fetch_one()/fetch_all()
helpers — no raw oracledb calls, no ORM.
"""

import json
import secrets
from datetime import datetime, timedelta
from hashlib import sha256
from typing import Any, Dict, List, Optional

import bcrypt

from .oracle import execute, execute_returning_id, fetch_all, fetch_one

# Call bcrypt directly rather than through passlib's CryptContext: passlib's
# bcrypt backend probes the installed bcrypt module's version string to pick
# a code path, and that probe breaks against bcrypt>=4.1 with older passlib
# releases (confirmed empirically — passlib 1.7.4 + bcrypt 5.0 raises
# "password cannot be longer than 72 bytes" even on an already-truncated
# input, from a version-detection failure, not the truncation). ai4me_example
# hit the same class of bug and worked around it with a bcrypt<4.1 pin;
# calling bcrypt directly avoids depending on that pin ever being honored.
_BCRYPT_MAX_BYTES = 72


def hash_password(password: str) -> str:
    truncated = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    return bcrypt.hashpw(truncated, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    truncated = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    try:
        return bcrypt.checkpw(truncated, password_hash.encode("utf-8"))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# User CRUD
# ---------------------------------------------------------------------------

_USER_COLUMNS = (
    "user_id, username, email, password_hash, display_name, first_name, "
    "last_name, initials, role, is_active, preferences_json, created_at, last_login"
)
# Same columns, "u."-prefixed, for use in JOIN queries (e.g. validate_session) —
# derived from _USER_COLUMNS so a new cat_users column can't silently go
# missing from one query but not the other.
_USER_COLUMNS_PREFIXED = ", ".join(f"u.{c.strip()}" for c in _USER_COLUMNS.split(","))


def create_user(
    username: str,
    email: str,
    password: str,
    display_name: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    initials: Optional[str] = None,
    role: str = "annotator",
) -> Dict[str, Any]:
    if get_user_by_username(username) is not None:
        raise ValueError(f"Username already taken: {username}")
    if get_user_by_email(email) is not None:
        raise ValueError(f"Email already registered: {email}")

    if not display_name:
        full_name = " ".join(part for part in (first_name, last_name) if part)
        display_name = full_name or username

    user_id = execute_returning_id(
        """
        INSERT INTO cat_users (
            username, email, password_hash, display_name,
            first_name, last_name, initials, role
        )
        VALUES (
            :username, :email, :password_hash, :display_name,
            :first_name, :last_name, :initials, :role
        )
        RETURNING user_id INTO :user_id
        """,
        {
            "username": username,
            "email": email,
            "password_hash": hash_password(password),
            "display_name": display_name,
            "first_name": first_name,
            "last_name": last_name,
            "initials": initials,
            "role": role,
        },
        id_column="user_id",
    )
    return get_user_by_id(user_id)


def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    return fetch_one(
        f"SELECT {_USER_COLUMNS} FROM cat_users WHERE user_id = :user_id",
        {"user_id": user_id},
    )


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    return fetch_one(
        f"SELECT {_USER_COLUMNS} FROM cat_users WHERE username = :username",
        {"username": username},
    )


def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    return fetch_one(
        f"SELECT {_USER_COLUMNS} FROM cat_users WHERE email = :email",
        {"email": email},
    )


def list_users(limit: int = 200, offset: int = 0) -> List[Dict[str, Any]]:
    return fetch_all(
        f"""
        SELECT {_USER_COLUMNS} FROM cat_users
        ORDER BY created_at ASC
        OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY
        """,
        {"limit": limit, "offset": offset},
    )


def set_user_role(user_id: int, role: str) -> None:
    if role not in ("admin", "annotator"):
        raise ValueError(f"Invalid role: {role}")
    execute(
        "UPDATE cat_users SET role = :role WHERE user_id = :user_id",
        {"role": role, "user_id": user_id},
    )


def set_user_active(user_id: int, is_active: bool) -> None:
    execute(
        "UPDATE cat_users SET is_active = :is_active WHERE user_id = :user_id",
        {"is_active": 1 if is_active else 0, "user_id": user_id},
    )


def admin_reset_password(user_id: int, new_password: str) -> None:
    execute(
        "UPDATE cat_users SET password_hash = :password_hash WHERE user_id = :user_id",
        {"password_hash": hash_password(new_password), "user_id": user_id},
    )


def change_own_password(user_id: int, old_password: str, new_password: str) -> bool:
    user = get_user_by_id(user_id)
    if user is None or not verify_password(old_password, user["password_hash"]):
        return False
    admin_reset_password(user_id, new_password)
    return True


_PROFILE_FIELDS = ("display_name", "first_name", "last_name", "initials")


def update_profile(user_id: int, **fields: Optional[str]) -> None:
    """Update any of display_name/first_name/last_name/initials. Unset (None) keys are skipped."""
    updates = {k: v for k, v in fields.items() if k in _PROFILE_FIELDS and v is not None}
    if not updates:
        return
    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    execute(
        f"UPDATE cat_users SET {set_clause} WHERE user_id = :user_id",
        {**updates, "user_id": user_id},
    )


def update_last_login(user_id: int) -> None:
    execute(
        "UPDATE cat_users SET last_login = CURRENT_TIMESTAMP WHERE user_id = :user_id",
        {"user_id": user_id},
    )


def get_preferences(user_id: int) -> Dict[str, Any]:
    row = fetch_one(
        "SELECT preferences_json FROM cat_users WHERE user_id = :user_id",
        {"user_id": user_id},
    )
    if not row or not row.get("preferences_json"):
        return {}
    try:
        return json.loads(row["preferences_json"])
    except (TypeError, ValueError):
        return {}


def update_preferences(user_id: int, preferences: Dict[str, Any]) -> Dict[str, Any]:
    execute(
        "UPDATE cat_users SET preferences_json = :preferences_json WHERE user_id = :user_id",
        {"preferences_json": json.dumps(preferences), "user_id": user_id},
    )
    return preferences


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def _hash_token(raw_token: str) -> str:
    return sha256(raw_token.encode("utf-8")).hexdigest()


def create_session(user_id: int, ttl_hours: int = 24 * 7) -> str:
    raw_token = secrets.token_urlsafe(32)
    execute(
        """
        INSERT INTO cat_sessions (user_id, token_hash, expires_at)
        VALUES (:user_id, :token_hash, CURRENT_TIMESTAMP + NUMTODSINTERVAL(:ttl_hours, 'HOUR'))
        """,
        {"user_id": user_id, "token_hash": _hash_token(raw_token), "ttl_hours": ttl_hours},
    )
    return raw_token


_LAST_SEEN_REFRESH_INTERVAL = timedelta(minutes=5)


def validate_session(raw_token: str) -> Optional[Dict[str, Any]]:
    if not raw_token:
        return None
    row = fetch_one(
        f"""
        SELECT {_USER_COLUMNS_PREFIXED},
               s.session_id, s.expires_at, s.last_seen_at
        FROM cat_sessions s
        JOIN cat_users u ON u.user_id = s.user_id
        WHERE s.token_hash = :token_hash
          AND s.expires_at > CURRENT_TIMESTAMP
          AND u.is_active = 1
        """,
        {"token_hash": _hash_token(raw_token)},
    )
    if row is None:
        return None

    # Opportunistic last_seen_at bump. Checked in Python (not just the SQL
    # WHERE clause) so a fresh session skips the second connection entirely —
    # cat/db/oracle.py opens a brand-new connection per execute() call, and
    # this runs on every authenticated request.
    last_seen_at = row.get("last_seen_at")
    if last_seen_at is None or datetime.now() - last_seen_at > _LAST_SEEN_REFRESH_INTERVAL:
        execute(
            "UPDATE cat_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE session_id = :session_id",
            {"session_id": row["session_id"]},
        )
    return row


def delete_session(raw_token: str) -> None:
    execute(
        "DELETE FROM cat_sessions WHERE token_hash = :token_hash",
        {"token_hash": _hash_token(raw_token)},
    )


def purge_expired_sessions() -> None:
    execute("DELETE FROM cat_sessions WHERE expires_at < CURRENT_TIMESTAMP")

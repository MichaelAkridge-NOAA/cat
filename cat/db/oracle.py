"""Oracle database helpers for CAT."""

from contextlib import contextmanager
from typing import Any, Dict, List, Optional

from .config import get_database_settings, validate_oracle_settings


@contextmanager
def get_connection():
    settings = get_database_settings()
    validate_oracle_settings(settings)

    try:
        import oracledb  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("python-oracledb is not installed") from exc

    connect_kwargs = {
        "user": settings.user,
        "password": settings.password,
        "dsn": settings.dsn,
    }

    if settings.wallet_dir:
        connect_kwargs["config_dir"] = settings.wallet_dir
        connect_kwargs["wallet_location"] = settings.wallet_dir

    connection = oracledb.connect(**connect_kwargs)
    try:
        yield connection
    finally:
        connection.close()



def test_connection() -> Dict[str, Any]:
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute("SELECT 1 AS ok FROM dual")
            row = cursor.fetchone()
            return {"ok": bool(row and row[0] == 1)}



def execute(sql: str, params: Optional[Dict[str, Any]] = None) -> None:
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or {})
        conn.commit()



def execute_returning_id(sql: str, params: Optional[Dict[str, Any]] = None, id_column: str = "id") -> int:
    with get_connection() as conn:
        with conn.cursor() as cursor:
            out_id = cursor.var(int)
            run_params = dict(params or {})
            run_params[id_column] = out_id
            cursor.execute(sql, run_params)
            conn.commit()
            value = out_id.getvalue()
            if isinstance(value, (list, tuple)):
                value = value[0] if value else None
            if value is None:
                raise RuntimeError("Failed to retrieve RETURNING id value")
            return int(value)



def execute_many(sql: str, rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return

    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.executemany(sql, rows)
        conn.commit()



def _read_value(v: Any) -> Any:
    """Read Oracle LOB objects to string/bytes while the connection is open."""
    try:
        import oracledb  # type: ignore[import-not-found]
        if isinstance(v, oracledb.LOB):
            return v.read()
    except Exception:
        pass
    return v


def fetch_all(sql: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or {})
            columns = [desc[0].lower() for desc in cursor.description]
            rows = cursor.fetchall()
            return [
                {col: _read_value(val) for col, val in zip(columns, row)}
                for row in rows
            ]



def fetch_one(sql: str, params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    rows = fetch_all(sql, params)
    return rows[0] if rows else None

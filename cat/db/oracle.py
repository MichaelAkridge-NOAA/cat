"""Oracle database helpers for CAT."""

import logging
import os
import threading
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

from .config import get_database_settings, validate_oracle_settings

logger = logging.getLogger(__name__)

# One shared connection pool per process. Every helper below used to open a
# brand-new Oracle connection (TCP + TLS/auth handshake) and close it again —
# a single annotation save cost ~6 of them. Borrowing from a pool makes each
# query pay only for the query. Size: CAT_DB_POOL_MAX (default 12).
_pool = None
_pool_key = None
_pool_lock = threading.Lock()
_pool_failed = False


def _connect_kwargs(settings) -> Dict[str, Any]:
    kwargs = {"user": settings.user, "password": settings.password, "dsn": settings.dsn}
    if settings.wallet_dir:
        kwargs["config_dir"] = settings.wallet_dir
        kwargs["wallet_location"] = settings.wallet_dir
    return kwargs


def _get_pool(oracledb, settings):
    """Create the pool on first use (and again if the settings changed)."""
    global _pool, _pool_key, _pool_failed
    key = (settings.user, settings.dsn, settings.wallet_dir)
    if _pool is not None and _pool_key == key:
        return _pool
    with _pool_lock:
        if _pool is not None and _pool_key == key:
            return _pool
        try:
            max_size = max(2, int(os.getenv("CAT_DB_POOL_MAX", "12")))
        except ValueError:
            max_size = 12
        try:
            _pool = oracledb.create_pool(
                min=1, max=max_size, increment=1,
                # A connection that sat idle may have been dropped by a
                # firewall/DB restart; check before handing it out.
                ping_interval=60,
                **_connect_kwargs(settings),
            )
            _pool_key = key
            _pool_failed = False
            logger.info("Oracle connection pool ready (max %d)", max_size)
        except Exception as exc:  # fall back to one-off connections
            if not _pool_failed:
                logger.warning("Oracle connection pool unavailable, using direct connections: %s", exc)
            _pool_failed = True
            _pool = None
        return _pool


@contextmanager
def get_connection():
    settings = get_database_settings()
    validate_oracle_settings(settings)

    try:
        import oracledb  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("python-oracledb is not installed") from exc

    pool = _get_pool(oracledb, settings)
    if pool is not None:
        # Returned to the pool on exit; anything not committed is rolled
        # back on release, exactly as close() did before.
        connection = pool.acquire()
        try:
            yield connection
        finally:
            try:
                pool.release(connection)
            except Exception:
                try:
                    connection.close()
                except Exception:
                    pass
        return

    connection = oracledb.connect(**_connect_kwargs(settings))
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



def execute_rowcount(sql: str, params: Optional[Dict[str, Any]] = None) -> int:
    """Like execute(), but returns the number of rows the statement touched.

    Needed for compare-and-set writes (e.g. UPDATE ... WHERE version = :v),
    where 0 rows means "someone else got there first" rather than success.
    """
    with get_connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or {})
            count = cursor.rowcount
        conn.commit()
    return int(count or 0)



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
    """Read Oracle LOB objects to string/bytes while the connection is open.

    A failed LOB read must raise, not fall through: returning the raw LOB
    object used to reach _parse_json_field() as unparseable and come back as
    {} — and the client would then PUT that empty dict over the real data.
    """
    try:
        import oracledb  # type: ignore[import-not-found]
    except ImportError:
        return v
    if isinstance(v, oracledb.LOB):
        return v.read()
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

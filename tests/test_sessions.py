"""Annotation session timing: sessions belong to the logged-in account and
the page gets the person's earlier total back so it doesn't restart at 0."""

import cat.api.db_projects as dbp

USER = {"user_id": 7, "username": "ann", "role": "annotator"}


def test_start_session_uses_account_and_returns_prior_total(monkeypatch):
    executed = []
    monkeypatch.setattr(dbp, "_ensure_oracle_mode", lambda: None)
    monkeypatch.setattr(dbp, "_require_project_role", lambda project_id, user, role: "editor")
    monkeypatch.setattr(dbp, "execute", lambda sql, params=None: executed.append(params))
    monkeypatch.setattr(dbp, "execute_returning_id", lambda sql, params=None, id_column="id": executed.append(params) or 11)

    def fetch_one(sql, params=None):
        if "SUM(total_seconds)" in sql:
            assert params["username"] == "ann"
            return {"total_seconds": 5400, "annotation_count": 42}
        if "FROM cat_projects" in sql:
            return {"project_id": 3}
        return {"session_id": 11, "username": "ann"}

    monkeypatch.setattr(dbp, "fetch_one", fetch_one)

    # The page sends the Analyst field ("unknown" before it is filled in).
    result = dbp.start_session(3, dbp.SessionStart(username="unknown"), _current_user=USER)

    assert result["prior_total_seconds"] == 5400
    assert result["prior_annotation_count"] == 42
    assert all(p.get("username") in (None, "ann") for p in executed if isinstance(p, dict))
    assert any(p.get("username") == "ann" for p in executed if isinstance(p, dict))


def test_session_update_refreshes_heartbeat(monkeypatch):
    executed = []
    monkeypatch.setattr(dbp, "_ensure_oracle_mode", lambda: None)
    monkeypatch.setattr(dbp, "_require_project_role", lambda project_id, user, role: "editor")
    monkeypatch.setattr(dbp, "fetch_one", lambda sql, params=None: {"session_id": 11})
    monkeypatch.setattr(dbp, "execute", lambda sql, params=None: executed.append(sql))

    dbp.update_session(3, 11, dbp.SessionUpdate(total_seconds=120), _current_user=USER)
    assert "last_heartbeat = CURRENT_TIMESTAMP" in executed[0]

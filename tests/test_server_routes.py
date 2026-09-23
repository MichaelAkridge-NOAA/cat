"""The app must import cleanly and route requests the way we expect.

Guards against a broken server.py (nothing else imports it in tests) and
against the removed, unauthenticated file-mode routes coming back. Uses real
requests: this FastAPI version keeps included routers as lazy objects, so
listing app.routes doesn't show their paths.
"""

import os

os.environ.setdefault("CAT_STORAGE_BACKEND", "oracle")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cat.server as server  # noqa: E402


@pytest.fixture(scope="module")
def client():
    # No `with`: that would run the lifespan (DB bootstrap). Routing and the
    # auth dependency don't need it.
    return TestClient(server.app)


@pytest.mark.parametrize("fmt", ["shapefile", "kml", "geopackage"])
def test_exports_exist_and_require_login(client, fmt):
    assert client.post(f"/api/exports/{fmt}", json={"annotations": []}).status_code == 401


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/file-projects/list"),
        ("get", "/api/file-projects/shapefile?path=/etc/passwd"),
        ("post", "/api/file-projects/export-kml"),
        ("get", "/api/debug/file-exists?path=/etc/passwd"),
    ],
)
def test_file_mode_and_debug_file_routes_are_gone(client, method, path):
    assert getattr(client, method)(path).status_code in (404, 405)


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/db/projects/1/annotations/history"),
        ("get", "/api/db/projects/1/annotations/versions"),
        ("get", "/api/db/projects/1/annotations/2/history"),
        ("post", "/api/db/projects/1/annotations/2/history/3/restore"),
    ],
)
def test_history_and_versions_routes_exist(client, method, path):
    assert getattr(client, method)(path).status_code == 401


def test_config_reports_oracle(client):
    assert client.get("/api/config").json().get("storage_backend") == "oracle"


def test_compare_page_and_endpoints(client):
    assert client.get("/compare").status_code == 200
    assert client.get("/api/db/compare/sites").status_code == 401
    assert client.get("/api/db/compare/site-projects?site=X").status_code == 401


def test_activity_page_and_report(client):
    assert client.get("/activity").status_code == 200
    assert client.get("/api/db/activity/report").status_code == 401

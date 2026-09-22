"""Auth on the routes that were previously fully open (thumbnails, raster
tools, bootstrap, shapefile import, site scan/seed)."""

import inspect

import cat.api.annotation_import as ai
import cat.api.db_projects as dbp
import cat.api.raster_tools as rt
import cat.api.sites as sites
import cat.api.thumbnails as thumbs
from cat.api.auth import require_admin, require_auth


def _dep_fn(fn, contains=None):
    sig = inspect.signature(fn)
    names = [p.name for p in sig.parameters.values() if "user" in p.name or p.name == "_admin"]
    if contains:
        names = [n for n in names if contains in n] or names
    assert names, f"{fn.__name__} has no user/admin dependency parameter"
    default = sig.parameters[names[0]].default
    dep = getattr(default, "dependency", None)
    assert dep is not None, f"{fn.__name__}'s param isn't a Depends(...)"
    return dep


def test_thumbnail_routes_require_auth():
    assert _dep_fn(thumbs.cog_thumbnail) is require_auth
    assert _dep_fn(thumbs.project_thumbnail) is require_auth


def test_raster_tool_routes_require_auth():
    assert _dep_fn(rt.get_hillshade) is require_auth
    assert _dep_fn(rt.get_slope) is require_auth
    assert _dep_fn(rt.get_zonal_stats) is require_auth


def test_db_bootstrap_requires_admin():
    assert _dep_fn(dbp.db_bootstrap) is require_admin


def test_shapefile_import_routes_require_auth():
    assert _dep_fn(ai.preview_shapefile_components) is require_auth
    assert _dep_fn(ai.execute_shapefile_components) is require_auth


def test_sites_seed_requires_admin():
    assert _dep_fn(sites.seed_sites) is require_admin


def test_sites_gcs_routes_require_login_at_minimum():
    assert _dep_fn(sites.load_gcs_report) is require_auth
    assert _dep_fn(sites.scan_gcs) is require_auth

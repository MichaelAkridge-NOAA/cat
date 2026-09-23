"""No route may be unreachable because an earlier "{param}" route with the
same method swallows its literal path segment (FastAPI matches routes in
registration order; "/overlay-layers/{layer_id}" registered before
"/overlay-layers/reorder" made every reorder a 422)."""

import importlib
import pkgutil

import cat.api as api


def _routers():
    for m in pkgutil.iter_modules(api.__path__):
        mod = importlib.import_module(f"cat.api.{m.name}")
        for name in dir(mod):
            r = getattr(mod, name)
            if isinstance(getattr(r, "routes", None), list) and hasattr(r, "prefix"):
                yield f"{m.name}.{name}", r


def _shadows(earlier: str, later: str) -> bool:
    a, b = earlier.strip("/").split("/"), later.strip("/").split("/")
    if len(a) != len(b):
        return False
    shadow = False
    for x, y in zip(a, b):
        if x == y:
            continue
        if x.startswith("{") and not y.startswith("{"):
            shadow = True
            continue
        return False
    return shadow


def test_no_literal_route_is_shadowed_by_a_param_route():
    problems = []
    for name, router in _routers():
        seen = []
        for rt in router.routes:
            path, methods = getattr(rt, "path", None), getattr(rt, "methods", None) or set()
            if not path:
                continue
            for p2, m2 in seen:
                if methods & m2 and _shadows(p2, path):
                    problems.append(f"{name}: {sorted(methods & m2)} {p2} shadows {path}")
            seen.append((path, methods))
    assert not problems, "\n".join(problems)


def test_failed_feature_insert_removes_the_new_layer(monkeypatch):
    """Overlay layer + features are all-or-nothing: if inserting the features
    fails, the just-created layer is deleted again and the error surfaces."""
    import pytest
    import cat.api.db_projects as dbp

    calls = []
    monkeypatch.setattr(dbp, "execute_returning_id", lambda sql, params, id_column=None: 42)

    def boom(sql, rows):
        raise RuntimeError("ORA-01400")

    monkeypatch.setattr(dbp, "execute_many", boom)
    monkeypatch.setattr(dbp, "execute", lambda sql, params=None: calls.append((sql, params)))
    with pytest.raises(RuntimeError):
        dbp._create_derived_layer(1, "x", [('{"type": "Point", "coordinates": [0, 0]}', "{}")])
    assert any("DELETE FROM cat_overlay_layers" in sql and params == {"layer_id": 42} for sql, params in calls)


def test_reorder_is_validated():
    import pytest
    from pydantic import ValidationError
    import cat.api.db_projects as dbp

    with pytest.raises(ValidationError):
        dbp.LayerReorder(layer_orders=[])
    with pytest.raises(ValidationError):
        dbp.LayerReorder(layer_orders=[{"layer_id": "x", "display_order": 0}])
    assert dbp.LayerReorder(layer_orders=[{"layer_id": 1, "display_order": 0}]).layer_orders[0].layer_id == 1

"""The condition/cause-field audit tool parses and counts correctly."""

import importlib.util
import json
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _load():
    spec = importlib.util.spec_from_file_location(
        "audit_condition_cause_fields", REPO / "scripts" / "audit_condition_cause_fields.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_fields_list_matches_the_live_form_fields():
    mod = _load()
    assert mod.FIELDS == ["rdcause1", "rdcause2", "rdcause3", "con_1", "con_2", "con_3"]


def test_counts_distinct_values_and_skips_blank(monkeypatch, capsys):
    mod = _load()
    rows = [
        {"properties_json": json.dumps({"con_1": "DISEASE", "rdcause1": ""})},
        {"properties_json": json.dumps({"con_1": "disease "})},  # different case/whitespace -> counted separately
        {"properties_json": json.dumps({"con_1": "DISEASE"})},
        {"properties_json": json.dumps({})},
        {"properties_json": None},
    ]
    monkeypatch.setattr("cat.db.config.is_oracle_backend_enabled", lambda: True)
    monkeypatch.setattr("cat.db.oracle.fetch_all", lambda sql, params=None: rows)
    monkeypatch.setattr("sys.argv", ["audit_condition_cause_fields.py"])
    rc = mod.main()
    out = capsys.readouterr().out
    assert rc == 0
    assert "Audited 5 annotation(s)" in out
    assert "con_1: 2 distinct value(s), 3 non-blank total" in out
    assert "rdcause1: no values used" in out


def test_no_rows_returns_zero_and_says_so(monkeypatch, capsys):
    mod = _load()
    monkeypatch.setattr("cat.db.config.is_oracle_backend_enabled", lambda: True)
    monkeypatch.setattr("cat.db.oracle.fetch_all", lambda sql, params=None: [])
    monkeypatch.setattr("sys.argv", ["audit_condition_cause_fields.py"])
    rc = mod.main()
    out = capsys.readouterr().out
    assert rc == 0
    assert "No annotations found" in out


def test_oracle_disabled_returns_nonzero(monkeypatch):
    mod = _load()
    monkeypatch.setattr("cat.db.config.is_oracle_backend_enabled", lambda: False)
    monkeypatch.setattr("sys.argv", ["audit_condition_cause_fields.py"])
    assert mod.main() == 1

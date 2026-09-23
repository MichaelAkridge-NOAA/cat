"""Regression coverage for inline annotation table persistence."""

from pathlib import Path


REPO = Path(__file__).resolve().parent.parent


def test_project_load_shares_normalized_annotation_with_all_consumers():
    source = (REPO / "cat" / "web" / "js" / "annotation-runtime-project-layers.js").read_text(
        encoding="utf-8"
    )
    start = source.index("    function loadProjectAnnotations()")
    loader = source[start:]

    project_assignment = loader.index("projectAnnotations[idx] = normalizedAnn;")
    layer_assignment = loader.index("layer.annotationData = normalizedAnn;")
    table_assignment = loader.index("annotations.push(normalizedAnn);")

    assert project_assignment < layer_assignment < table_assignment


def test_standard_inline_edit_marks_annotation_pending_before_save():
    source = (REPO / "cat" / "web" / "js" / "annotation-runtime-annotations.js").read_text(
        encoding="utf-8"
    )
    start = source.index("    function makeTableCellEditable(cell)")
    end = source.index("    // Create autocomplete for table cell editing", start)
    handler = source[start:end]

    pending = handler.index("annotation._syncStatus = 'pending';")
    save = handler.index("saveProject();", pending)

    assert "if (isOracleProjectMode())" in handler[:pending]
    assert pending < save


def test_autocomplete_inline_edit_marks_annotation_pending_before_save():
    source = (REPO / "cat" / "web" / "js" / "annotation-runtime-annotations.js").read_text(
        encoding="utf-8"
    )
    start = source.index("    function createTableAutocomplete(")
    end = source.index("    // Open edit modal", start)
    handler = source[start:end]

    pending = handler.index("annotation._syncStatus = 'pending';")
    save = handler.index("saveProject();", pending)

    assert "if (isOracleProjectMode())" in handler[:pending]
    assert pending < save
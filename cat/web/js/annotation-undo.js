/* ================================================
   CAT - Coral Annotation Tool
   Undo / Redo Stack (Stage 5d)
   ================================================
   Supports: add, edit operations (max 20 levels).
   Deletes are handled by the undo-toast in annotation-form.js.

   Operations pushed by:
     - saveAnnotation()         → undoPushAdd(annotation, layer)
     - saveEditedAnnotation()   → undoPushEdit(index, prev, next)
     - makeTableCellEditable()  → undoPushEdit(index, prev, next)
   ================================================ */

const MAX_UNDO = 20;

let undoStack = [];
let redoStack = [];

// ── Public push helpers ──────────────────────────────────────────────────────

function undoPushAdd(annotation, layer) {
  undoStack.push({ type: 'add', annotation: { ...annotation }, layer });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  _updateUndoRedoUI();
}

function undoPushEdit(index, prevAnnotation, nextAnnotation) {
  undoStack.push({ type: 'edit', index, prev: { ...prevAnnotation }, next: { ...nextAnnotation } });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  _updateUndoRedoUI();
}

// ── Undo ─────────────────────────────────────────────────────────────────────

async function undoLastAction() {
  if (undoStack.length === 0) {
    showStatus('Nothing to undo', 'info');
    return;
  }
  const op = undoStack.pop();
  try {
    if (op.type === 'add') {
      await _undoAdd(op);
    } else if (op.type === 'edit') {
      await _undoEdit(op);
    }
    redoStack.push(op);
    if (redoStack.length > MAX_UNDO) redoStack.shift();
  } catch (err) {
    console.error('Undo failed:', err);
    showStatus(`❌ Undo failed: ${err.message}`, 'error');
    // Re-push so the user can retry
    undoStack.push(op);
  }
  _updateUndoRedoUI();
}

async function _undoAdd(op) {
  const ann = op.annotation;
  const projectAnnotations = getProjectAnnotations();
  const index = projectAnnotations.findIndex(a =>
    a === ann ||
    (ann._dbAnnotationId && a._dbAnnotationId === ann._dbAnnotationId) ||
    (ann._localId && a._localId === ann._localId)
  );
  if (index < 0) { showStatus('⚠️ Could not find annotation to undo', 'error'); return; }

  const isOracle = typeof isOracleProjectMode === 'function' && isOracleProjectMode();
  const needsDbDelete = ann._dbAnnotationId && ann._syncStatus === 'synced';
  if (needsDbDelete && isOracle && typeof deleteAnnotationFromDb === 'function') {
    await deleteAnnotationFromDb(ann);
  }

  // Remove from map
  const drawnItems = getDrawnItems();
  if (drawnItems) {
    drawnItems.eachLayer(layer => {
      if (!layer.annotationData) return;
      if (layer.annotationData === ann ||
          (ann._dbAnnotationId && layer.annotationData._dbAnnotationId === ann._dbAnnotationId)) {
        drawnItems.removeLayer(layer);
      }
    });
  }

  removeAnnotationFromProject(index);
  updateAnnotationTable();
  showStatus('↩️ Undo: annotation removed', 'success');
}

async function _undoEdit(op) {
  const projectAnnotations = getProjectAnnotations();
  const ann = projectAnnotations[op.index];
  if (!ann) { showStatus('⚠️ Could not find annotation to undo', 'error'); return; }

  const isOracle = typeof isOracleProjectMode === 'function' && isOracleProjectMode();
  if (isOracle && ann._dbAnnotationId && typeof syncAnnotationToDb === 'function') {
    const restored = await syncAnnotationToDb({ ...op.prev, _dbAnnotationId: ann._dbAnnotationId });
    restored._syncStatus = 'synced';
    applySyncedAnnotation(op.index, restored);
  } else {
    updateAnnotationInProject(op.index, { ...op.prev });
  }

  updateAnnotationTable();
  showStatus('↩️ Undo: edit reverted', 'success');
}

// ── Redo ─────────────────────────────────────────────────────────────────────

async function redoLastAction() {
  if (redoStack.length === 0) {
    showStatus('Nothing to redo', 'info');
    return;
  }
  const op = redoStack.pop();
  try {
    if (op.type === 'add') {
      await _redoAdd(op);
    } else if (op.type === 'edit') {
      await _redoEdit(op);
    }
    undoStack.push(op);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  } catch (err) {
    console.error('Redo failed:', err);
    showStatus(`❌ Redo failed: ${err.message}`, 'error');
    redoStack.push(op);
  }
  _updateUndoRedoUI();
}

async function _redoAdd(op) {
  const ann = op.annotation;
  const isOracle = typeof isOracleProjectMode === 'function' && isOracleProjectMode();

  let restoredAnn;
  if (isOracle && ann._dbAnnotationId && typeof restoreAnnotationInDb === 'function') {
    // Soft-deleted annotation — restore it
    restoredAnn = await restoreAnnotationInDb(ann._dbAnnotationId);
  } else if (isOracle && typeof syncAnnotationToDb === 'function') {
    // Never reached DB — re-POST
    const fresh = { ...ann };
    delete fresh._dbAnnotationId;
    restoredAnn = await syncAnnotationToDb(fresh);
  } else {
    restoredAnn = { ...ann };
  }
  if (restoredAnn) restoredAnn._syncStatus = 'synced';

  const data = restoredAnn || ann;
  const projectAnnotations = getProjectAnnotations();
  const newIndex = projectAnnotations.length;
  data._displayIndex = newIndex + 1;
  projectAnnotations.push(data);

  // Re-add to map
  if (ann.geometry && typeof L !== 'undefined') {
    const drawnItems = getDrawnItems();
    const layerStyle = typeof getAnnotationLayerStyle === 'function'
      ? getAnnotationLayerStyle(data)
      : { color: '#3388ff', weight: 7, opacity: 0.8, fillOpacity: 0.3 };
    const layer = L.geoJSON(ann.geometry, { pane: 'annotationsPane', style: layerStyle }).getLayers()[0];
    if (layer) {
      layer.annotationData = data;
      layer.on('click', function(e) { showAnnotationPopup(layer, e.latlng); });
      drawnItems.addLayer(layer);
    }
  }

  updateAnnotationTable();
  showStatus('↪️ Redo: annotation restored', 'success');
}

async function _redoEdit(op) {
  const projectAnnotations = getProjectAnnotations();
  const ann = projectAnnotations[op.index];
  if (!ann) { showStatus('⚠️ Could not find annotation to redo', 'error'); return; }

  const isOracle = typeof isOracleProjectMode === 'function' && isOracleProjectMode();
  if (isOracle && ann._dbAnnotationId && typeof syncAnnotationToDb === 'function') {
    const restored = await syncAnnotationToDb({ ...op.next, _dbAnnotationId: ann._dbAnnotationId });
    restored._syncStatus = 'synced';
    applySyncedAnnotation(op.index, restored);
  } else {
    updateAnnotationInProject(op.index, { ...op.next });
  }

  updateAnnotationTable();
  showStatus('↪️ Redo: edit reapplied', 'success');
}

// ── UI ────────────────────────────────────────────────────────────────────────

function _updateUndoRedoUI() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (undoBtn) {
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.title = undoStack.length > 0
      ? `Undo ${undoStack[undoStack.length - 1].type} (Ctrl+Z)`
      : 'Nothing to undo';
  }
  if (redoBtn) {
    redoBtn.disabled = redoStack.length === 0;
    redoBtn.title = redoStack.length > 0
      ? `Redo ${redoStack[redoStack.length - 1].type} (Ctrl+Y)`
      : 'Nothing to redo';
  }
}

// ── Expose globally ───────────────────────────────────────────────────────────

window.undoPushAdd = undoPushAdd;
window.undoPushEdit = undoPushEdit;
window.undoLastAction = undoLastAction;
window.redoLastAction = redoLastAction;

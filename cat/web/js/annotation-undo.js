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
  // Throw (instead of silently returning) so undoLastAction re-pushes the op
  // and the undo/redo stacks stay consistent (Task 7 fix)
  if (index < 0) throw new Error('Could not find annotation to undo');

  // Use the LIVE annotation for DB-state decisions: the op snapshot was taken
  // at save time, BEFORE auto-save assigned _dbAnnotationId/_syncStatus, and
  // the sync replaces the array entry with a new object (Task 7 fix)
  const live = projectAnnotations[index];
  const dbId = live._dbAnnotationId || live.annotation_id || live.id || null;
  if (dbId) op.annotation._dbAnnotationId = dbId; // let redo restore by id

  const isOracle = typeof isOracleProjectMode === 'function' && isOracleProjectMode();
  // Task 7 round 2 fix (Finding 3): delete by DB id regardless of _syncStatus —
  // an annotation can carry a _dbAnnotationId while pending/error (e.g. a PUT
  // that failed after the row existed server-side) and the server row must
  // still be removed on undo, or it orphans in the DB.
  const needsDbDelete = !!dbId;
  if (needsDbDelete && isOracle && typeof deleteAnnotationFromDb === 'function') {
    await deleteAnnotationFromDb(live);
  }

  // Remove from map
  const drawnItems = getDrawnItems();
  if (drawnItems) {
    drawnItems.eachLayer(layer => {
      if (!layer.annotationData) return;
      if (layer.annotationData === live || layer.annotationData === ann ||
          (dbId && layer.annotationData._dbAnnotationId === dbId) ||
          (ann._localId && layer.annotationData._localId === ann._localId)) {
        drawnItems.removeLayer(layer);
      }
    });
  }

  removeAnnotationFromProject(index);
  // Also remove from the parallel `annotations` array driving the table/navbar
  // count — removeAnnotationFromProject only touches projectAnnotations (Task 7 fix)
  if (typeof annotations !== 'undefined' && annotations !== projectAnnotations) {
    const ai = annotations.findIndex(a =>
      a === live || a === ann ||
      (dbId && a._dbAnnotationId === dbId) ||
      (ann._localId && a._localId === ann._localId)
    );
    if (ai !== -1) annotations.splice(ai, 1);
  }
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
  // Also push into the parallel `annotations` array driving the table/navbar
  // count (Task 7 fix — mirrors saveAnnotation's dual-array handling)
  if (typeof annotations !== 'undefined' && annotations !== projectAnnotations) {
    annotations.push(data);
  }

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

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', function (e) {
  // Skip when user is typing in a form field
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  // Ctrl+Z / Cmd+Z → undo (defer to v2-bulk.js in bulk mode)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
    if (window.v2BulkMode && window.v2BulkMode.enabled) return;
    e.preventDefault();
    // Mid-draw (placing points on a polyline/polygon/transect, not yet
    // finished), Ctrl+Z matches every other drawing tool's muscle memory:
    // remove the last placed point. Without this it silently undid the
    // PREVIOUSLY SAVED annotation instead — the in-progress shape you were
    // actually trying to correct was untouched, and something you'd already
    // saved vanished instead. Same handler Backspace already uses.
    const vertexHandler = window.catGetActiveDrawVertexHandler && window.catGetActiveDrawVertexHandler();
    if (vertexHandler) {
      vertexHandler.deleteLastVertex();
      return;
    }
    // A shape that's finished drawing (double-clicked to close the line) but
    // not yet saved has no undo-stack entry — undoPushAdd only happens on
    // Save — so Ctrl+Z here used to either say "nothing to undo" or, worse,
    // undo a previously SAVED annotation while the just-drawn unsaved shape
    // sat there untouched. Ctrl+Z should discard it, same as Escape and the
    // Discard button already do (window.discardCurrentAnnotation, shell-init.js).
    if (typeof currentAnnotation !== 'undefined' && currentAnnotation && currentAnnotation.layer &&
        !currentAnnotation.layer.annotationData && typeof window.discardCurrentAnnotation === 'function') {
      window.discardCurrentAnnotation();
      return;
    }
    undoLastAction();
    return;
  }
  // Ctrl+Y / Cmd+Y or Ctrl+Shift+Z / Cmd+Shift+Z → redo
  if ((e.ctrlKey || e.metaKey) && e.key === 'y' ||
      (e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') {
    e.preventDefault();
    redoLastAction();
  }
});

// ── Expose globally ───────────────────────────────────────────────────────────

window.undoPushAdd = undoPushAdd;
window.undoPushEdit = undoPushEdit;
window.undoLastAction = undoLastAction;
window.redoLastAction = redoLastAction;

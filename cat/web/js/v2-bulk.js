// ============================================================
//  CAT v2 — Bulk Draw Mode
//  Allows drawing multiple lines/shapes WITHOUT filling the
//  annotation form each time. Data entry happens later in the
//  table.  Adds Ctrl+Z undo and centroid dot toggle.
// ============================================================

(function () {
  'use strict';

  // ── State ──
  let bulkModeEnabled = false;
  let bulkDrawHistory = [];        // ordered list of layers added in bulk mode
  let centroidsVisible = false;
  let centroidMarkers = [];        // L.circleMarker refs
  let bulkIdCounter = 0;           // monotonic counter for colony_id (never decremented)
  let bulkSessionAnnotationIndices = []; // indices of annotations added in current bulk session
  let bulkSessionAnnotations = [];        // direct references to annotation objects (survives splice)
  const UNDO_TOAST_MS = 1800;
  let _tableUpdateTimer = null;   // debounce timer for table rebuilds during rapid drawing
  let _activeDrawHandler = null;  // track the current L.Draw.Polyline handler so we can disable before re-enabling
  let _bulkDrawInProgress = false; // re-entrancy guard: prevent duplicate draw:created handling
  let _activateTimeout = null;    // debounce timer for activatePolylineTool — prevents stacked timeouts
  let _drawCount = 0;             // diagnostic counter for bulk draws in current session

  // ── Expose to global so other modules can query ──
  window.v2BulkMode = {
    get enabled()  { return bulkModeEnabled; },
    get history()  { return bulkDrawHistory; },
    get sessionAnnotationIndices() { return bulkSessionAnnotationIndices; },
    get sessionAnnotations() { return bulkSessionAnnotations; },
  };

  // ===================================================================
  //  TOOLBAR — inject v2 toolbar buttons INTO the navbar
  // ===================================================================
  function injectToolbar() {
    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) {
      console.warn('v2-bulk: .nav-links not found, cannot inject toolbar');
      return;
    }
    
    // Create a container for v2 tool buttons that goes at the START of nav-links
    const toolbarContainer = document.createElement('div');
    toolbarContainer.className = 'v2-toolbar-inline';
    toolbarContainer.id = 'v2Toolbar';
    toolbarContainer.innerHTML = `
      <button class="v2-tool-btn v2-tool-btn-bulk" id="v2BulkToggle" title="Bulk Draw — add lines first, fill data later">
        ⚡ Bulk
      </button>
      <button class="v2-tool-btn v2-tool-btn-undo" id="v2UndoBtn" title="Undo last drawn line (Ctrl+Z)">
        ↩
      </button>
    `;
    
    // Insert at the beginning of nav-links
    navLinks.insertBefore(toolbarContainer, navLinks.firstChild);

    document.getElementById('v2BulkToggle').addEventListener('click', toggleBulkMode);
    document.getElementById('v2UndoBtn').addEventListener('click', undoLastDraw);
  }

  // ===================================================================
  //  BULK MODE — toggle
  // ===================================================================
  function toggleBulkMode() {
    bulkModeEnabled = !bulkModeEnabled;
    const btn = document.getElementById('v2BulkToggle');
    btn.classList.toggle('active', bulkModeEnabled);
    btn.textContent = bulkModeEnabled ? '⚡ ON' : '⚡ Bulk';

    // Show / hide the banner inside the annotation panel
    const banner = document.getElementById('v2BulkBanner');
    if (banner) banner.classList.toggle('active', bulkModeEnabled);

    // In bulk mode, collapse form-heavy UI panels that are usually not needed
    try {
      const formContent = document.getElementById('formSectionContent');
      const formIcon = document.getElementById('formSectionIcon');
      if (formContent && formIcon) {
        if (bulkModeEnabled) {
          formContent.classList.add('collapsed');
          formIcon.textContent = '▶';
        } else {
          formContent.classList.remove('collapsed');
          formIcon.textContent = '▼';
        }
      }

      if (typeof window.setTableShortcutsCollapsed === 'function') {
        window.setTableShortcutsCollapsed(bulkModeEnabled);
      }
    } catch (e) {
      console.warn('v2: Could not toggle panel collapse for bulk mode:', e);
    }

    if (bulkModeEnabled) {
      showUndoToast('Bulk Draw ON — draw lines, fill data later');
      // Reset history tracking for this new bulk session
      bulkDrawHistory = [];
      bulkSessionAnnotationIndices = [];
      bulkSessionAnnotations = [];
      _drawCount = 0;
      _bulkDrawInProgress = false; // ensure guard is cleared on fresh session
      updateBulkBannerCount();
      // Auto-activate the polyline (line) drawing tool
      activatePolylineTool();
    } else {
      showUndoToast('Bulk Draw OFF — normal mode');
      // Cancel any pending tool activation
      if (_activateTimeout) {
        clearTimeout(_activateTimeout);
        _activateTimeout = null;
      }
      // Disable our manually-created handler so it doesn't conflict
      if (_activeDrawHandler) {
        try { _activeDrawHandler.disable(); } catch (_) {}
        _activeDrawHandler = null;
      }
      // Keep the session indices until next bulk mode is ON (so Apply can use them)
    }
  }

  // ===================================================================
  //  TOOL ACTIVATION — activate the polyline tool programmatically
  // ===================================================================
  function activatePolylineTool() {
    // ── FIX: cancel any pending activation timeout to prevent stacking ──
    // Without this, rapid draws queue up multiple setTimeout callbacks,
    // each creating a handler — only the last one should win.
    if (_activateTimeout) {
      clearTimeout(_activateTimeout);
      _activateTimeout = null;
    }

    _activateTimeout = setTimeout(() => {
      _activateTimeout = null;
      try {
        if (typeof drawControl === 'undefined') return;

        // ── FIX: disable any active toolbar handler first ──
        // The toolbar's own L.Draw.Polyline could still be active if the
        // user clicked the toolbar button before entering bulk mode.
        // Two simultaneous handlers = two draw:created events per draw.
        try {
          if (drawControl._toolbars && drawControl._toolbars.draw) {
            drawControl._toolbars.draw.disable();
          }
        } catch (_) { /* toolbar already inactive */ }

        // ── FIX: disable the previous handler before creating a new one ──
        // Without this, each draw creates an additional handler that
        // never gets cleaned up, leading to exponential draw:created
        // events (2^N) and an eventual browser crash.
        if (_activeDrawHandler) {
          try { _activeDrawHandler.disable(); } catch (_) { /* already disabled */ }
          _activeDrawHandler = null;
        }
        // Create a fresh polyline handler and enable it
        _activeDrawHandler = new L.Draw.Polyline(map, drawControl.options.draw.polyline);
        _activeDrawHandler.enable();
        // Update visual feedback
        if (typeof updateDrawingToolVisualFeedback === 'function') {
          updateDrawingToolVisualFeedback('.leaflet-draw-draw-polyline');
        }
        console.log('v2: Polyline tool auto-activated for bulk draw');
      } catch (e) {
        console.warn('v2: Could not activate polyline tool:', e);
      }
    }, 100);
  }

  // ===================================================================
  //  BULK DRAW — intercept L.Draw.Event.CREATED
  //  We monkey-patch the existing handler so that in bulk mode we
  //  skip the form requirement and immediately save a "blank" annotation.
  // ===================================================================
  function initBulkDrawHook() {
    // Wait until the map + drawnItems exist
    const waitForMap = setInterval(() => {
      if (typeof map === 'undefined' || typeof drawnItems === 'undefined') return;
      clearInterval(waitForMap);

      // ── FIX: snapshot existing handler COUNT before adding ours ──
      // map._events['draw:created'] is a live array.  If we capture the
      // reference and then push our handler, the ref includes our handler
      // too.  Instead, snapshot the count so we only patch pre-existing ones.
      const existingHandlers = map._events && map._events['draw:created'];
      const existingCount = existingHandlers ? existingHandlers.length : 0;

      // Add our own EARLY handler (prepend)
      map.on('draw:created', function (event) {
        if (!bulkModeEnabled) return; // let original handler do its thing

        // ── FIX: re-entrancy guard ──
        // If multiple L.Draw handlers exist (e.g. from a prior leak), each
        // fires its own draw:created.  Only process the first one.
        if (_bulkDrawInProgress) {
          event._v2BulkHandled = true;
          return;
        }
        _bulkDrawInProgress = true;

        // ── FIX: wrap in try/finally so the re-entrancy guard is ALWAYS
        // released, even if an intermediate function throws.  Without this,
        // a single error permanently blocks all subsequent draws. ──
        try {
          const layer = event.layer;
          const type = event.layerType;

          // ── Build a minimal blank annotation ──
          const geometry = (typeof getFullPrecisionGeometry === 'function')
            ? getFullPrecisionGeometry(layer)
            : layer.toGeoJSON().geometry;

          // Assign a sequential colony_id via monotonic counter (survives undo)
          bulkIdCounter++;
          const nextId = bulkIdCounter;

          const props = buildBulkAnnotationProperties(layer, type, nextId);
          // Flatten properties to top level (matching v1 saveAnnotation format)
          // so table rendering and label generation find fields directly on ann.*
          const blankAnnotation = {
            type: type,
            geometry: geometry,
            ...props,
            properties: props
          };

          // Attach to the layer (same contract as v1 saveAnnotation)
          layer.annotationData = blankAnnotation;

          // ── Add layer to the map AFTER annotation is built ──
          // (avoids orphan layers if annotation construction throws)
          drawnItems.addLayer(layer);

          // Style it as a "pending-data" annotation (orange-ish)
          if (layer.setStyle) {
            layer.setStyle({
              color: '#f59e0b',
              weight: 7,
              opacity: 0.85,
              fillOpacity: 0.25,
              dashArray: '8 4'
            });
          }

          // Add to project annotations array
          let annotationIndex = -1;
          if (typeof annotations !== 'undefined') {
            annotationIndex = annotations.length;
            annotations.push(blankAnnotation);
          }
          // Push to currentProject.annotations for save/persistence
          // (this is a separate array from annotations — verified in loadProjectAnnotations)
          if (typeof currentProject !== 'undefined' && currentProject && currentProject.annotations) {
            currentProject.annotations.push(blankAnnotation);
          }

          // Track in bulk history for undo
          bulkDrawHistory.push({ layer, annotation: blankAnnotation });

          // Track in current bulk session for batch apply defaults
          if (annotationIndex >= 0) {
            bulkSessionAnnotationIndices.push(annotationIndex);
            bulkSessionAnnotations.push(blankAnnotation);
          }

          // Debounced table update — avoid rebuilding 35-col table on every rapid draw
          clearTimeout(_tableUpdateTimer);
          _tableUpdateTimer = setTimeout(() => {
            if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
          }, 300);

          // Mark changes
          if (typeof hasUnsavedChanges !== 'undefined') {
            hasUnsavedChanges = true;
          }

          // Add label (just the index) if labels are on — wrapped in try/catch
          // so a labeling error can't lock up the draw pipeline
          try {
            if (typeof labelsVisible !== 'undefined' && labelsVisible && typeof addLabelToAnnotation === 'function') {
              addLabelToAnnotation(layer);
            }
          } catch (labelErr) {
            console.warn('v2: label error (non-fatal):', labelErr);
          }

          // Update centroid if toggle is on — wrapped in try/catch
          try {
            if (centroidsVisible) {
              addCentroidForLayer(layer);
            }
          } catch (centroidErr) {
            console.warn('v2: centroid error (non-fatal):', centroidErr);
          }

          // Re-enable the drawing tool so user can keep drawing
          reEnableDrawingTool();

          _drawCount++;
          updateBulkBannerCount();
          showUndoToast(`Line #${nextId} added — keep drawing`);

        } catch (err) {
          console.error('v2: Error in bulk draw:created handler:', err);
          // Clean up layer if it was added to the map but not fully tracked
          try { drawnItems.removeLayer(event.layer); } catch (_) {}
          showUndoToast('⚠️ Draw error — try again');
        } finally {
          // ── IMPORTANT: prevent original handler from running ──
          event._v2BulkHandled = true;
          // ── FIX: release re-entrancy guard in finally block ──
          // Using synchronous release instead of setTimeout(0) so the
          // guard is guaranteed to be cleared even after an error.
          _bulkDrawInProgress = false;
        }
      });

      // Patch existing CREATED handlers to skip when bulk-handled
      // ── FIX: only patch handlers that existed BEFORE we added ours ──
      if (existingHandlers && existingCount > 0) {
        for (let i = 0; i < existingCount; i++) {
          const h = existingHandlers[i];
          const origFn = h.fn;
          h.fn = function (event) {
            if (event._v2BulkHandled) return; // skip, bulk mode handled it
            origFn.call(this, event);
          };
        }
      }

    }, 200);
  }

  // ── Build annotation properties carrying over all sticky form fields + computed measurements ──
  function buildBulkAnnotationProperties(layer, type, nextId) {
    const getValue = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };

    // seglength/segwidth are sticky form fields (analyst-entered transect measurements),
    // not computed from drawn geometry
    const seglength = getValue('seglength');
    const segwidth  = getValue('segwidth');

    // Compute drawn line length in meters (polylines only)
    let line_length_m = null;
    try {
      if (type === 'polyline' && layer.getLatLngs) {
        const latlngs = layer.getLatLngs();
        let meters = 0;
        for (let i = 0; i < latlngs.length - 1; i++) {
          meters += latlngs[i].distanceTo(latlngs[i + 1]);
        }
        line_length_m = parseFloat(meters.toFixed(3));
      }
    } catch (e) { /* ignore */ }

    return {
      // ID for table display
      colony_id: nextId || 0,
      // Sticky fields — carry over whatever is in the form
      analyst:    getValue('analyst'),
      obs_year:   getValue('obs_year'),
      mission_id: getValue('mission_id'),
      site:       getValue('site'),
      transect:   getValue('transect'),
      segment:    getValue('segment'),
      seglength:  seglength,
      segwidth:   segwidth,
      line_length_m: line_length_m,  // Auto-computed from drawn polyline
      // Per-annotation fields — left blank for table entry
      spcode:     '',
      morph_code: '',
      no_colony:  0,
      juvenile:   0,
      juv_substrate: '',
      remnant:    0,
      ex_bound:   0,
      old_dead:   '',
      rdcause1:   '', rd_1: '', rdcause2: '', rd_2: '', rdcause3: '', rd_3: '',
      con_1: '', extent_1: '', sev_1: '',
      con_2: '', extent_2: '', sev_2: '',
      con_3: '', extent_3: '', sev_3: '',
      created_at: new Date().toISOString()
    };
  }

  // ── Re-enable the polyline tool so user can keep drawing in bulk mode ──
  function reEnableDrawingTool() {
    // In bulk mode, always re-enable polyline for rapid line entry
    if (bulkModeEnabled) {
      activatePolylineTool();
      return;
    }
    // Otherwise fall back to v1's reEnableDrawingTool (handled by v1 code)
  }

  // ===================================================================
  //  UNDO (Ctrl+Z) — remove last drawn annotation
  // ===================================================================
  function undoLastDraw() {
    // In bulk mode, undo from bulk history
    let layerToRemove, annotationToRemove;

    if (bulkModeEnabled && bulkDrawHistory.length > 0) {
      const last = bulkDrawHistory.pop();
      layerToRemove = last.layer;
      annotationToRemove = last.annotation;
    } else if (typeof annotations !== 'undefined' && annotations.length > 0) {
      // Normal mode — remove the most recently added annotation
      annotationToRemove = annotations[annotations.length - 1];
      // Find the matching layer
      if (typeof drawnItems !== 'undefined') {
        drawnItems.eachLayer(layer => {
          if (layer.annotationData === annotationToRemove) {
            layerToRemove = layer;
          }
        });
      }
    }

    if (!layerToRemove && !annotationToRemove) {
      showUndoToast('Nothing to undo');
      return;
    }

    // Remove layer from map
    if (layerToRemove && typeof drawnItems !== 'undefined') {
      // Remove label if exists
      if (typeof removeAnnotationLabel === 'function') {
        removeAnnotationLabel(layerToRemove._leaflet_id);
      }
      // Remove centroid
      removeCentroidForLayer(layerToRemove);
      drawnItems.removeLayer(layerToRemove);
    }

    // Remove from annotations array
    if (annotationToRemove && typeof annotations !== 'undefined') {
      const idx = annotations.indexOf(annotationToRemove);
      if (idx !== -1) annotations.splice(idx, 1);
    }

    // Remove from project array
    if (annotationToRemove && typeof currentProject !== 'undefined' && currentProject && currentProject.annotations) {
      const idx = currentProject.annotations.indexOf(annotationToRemove);
      if (idx !== -1) currentProject.annotations.splice(idx, 1);
    }

    // Remove from bulk session tracking so batch-apply stays accurate
    if (annotationToRemove) {
      const sIdx = bulkSessionAnnotations.indexOf(annotationToRemove);
      if (sIdx !== -1) {
        bulkSessionAnnotations.splice(sIdx, 1);
        bulkSessionAnnotationIndices.splice(sIdx, 1);
      }
    }

    // Update table
    if (typeof updateAnnotationTable === 'function') {
      updateAnnotationTable();
    }

    if (typeof hasUnsavedChanges !== 'undefined') {
      hasUnsavedChanges = true;
    }

    updateBulkBannerCount();
    showUndoToast('↩ Removed last annotation');
  }

  // ===================================================================
  //  CENTROIDS — toggle centroid dots on annotation midpoints
  // ===================================================================
  function toggleCentroids() {
    centroidsVisible = !centroidsVisible;

    // Update the dropdown item text if it exists
    const ddItem = document.getElementById('ddCentroidToggle');
    if (ddItem) {
      ddItem.textContent = centroidsVisible ? '◉ Centroids ON' : '◉ Centroids';
      ddItem.style.color = centroidsVisible ? '#f59e0b' : '';
    }

    if (centroidsVisible) {
      showAllCentroids();
    } else {
      clearAllCentroids();
    }
  }

  // ── Expose functions globally so navbar dropdowns can call them ──
  window.v2ToggleCentroids = function () { toggleCentroids(); };
  window.v2OpenLayerManagement = function () {
    if (typeof openLayerManagementModal === 'function') {
      openLayerManagementModal();
    } else {
      showUndoToast('Layer management not available yet');
    }
  };
  window.v2UploadShapefile = function () {
    if (typeof triggerOverlayUpload === 'function') {
      triggerOverlayUpload();
    } else {
      showUndoToast('Upload not available — load a DB project first');
    }
  };

  function getCentroid(layer) {
    try {
      if (layer.getLatLngs) {
        const latlngs = layer.getLatLngs();
        const coords = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs; // handle polygon vs line
        if (coords.length === 0) return null;

        // Calculate true geographic midpoint by averaging all coordinates
        let totalLat = 0, totalLng = 0;
        for (let i = 0; i < coords.length; i++) {
          totalLat += coords[i].lat;
          totalLng += coords[i].lng;
        }
        return L.latLng(totalLat / coords.length, totalLng / coords.length);
      } else if (layer.getLatLng) {
        return layer.getLatLng();
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function addCentroidForLayer(layer) {
    const center = getCentroid(layer);
    if (!center || typeof map === 'undefined') return;
    const marker = L.circleMarker(center, {
      radius: 5,
      color: '#fff',
      weight: 2,
      fillColor: '#f59e0b',
      fillOpacity: 1,
      pane: 'annotationsPane'
    });
    marker._v2OwnerLayer = layer._leaflet_id;
    marker.addTo(map);
    centroidMarkers.push(marker);
  }

  function removeCentroidForLayer(layer) {
    const lid = layer._leaflet_id;
    centroidMarkers = centroidMarkers.filter(m => {
      if (m._v2OwnerLayer === lid) {
        if (typeof map !== 'undefined') map.removeLayer(m);
        return false;
      }
      return true;
    });
  }

  function showAllCentroids() {
    clearAllCentroids();
    if (typeof drawnItems === 'undefined') return;
    drawnItems.eachLayer(layer => {
      addCentroidForLayer(layer);
    });
  }

  function clearAllCentroids() {
    centroidMarkers.forEach(m => {
      if (typeof map !== 'undefined') map.removeLayer(m);
    });
    centroidMarkers = [];
  }

  // ===================================================================
  //  KEYBOARD SHORTCUTS
  // ===================================================================
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', function (e) {
      // Ctrl+Z — undo (only in bulk mode; otherwise let annotation-undo.js handle it)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (!bulkModeEnabled) return; // defer to annotation-undo.js
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        e.preventDefault();
        e.stopImmediatePropagation(); // prevent annotation-undo.js from also firing
        undoLastDraw();
      }
    });
  }

  // ===================================================================
  //  BULK BANNER — inject into annotation panel
  // ===================================================================
  function injectBulkBanner() {
    const waitForPanel = setInterval(() => {
      const panel = document.getElementById('annotationFormPanel');
      if (!panel) return;
      clearInterval(waitForPanel);

      const banner = document.createElement('div');
      banner.className = 'bulk-mode-banner';
      banner.id = 'v2BulkBanner';
      banner.innerHTML = `
        <span>⚡ <strong>Bulk Draw Mode</strong></span>
        <span class="bulk-count" id="v2BulkCount">0 lines</span>
        <span class="bulk-actions">
          <button onclick="document.getElementById('v2BulkToggle').click();" class="bulk-stop">■ Stop Bulk</button>
        </span>
      `;
      panel.insertBefore(banner, panel.firstChild);
    }, 300);
  }

  function updateBulkBannerCount() {
    const el = document.getElementById('v2BulkCount');
    if (el) {
      const count = bulkDrawHistory.length;
      el.textContent = `${count} line${count !== 1 ? 's' : ''}`;
    }
  }

  // ===================================================================
  //  UNDO TOAST — brief message at bottom of screen
  // ===================================================================
  function showUndoToast(msg) {
    let toast = document.getElementById('v2UndoToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'v2-undo-toast';
      toast.id = 'v2UndoToast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), UNDO_TOAST_MS);
  }

  // ===================================================================
  //  INIT
  // ===================================================================
  function init() {
    injectToolbar();
    injectBulkBanner();
    initBulkDrawHook();
    initKeyboardShortcuts();
    updateModeBadge();
    console.log('🔧 v2-bulk.js loaded — Bulk Draw, Ctrl+Z Undo, Centroid Toggle');
  }

  // ── Update the DB/File mode badge in the navbar ──
  function updateModeBadge() {
    // Retry briefly since storageBackend is set asynchronously in initializeStorageBackend()
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      const badge = document.getElementById('v2ModeBadge');
      if (!badge) { clearInterval(check); return; }
      if (typeof storageBackend !== 'undefined' && storageBackend) {
        badge.style.display = 'inline-block';
        if (storageBackend === 'oracle') {
          badge.textContent = '🗄️ DB Mode';
          badge.style.background = 'rgba(102,126,234,0.15)';
          badge.style.color = '#667eea';
        } else {
          badge.textContent = '📁 File Mode';
          badge.style.background = 'rgba(40,167,69,0.15)';
          badge.style.color = '#28a745';
        }
        clearInterval(check);
      } else if (attempts > 30) {
        clearInterval(check);
      }
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

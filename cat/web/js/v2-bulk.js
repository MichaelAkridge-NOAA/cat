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
  const UNDO_TOAST_MS = 1800;

  // ── Expose to global so other modules can query ──
  window.v2BulkMode = {
    get enabled()  { return bulkModeEnabled; },
    get history()  { return bulkDrawHistory; },
    get sessionAnnotationIndices() { return bulkSessionAnnotationIndices; },
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
      <button class="v2-tool-btn v2-tool-btn-centroid" id="v2CentroidToggle" title="Show/hide centroid dots on annotations">
        ◉
      </button>
      <span class="v2-toolbar-sep"></span>
      <button class="v2-tool-btn v2-tool-btn-layers" id="v2ManageLayers" title="Manage overlay layers (reorder, toggle, delete)">
        🗂️
      </button>
      <button class="v2-tool-btn v2-tool-btn-upload" id="v2UploadShp" title="Upload a shapefile overlay (.zip or .shp)">
        📤
      </button>
    `;
    
    // Insert at the beginning of nav-links
    navLinks.insertBefore(toolbarContainer, navLinks.firstChild);

    document.getElementById('v2BulkToggle').addEventListener('click', toggleBulkMode);
    document.getElementById('v2UndoBtn').addEventListener('click', undoLastDraw);
    document.getElementById('v2CentroidToggle').addEventListener('click', toggleCentroids);
    document.getElementById('v2ManageLayers').addEventListener('click', () => {
      if (typeof openLayerManagementModal === 'function') {
        openLayerManagementModal();
      } else {
        showUndoToast('Layer management not available yet');
      }
    });
    document.getElementById('v2UploadShp').addEventListener('click', () => {
      if (typeof triggerOverlayUpload === 'function') {
        triggerOverlayUpload();
      } else {
        showUndoToast('Upload not available — load a DB project first');
      }
    });
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
      updateBulkBannerCount();
      // Auto-activate the polyline (line) drawing tool
      activatePolylineTool();
    } else {
      showUndoToast('Bulk Draw OFF — normal mode');
      // Keep the session indices until next bulk mode is ON (so Apply can use them)
    }
  }

  // ===================================================================
  //  TOOL ACTIVATION — activate the polyline tool programmatically
  // ===================================================================
  function activatePolylineTool() {
    setTimeout(() => {
      try {
        if (typeof drawControl !== 'undefined') {
          // Create a fresh polyline handler and enable it
          const handler = new L.Draw.Polyline(map, drawControl.options.draw.polyline);
          handler.enable();
          // Update visual feedback
          if (typeof updateDrawingToolVisualFeedback === 'function') {
            updateDrawingToolVisualFeedback('.leaflet-draw-draw-polyline');
          }
          console.log('v2: Polyline tool auto-activated for bulk draw');
        }
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

      // Store reference to the original CREATED handler
      const originalHandlers = map._events && map._events['draw:created'];

      // Add our own EARLY handler (prepend)
      map.on('draw:created', function (event) {
        if (!bulkModeEnabled) return; // let original handler do its thing

        const layer = event.layer;
        const type = event.layerType;

        // ── Add layer to the map immediately ──
        drawnItems.addLayer(layer);

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
          type: type === 'polyline' ? 'line' : type,
          geometry: geometry,
          ...props,
          properties: props
        };

        // Attach to the layer (same contract as v1 saveAnnotation)
        layer.annotationData = blankAnnotation;

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
        if (typeof currentProject !== 'undefined' && currentProject && currentProject.annotations) {
          currentProject.annotations.push(blankAnnotation);
        }

        // Track in bulk history for undo
        bulkDrawHistory.push({ layer, annotation: blankAnnotation });

        // Track in current bulk session for batch apply defaults
        if (annotationIndex >= 0) {
          bulkSessionAnnotationIndices.push(annotationIndex);
        }

        // Update table
        if (typeof updateAnnotationTable === 'function') {
          updateAnnotationTable();
        }

        // Mark changes
        if (typeof hasUnsavedChanges !== 'undefined') {
          hasUnsavedChanges = true;
        }

        // Add label (just the index) if labels are on
        if (typeof labelsVisible !== 'undefined' && labelsVisible && typeof addLabelToAnnotation === 'function') {
          addLabelToAnnotation(layer);
        }

        // Update centroid if toggle is on
        if (centroidsVisible) {
          addCentroidForLayer(layer);
        }

        // Re-enable the drawing tool so user can keep drawing
        reEnableDrawingTool();

        updateBulkBannerCount();
        showUndoToast(`Line #${nextId} added — keep drawing`);

        // ── IMPORTANT: prevent original handler from running ──
        event._v2BulkHandled = true;
      });

      // Patch existing CREATED handlers to skip when bulk-handled
      if (originalHandlers) {
        originalHandlers.forEach(h => {
          const origFn = h.fn;
          h.fn = function (event) {
            if (event._v2BulkHandled) return; // skip, bulk mode handled it
            origFn.call(this, event);
          };
        });
      }

    }, 200);
  }

  // ── Build annotation properties carrying over all sticky form fields + computed measurements ──
  function buildBulkAnnotationProperties(layer, type, nextId) {
    const getValue = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };

    // Calculate seglength/segwidth from the drawn geometry
    let seglength = getValue('seglength');
    let segwidth  = getValue('segwidth');

    try {
      if (type === 'polyline' && layer.getLatLngs) {
        const latlngs = layer.getLatLngs();
        if (latlngs.length >= 2) {
          // Line length in meters
          const meters = latlngs[0].distanceTo(latlngs[latlngs.length - 1]);
          seglength = meters.toFixed(3);
        }
      } else if ((type === 'rectangle' || type === 'polygon') && layer.getBounds) {
        const bounds = layer.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const se = L.latLng(sw.lat, ne.lng);
        const width  = sw.distanceTo(se);   // east-west
        const height = sw.distanceTo(L.latLng(ne.lat, sw.lng)); // north-south
        seglength = Math.max(width, height).toFixed(3);
        segwidth  = Math.min(width, height).toFixed(3);
      }
    } catch (e) {
      console.warn('v2: measurement calc error:', e);
    }

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
      // Per-annotation fields — left blank for table entry
      spcode:     '',
      morph_code: '',
      no_colony:  0,
      juvenile:   0,
      juv_substrate: '',
      remnant:    0,
      ex_bound:   0,
      olddead:    '',
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
    const btn = document.getElementById('v2CentroidToggle');
    btn.classList.toggle('active', centroidsVisible);
    btn.textContent = centroidsVisible ? '◉ Centroids ON' : '◉ Centroids';

    if (centroidsVisible) {
      showAllCentroids();
    } else {
      clearAllCentroids();
    }
  }

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
      // Ctrl+Z — undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        // Don't intercept if user is typing in an input/textarea
        const tag = document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        e.preventDefault();
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

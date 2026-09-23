// Extracted from annotation-file-mode-runtime.js (Phase 2e: shell/init/map/sam3 bootstrap)
    async function saveProjectAndAnnotations() {
      if (!currentProject) {
        alert('No project loaded');
        return;
      }

      try {
        // Calculate total session time
        const sessionMetadata = {
          total_session_seconds: timerState.totalSessionSeconds,
          annotation_count: timerState.annotationCount,
          session_start: timerState.sessionStartTime ? new Date(timerState.sessionStartTime).toISOString() : null,
          session_end: new Date().toISOString()
        };
        
        const projectId = currentProject.project_id;
        if (!projectId) {
          throw new Error('Project ID is missing');
        }

        if (storageBackend === 'oracle') {
          // Task 8 fix: this used to POST /annotations/bulk-replace, which
          // deletes and recreates every annotation on the project on every
          // manual Save click. That silently churned every row's id/version
          // even for annotations nothing had touched, breaking the
          // optimistic-locking and undo/redo identity Task 7's differential
          // sync (runAutoSave) depends on. Manual Save now drives the exact
          // same differential POST-new/PUT-changed path as auto-save, so the
          // two save flows can't disagree about what "saved" means.
          // If an auto-save is mid-flight, runAutoSave() below would return
          // immediately with changes still flagged and this click would report
          // a bogus "Save failed". Wait for it to finish first (bounded).
          // Edits made after an in-flight save started are NOT in it, so wait
          // for it and then run our own pass (the old code returned early
          // claiming "your changes are included", and they weren't).
          const waitStart = Date.now();
          while (window._catAutoSaveInFlight && Date.now() - waitStart < 15000) {
            await new Promise(resolve => setTimeout(resolve, 150));
          }
          if (window._catAutoSaveInFlight) {
            if (typeof showStatus === 'function') showStatus('⏳ A save is still running — your changes will be saved right after it.', 'info');
            runAutoSave(); // registers a follow-up run
            return;
          }
          await runAutoSave();
          if (countUnsavedAnnotations() > 0) {
            // runAutoSave failed; it already put the badge into its error
            // state (and, past the retry budget, the degraded-mode banner)
            // and has a retry scheduled. Nothing more to do here — don't
            // claim success.
            // Task 11: this manual Save click previously ended here with no
            // user-visible feedback at all beyond the small badge — add a
            // toast so a deliberate Save action always gets a response.
            if (typeof showStatus === 'function') {
              showStatus('❌ Save failed — annotations could not be saved to the server. Will retry automatically.', 'error');
            }
            return;
          }

          // Best-effort session summary update
          if (currentDbSessionId) {
            try {
              await fetch(`${serverUrl}/api/db/projects/${projectId}/sessions/${currentDbSessionId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  total_seconds: sessionMetadata.total_session_seconds,
                  annotation_count: sessionMetadata.annotation_count,
                  is_active: true
                })
              });
            } catch (sessionErr) {
              console.warn('Session update skipped:', sessionErr);
            }
          }

          showStatus(`✅ All changes saved to project #${projectId}`, 'success');
          return;
        }
      } catch (error) {
        console.error('Error saving:', error);
        alert(`❌ Error saving: ${error.message}`);
      }
    }
    
    // Toggle timer on click
    document.addEventListener('DOMContentLoaded', async () => {
      await initializeStorageBackend();

      // ── Session field persistence ──────────────────────────────────────
      // Auto-restore session fields from localStorage on page load,
      // and auto-save them when the user changes them.
      const SESSION_FIELDS = ['analyst', 'obs_year', 'mission_id', 'site'];
      const SESSION_KEY = 'cat_session_fields';
      try {
        const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
        SESSION_FIELDS.forEach(id => {
          const el = document.getElementById(id);
          if (el && saved[id] && !el.value) {
            el.value = saved[id];
          }
        });
      } catch (e) { /* ignore */ }
      SESSION_FIELDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('change', () => {
            try {
              const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
              saved[id] = el.value;
              localStorage.setItem(SESSION_KEY, JSON.stringify(saved));
            } catch (e) { /* ignore */ }
          });
        }
      });

      const timerBadge = document.getElementById('annotationTimer');
      if (timerBadge) {
        timerBadge.addEventListener('click', () => {
          if (timerState.isRunning && !timerState.isPaused) {
            pauseTimer();
          } else {
            startTimer();
          }
        });
      }
      
      // (File-mode projects handed over via localStorage were removed; a
      // stale hand-off left by an old page is just cleared.)
      try { localStorage.removeItem('annotationProject'); } catch (e) { /* ignore */ }

      // DB mode project bootstrap via URL parameter: ?project_id=123
      const urlParams = new URLSearchParams(window.location.search);
      const dbProjectId = urlParams.get('project_id') || urlParams.get('db_project_id');
      // Oracle mode has no useful "no project loaded" state on this page —
      // projects are opened from the project manager, not uploaded here.
      // Send the user there instead of showing an empty annotator. Skip the
      // redirect if a project was just handed off via the localStorage
      // bridge above (e.g. a one-off local file opened from the project
      // manager without a numeric project_id).
      if (storageBackend === 'oracle' && !dbProjectId) {
        window.location.href = '/project_creator.html';
        return;
      }
      if (storageBackend === 'oracle' && dbProjectId) {
        try {
          await loadProjectFromDatabase(dbProjectId);
          // Auto-save is always on in database mode (an older "disabled"
          // preference is ignored — with it off, nothing saved new work).
          startAutoSave();
          // Bring back changes a closed/crashed tab never got to save.
          if (!window._catPopoutMode) recoverJournaledChanges();
        } catch (error) {
          console.error('Error loading DB project:', error);
          const overlay = document.getElementById('fullLoadingOverlay');
          if (overlay) overlay.style.display = 'none';
          const _us = document.getElementById('uploadStatus');
          if (_us) _us.innerHTML = `<span style="color: #ef4444;">❌ DB load failed: ${error.message}</span>`;
          // Task 11: uploadStatus lives inside the (often collapsed) upload
          // panel, so a failed initial project load could go unnoticed.
          // Also raise a toast, consistent with catFetch's failure UX.
          if (typeof showStatus === 'function') showStatus(`❌ Failed to load project: ${error.message}`, 'error');
        }
      }
      
      // Add event listener for save button
      document.getElementById('saveProjectBtn').addEventListener('click', saveProjectAndAnnotations);
    });

    // saveProject() is what every edit path calls after changing something
    // (table cells, paste, batch fill, dialog, geometry, undo…). It used to run
    // the full manual-Save flow each time — a toast and a whole save pass per
    // call, so pasting into 20 cells meant 20 passes and 20 "saved" toasts.
    // Now it is a quiet, debounced save: calls within 300 ms collapse into
    // one autosave pass; the returned promise resolves once that pass is done.
    // The Save button / Ctrl+S still use saveProjectAndAnnotations() directly.
    let _saveSoonTimer = null;
    let _saveSoonWaiters = [];
    function saveProject() {
      return new Promise(resolve => {
        _saveSoonWaiters.push(resolve);
        clearTimeout(_saveSoonTimer);
        _saveSoonTimer = setTimeout(async () => {
          const waiters = _saveSoonWaiters;
          _saveSoonWaiters = [];
          try {
            if (isOracleProjectMode()) {
              const waitStart = Date.now();
              while (window._catAutoSaveInFlight && Date.now() - waitStart < 15000) {
                await new Promise(r => setTimeout(r, 150));
              }
              await runAutoSave();
            }
          } catch (e) {
            console.warn('Save after edit failed (autosave will retry):', e);
          } finally {
            waiters.forEach(r => r());
          }
        }, 300);
      });
    }
    
    // File mode uses simple local timer - no inactivity tracking needed
    
    // End timer when leaving page (file mode - local only)
    // Also warn user about unsaved changes
    window.addEventListener('beforeunload', (e) => {
      // The auto-save interval is NOT stopped here: beforeunload also fires
      // when the user then clicks "Stay on page", and stopping it left the
      // rest of the session without auto-save.

      // Final best-effort flush of ONLY the changed annotations, one normal
      // PUT/POST each with keepalive (survives the page closing). Never
      // destructive. This replaced a sendBeacon to /annotations/bulk-replace,
      // which deleted every annotation in the project and re-inserted this
      // tab's copy — wiping other users' work and resurrecting deletions.
      const unsavedCount = (isOracleProjectMode() && !window.catReadOnly && typeof countUnsavedAnnotations === 'function')
        ? countUnsavedAnnotations() : 0;
      if (unsavedCount > 0 && currentProject?.project_id) {
        try {
          const projectId = currentProject.project_id;
          const KEEPALIVE_BUDGET = 60000; // browsers cap keepalive bodies at ~64KB total
          let used = 0;
          let flushed = 0;
          _allLocalAnnotations().filter(annotationNeedsSync).forEach(ann => {
            const dbId = getDbAnnotationId(ann);
            // Creates carry the annotation's client_uuid, so this POST is
            // safe even if autosave is sending the same create right now —
            // the server returns the one row instead of inserting twice.
            const payload = normalizeAnnotationForDb(ann);
            const body = dbId
              ? JSON.stringify({
                  feature: payload.feature,
                  properties: payload.properties,
                  created_by: payload.created_by,
                  ...(ann._dbAnnotationVersion != null ? { version: ann._dbAnnotationVersion } : {})
                })
              : JSON.stringify(payload);
            if (used + body.length > KEEPALIVE_BUDGET) return;
            used += body.length;
            flushed++;
            const sentFingerprint = annotationPayloadFingerprint(ann);
            // If the user answers "Stay on page", the page lives on and these
            // responses arrive: adopt the new id/version exactly like
            // autosave does, so the next autosave doesn't POST a duplicate or
            // PUT with a stale version. Until a create answers, autosave
            // leaves it alone (annotationNeedsSync checks this).
            if (!dbId) ann._createInFlightUntil = Date.now() + 30000;
            fetch(dbId
              ? `${serverUrl}/api/db/projects/${projectId}/annotations/${dbId}`
              : `${serverUrl}/api/db/projects/${projectId}/annotations`, {
              method: dbId ? 'PUT' : 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
              keepalive: true,
              credentials: 'same-origin'
            })
              .then(resp => (resp.ok ? resp.json() : null))
              .then(result => {
                if (!result || !result.annotation) return;
                const synced = normalizeDbAnnotationResponse(result.annotation);
                mergeServerIdentity(ann, synced);
                _recordSyncedByMe(synced._dbAnnotationId, synced._dbAnnotationVersion);
                ann._syncedFingerprint = sentFingerprint;
                ann._syncStatus = (annotationPayloadFingerprint(ann) === sentFingerprint) ? 'synced' : 'pending';
              })
              .catch(() => {})
              .finally(() => { delete ann._createInFlightUntil; });
          });
          if (flushed) console.log(`📤 Unload flush: ${flushed}/${unsavedCount} changed annotation(s) sent with keepalive`);
        } catch (flushErr) {
          console.warn('Unload flush failed:', flushErr);
        }
      }

      
      // Show warning if project is loaded and there are unsaved changes
      // Overlay move/rotate/vertex edits live in an edit session until Save is
      // clicked on the edit bar — closing the tab used to lose them silently.
      const overlayEditsPending = typeof _overlayEditSession !== 'undefined' &&
        _overlayEditSession && _overlayEditSession.dirty;
      if (currentProject && (unsavedCount > 0 || overlayEditsPending || (!isOracleProjectMode() && hasUnsavedChanges))) {
        // Set returnValue to trigger browser warning
        e.preventDefault();
        e.returnValue = ''; // Chrome requires returnValue to be set
        
        // Modern browsers will show their own message, but we can provide a custom one
        const message = '⚠️ You have unsaved annotations!\n\nDid you save your project? Click "Save Project" to preserve your work.';
        return message; // Some browsers may display this
      }

      // Best-effort DB session close
      if (storageBackend === 'oracle' && currentProject?.project_id && currentDbSessionId) {
        try {
          const url = `${serverUrl}/api/db/projects/${currentProject.project_id}/sessions/${currentDbSessionId}/end`;
          navigator.sendBeacon(url, new Blob([JSON.stringify({})], { type: 'application/json' }));
        } catch (sessionErr) {
          console.warn('Could not close DB session on unload:', sessionErr);
        }
      }
    });
    // ========== End Timer Tracking ==========

    // ── Global stubs — overwritten below in normal mode, stay as no-ops in popout ──
    // In popout mode map must be a no-op object (not null) so async layer operations
    // like layer.addTo(map) don't throw TypeErrors when map-dependent code runs.
    let map = window._catPopoutMode ? {
      on: ()=>{}, off: ()=>{}, once: ()=>{},
      addLayer: ()=>{}, removeLayer: ()=>{}, hasLayer: ()=>false, eachLayer: ()=>{},
      fitBounds: ()=>{}, setView: ()=>{}, setZoom: ()=>{},
      getBounds: ()=>null, getCenter: ()=>({lat:0,lng:0}), getZoom: ()=>2,
      getPane: ()=>null, createPane: ()=>{}, getContainer: ()=>null,
      invalidateSize: ()=>{}, panTo: ()=>{}, closePopup: ()=>{},
      // Every real L.Map has an `options` bag, and code that tweaks map
      // behaviour writes straight into it (annotation-runtime-settings-map.js
      // does `map.options.zoomDelta = ...` on load). Omitting it made that an
      // uncaught TypeError on every popout open, which aborted the rest of that
      // module's init — so the popout was throwing before it finished booting.
      options: {},
      scrollWheelZoom: null,
      _panes: {}, _layers: {}
    } : null;
    let drawnItems = {
      eachLayer: () => {},
      clearLayers: () => {},
      addLayer: () => {},
      removeLayer: () => {},
      getLayers: () => [],
      hasLayer: () => false
    };
    let drawControl = null;
    let lastDrawingTool = null;

    if (!window._catPopoutMode) {

    // Initialize map
    map = L.map('map', {
      center: [0, 0],
      zoom: 2,
      zoomControl: false,  // Disable default zoom control, we'll add it to the right side
      maxZoom: 2000
    });
    
    // Add zoom control to top-right (grouped with drawing tools)
    L.control.zoom({
      position: 'topright'
    }).addTo(map);
    
    // Add scale control
    L.control.scale({
      imperial: true,
      metric: true
    }).addTo(map);
    
    // Create custom panes for proper layer ordering
    // Default Leaflet z-index structure:
    // - tiles: 200
    // - overlays: 400
    // - shadows: 500
    // - markers: 600
    // - tooltips: 650
    // - popups: 700
    // Our custom ordering: COG tiles (150) < DEM (300) < shapefile (450) < annotations (650)
    // Annotations need to be ON TOP so you can draw over everything
    if (!map.getPane('cogPane')) {
      map.createPane('cogPane');
      map.getPane('cogPane').style.zIndex = 150;
      console.log('Created cogPane with z-index 150 (bottom)');
    }
    if (!map.getPane('demPane')) {
      map.createPane('demPane');
      map.getPane('demPane').style.zIndex = 300;
      console.log('Created demPane with z-index 300 (DEM layer)');
    }
    if (!map.getPane('shapefilePane')) {
      map.createPane('shapefilePane');
      map.getPane('shapefilePane').style.zIndex = 450;
      console.log('Created shapefilePane with z-index 450 (middle)');
    }
    if (!map.getPane('annotationsPane')) {
      map.createPane('annotationsPane');
      map.getPane('annotationsPane').style.zIndex = 650;
      console.log('Created annotationsPane with z-index 650 (ON TOP)');
    }
    
    // Feature group for annotations - use custom pane
    // IMPORTANT: Set pane option so all layers added to this group use annotationsPane
    drawnItems = new L.FeatureGroup([], { pane: 'annotationsPane' });
    map.addLayer(drawnItems);
    
    // Update visual feedback for active drawing tool
    function updateDrawingToolVisualFeedback(activeButtonClass) {
      // Remove active class from all drawing buttons
      const allButtons = document.querySelectorAll('.leaflet-draw-draw-polyline, .leaflet-draw-draw-polygon, .leaflet-draw-draw-rectangle');
      allButtons.forEach(btn => btn.classList.remove('drawing-tool-active'));
      
      // Add active class to the current tool
      if (activeButtonClass) {
        const activeButton = document.querySelector(activeButtonClass);
        if (activeButton) {
          activeButton.classList.add('drawing-tool-active');
        }
      }
    }
    
    // Add drawing controls - positioned in top-right for easy access
    drawControl = new L.Control.Draw({
      position: 'topright',  // Changed from 'topleft' to 'topright' for better placement
      draw: {
        polyline: {
          shapeOptions: {
            color: '#f357a1',
            weight: 7,  // Match default annotation line weight
            pane: 'annotationsPane'  // Ensure drawn shapes use annotations pane
          },
          maxPoints: 2,  // Only allow straight line (2 points)
          showLength: true,  // Show length measurement
          metric: true  // Use meters
        },
        polygon: {
          allowIntersection: false,
          shapeOptions: {
            color: '#667eea',
            weight: 7,  // Match default annotation line weight
            fillOpacity: 0.3,
            pane: 'annotationsPane'  // Ensure drawn shapes use annotations pane
          }
        },
        rectangle: {
          shapeOptions: {
            color: '#f59e0b',
            weight: 7,  // Match default annotation line weight
            fillOpacity: 0.3,
            pane: 'annotationsPane'  // Ensure drawn shapes use annotations pane
          }
        },
        circle: false,
        circlemarker: false,
        marker: false
      },
      edit: {
        featureGroup: drawnItems,
        remove: true
      }
    });
    map.addControl(drawControl);

    // The toolbar's Delete mode has its own "Clear All" link that removes
    // every annotation in one click, with no confirmation and no owner check.
    // (It was harmless until Delete mode started saving to the database.)
    // Project-wide clearing lives in File → Clear All (owner/admin, confirmed).
    if (L.EditToolbar && L.EditToolbar.prototype.getActions) {
      const originalGetActions = L.EditToolbar.prototype.getActions;
      L.EditToolbar.prototype.getActions = function (handler) {
        return originalGetActions.call(this, handler).filter(a => a.callback !== this._clearAllLayers);
      };
    }

    // Toolbar "Edit layers" used to put EVERY annotation into vertex-edit
    // mode at once (all lines lit up with handles). Limit it to what the user
    // has selected: ticked table rows / lasso selection, otherwise the last
    // annotation clicked on the map. With nothing selected, say so.
    (function limitToolbarEditToSelection() {
      if (!L.EditToolbar || !L.EditToolbar.Edit) return;
      const proto = L.EditToolbar.Edit.prototype;
      const originalEnableLayerEdit = proto._enableLayerEdit;
      proto._enableLayerEdit = function (e) {
        const layer = e.layer || e.target || e;
        const allowed = window._catEditTargets;
        if (allowed && !allowed.has(layer)) return;
        return originalEnableLayerEdit.call(this, e);
      };
      // EDITSTART fires before the toolbar walks the layers, so the target
      // set is in place when _enableLayerEdit runs for each one.
      map.on(L.Draw.Event.EDITSTART, () => {
        const targets = new Set();
        const rows = (window.v2Table && window.v2Table.selectedRows) ? [...window.v2Table.selectedRows] : [];
        rows.forEach(i => {
          const ann = annotations[i];
          if (!ann) return;
          drawnItems.eachLayer(l => { if (l.annotationData === ann) targets.add(l); });
        });
        const last = window._catLastClickedLayer;
        if (targets.size === 0 && last && drawnItems.hasLayer(last)) targets.add(last);
        window._catEditTargets = targets;
        if (targets.size === 0) {
          showStatus('Select an annotation first (click it on the map or tick its row), then press Edit.', 'info');
        } else {
          showStatus(`Editing ${targets.size} selected annotation(s) — drag vertices, then Save.`, 'info');
        }
      });
      map.on(L.Draw.Event.EDITSTOP, () => { window._catEditTargets = null; });
    })();

    // ── One drawing tool at a time ──────────────────────────────────────
    // Measure, the AI rectangle, bulk draw, the toolbar tools and the
    // re-arm-after-save each created their own Leaflet.draw handler and
    // none of them switched the others off, so two could be live at once
    // (both firing draw:created). Every tool now calls this first.
    // opts.keepToolbar: called because a toolbar tool is being turned on.
    window.catStopAllDrawing = function (opts) {
      opts = opts || {};
      if (window._catReEnableTimer) { clearTimeout(window._catReEnableTimer); window._catReEnableTimer = null; }
      if (!opts.keepToolbar) {
        try { if (drawControl && drawControl._toolbars && drawControl._toolbars.draw) drawControl._toolbars.draw.disable(); } catch (e) { /* not active */ }
      }
      try { if (typeof window.catCancelMeasure === 'function' && window.catMeasureModeActive) window.catCancelMeasure(); } catch (e) { /* ignore */ }
      try { if (window._catSam3Handler) { window._catSam3Handler.disable(); window._catSam3Handler = null; window.catSam3PendingMode = null; } } catch (e) { /* ignore */ }
      try { if (window.v2BulkMode && typeof window.v2BulkMode.stopDrawing === 'function') window.v2BulkMode.stopDrawing(); } catch (e) { /* ignore */ }
    };
    try {
      drawControl._toolbars.draw.on('enable', () => window.catStopAllDrawing({ keepToolbar: true }));
    } catch (e) { /* toolbar layout differs — tools still stop each other via the hotkeys */ }

    // ── Hand (pan) tool ─────────────────────────────────────────────────
    // Pan is the resting state: no draw tool armed. After saving an
    // annotation the page used to re-arm the last draw tool automatically;
    // that is now opt-in via the 🔁 toggle (remembered per browser).
    window.catKeepToolAfterSave = (function () {
      try { return localStorage.getItem('cat_keep_tool_after_save') === '1'; } catch (e) { return false; }
    })();
    window.catActivatePanTool = function () {
      window.catStopAllDrawing();
      lastDrawingTool = null;
      if (typeof showStatus === 'function') showStatus('✋ Pan tool — drag to move the map', 'info');
    };
    const PanControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const box = L.DomUtil.create('div', 'leaflet-bar cat-pan-control');
        const pan = L.DomUtil.create('a', '', box);
        pan.href = '#';
        pan.title = 'Pan / hand tool (H) — stop drawing';
        pan.innerHTML = '✋';
        pan.style.cssText = 'font-size:16px;line-height:30px;text-align:center;';
        const keep = L.DomUtil.create('a', '', box);
        keep.href = '#';
        const paintKeep = () => {
          keep.innerHTML = '🔁';
          keep.style.cssText = 'font-size:14px;line-height:30px;text-align:center;' +
            (window.catKeepToolAfterSave ? 'background:#dbeafe;' : 'opacity:0.45;');
          keep.title = window.catKeepToolAfterSave
            ? 'Keep drawing tool after save: ON (click to return to pan after each save)'
            : 'Keep drawing tool after save: OFF (click to keep the last tool armed)';
        };
        paintKeep();
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(pan, 'click', (e) => { L.DomEvent.preventDefault(e); window.catActivatePanTool(); });
        L.DomEvent.on(keep, 'click', (e) => {
          L.DomEvent.preventDefault(e);
          window.catKeepToolAfterSave = !window.catKeepToolAfterSave;
          try { localStorage.setItem('cat_keep_tool_after_save', window.catKeepToolAfterSave ? '1' : '0'); } catch (err) { /* ignore */ }
          paintKeep();
        });
        return box;
      }
    });
    map.addControl(new PanControl());

    // ── Pan without leaving the drawing tool ────────────────────────────
    // Leaflet only drags with the left button, and the draw tools treat ANY
    // click as a vertex — so a middle-click meant to pan added a point
    // (and, for 2-point lines, finished the line). Now:
    //   * middle-button drag always pans (drawing or not), never adds a point;
    //   * holding Space turns a left-button drag into a pan as well.
    // Listeners run in the capture phase on the map container so the draw
    // handlers never see these presses.
    (function panWhileDrawing() {
      const container = map.getContainer();
      let panning = null; // { x, y, button }
      let spaceHeld = false;

      const isTyping = () => {
        const a = document.activeElement;
        // Also leave Space alone on focused buttons/links (it activates them).
        return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' ||
          a.tagName === 'BUTTON' || a.tagName === 'A' || a.isContentEditable);
      };

      document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space' || isTyping() || e.repeat) return;
        spaceHeld = true;
        container.style.cursor = 'grab';
        e.preventDefault(); // no page scroll
      });
      document.addEventListener('keyup', (e) => {
        if (e.code !== 'Space') return;
        spaceHeld = false;
        if (!panning) container.style.cursor = '';
      });
      window.addEventListener('blur', () => { spaceHeld = false; panning = null; container.style.cursor = ''; });

      container.addEventListener('mousedown', (e) => {
        const middle = e.button === 1;
        const spaceLeft = e.button === 0 && spaceHeld;
        if (!middle && !spaceLeft) return;
        e.preventDefault();          // no browser autoscroll on middle-click
        e.stopPropagation();         // the draw tool must not see this press
        panning = { x: e.clientX, y: e.clientY, button: e.button };
        container.style.cursor = 'grabbing';
      }, true);

      document.addEventListener('mousemove', (e) => {
        if (!panning) return;
        const dx = e.clientX - panning.x;
        const dy = e.clientY - panning.y;
        if (dx || dy) {
          map.panBy([-dx, -dy], { animate: false });
          panning.x = e.clientX;
          panning.y = e.clientY;
        }
      }, true);

      const endPan = (e) => {
        if (!panning || e.button !== panning.button) return;
        e.preventDefault();
        e.stopPropagation();         // no vertex, no "finish line" on release
        panning = null;
        container.style.cursor = spaceHeld ? 'grab' : '';
      };
      document.addEventListener('mouseup', endPan, true);
      // Middle-click also fires auxclick / click on some browsers.
      container.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); } }, true);
      container.addEventListener('click', (e) => {
        if (e.button === 0 && spaceHeld) { e.preventDefault(); e.stopPropagation(); }
      }, true);
    })();

    // Override Leaflet Draw's readableDistance function to show 3 decimal places for sub-meter measurements
    // This affects the tooltip display during drawing
    if (L.GeometryUtil && L.GeometryUtil.readableDistance) {
      L.GeometryUtil.readableDistance = function(distance, isMetric, useFeet, isNauticalMile, precision) {
        var distanceStr;
        
        if (isMetric) {
          // Metric system
          if (distance > 1000) {
            // Show kilometers with 2 decimals for distances > 1km
            distanceStr = (distance / 1000).toFixed(2) + ' km';
          } else {
            // Show meters with 3 decimals for sub-kilometer distances
            // This ensures 0.001m to 999.999m are displayed properly
            distanceStr = distance.toFixed(3) + ' m';
          }
        } else {
          // Imperial system
          distance *= 1.09361;
          if (distance > 1760) {
            distanceStr = (distance / 1760).toFixed(2) + ' miles';
          } else {
            distanceStr = distance.toFixed(3) + ' yd';
          }
        }
        
        return distanceStr;
      };
      console.log('✅ Overrode Leaflet Draw readableDistance for 3 decimal precision');
    }
    
    // Helper: update the drawing mode indicator badge (Fix 3e)
    function updateDrawingModeIndicator(tool) {
      const el = document.getElementById('drawingModeIndicator');
      if (!el) return;
      const labels = { polyline: 'Line', polygon: 'Polygon', rectangle: 'Rectangle' };
      const colors = { polyline: '#f357a1', polygon: '#667eea', rectangle: '#f59e0b' };
      if (tool && labels[tool]) {
        el.textContent = labels[tool];
        el.style.background = colors[tool] || '#667eea';
        el.style.display = 'inline-block';
      } else {
        el.style.display = 'none';
      }
    }

    // Show/hide the drawing hints bar (#drawingHintsBar in annotation.html).
    // Called with a layerType ('polyline'|'polygon'|'rectangle') to show, or null to hide.
    // (Task 7 fix: this function was referenced by the draw:drawstart/drawstop/canceled
    // handlers below but never defined, so the hints bar never appeared.)
    function showDrawingHints(tool) {
      const bar = document.getElementById('drawingHintsBar');
      if (!bar) return;
      if (!tool) {
        bar.style.display = 'none';
        return;
      }
      const finishEl = document.getElementById('drawingHintFinish');
      if (finishEl) {
        const finishText = {
          polygon: 'double-click to finish',
          polyline: 'click last point to finish',
          rectangle: 'release mouse to finish'
        };
        finishEl.textContent = finishText[tool] || 'double-click to finish';
      }
      bar.style.display = 'block';
    }

    // Listen for when drawing tools are activated
    map.on('draw:drawstart', function(e) {
      // Store the type of tool being used
      if (e.layerType) {
        lastDrawingTool = e.layerType;
        console.log('🖊️ Drawing tool started:', lastDrawingTool);

        // Add visual feedback for active tool (with delay to ensure toolbar is ready)
        const buttonClassMap = {
          'polyline': '.leaflet-draw-draw-polyline',
          'polygon': '.leaflet-draw-draw-polygon',
          'rectangle': '.leaflet-draw-draw-rectangle'
        };
        setTimeout(() => {
          updateDrawingToolVisualFeedback(buttonClassMap[e.layerType]);
        }, 50);

        // Update drawing mode indicator badge (Fix 3e)
        updateDrawingModeIndicator(e.layerType);

        // Show drawing hints bar
        if (typeof showDrawingHints === 'function') showDrawingHints(e.layerType);
      }
    });

    // Listen for when drawing is stopped or cancelled
    map.on('draw:drawstop', function(e) {
      console.log('🛑 Drawing tool stopped');
      // Remove visual feedback when drawing stops
      updateDrawingToolVisualFeedback(null);
      // Clear the mode indicator when drawing finishes (Fix 3e)
      updateDrawingModeIndicator(null);
      // Hide drawing hints bar
      if (typeof showDrawingHints === 'function') showDrawingHints(null);
      // DON'T clear lastDrawingTool here - keep it so we can re-enable after save
      // Only clear it when explicitly cancelled by user
    });

    // Also listen for draw:canceled event (triggered by ESC key or clicking cancel)
    map.on('draw:canceled', function(e) {
      console.log('❌ Drawing tool cancelled (ESC or Cancel button)');
      // Remove visual feedback when drawing is cancelled
      updateDrawingToolVisualFeedback(null);
      // Hide drawing hints bar
      if (typeof showDrawingHints === 'function') showDrawingHints(null);
      // Clear last drawing tool when cancelled by user
      lastDrawingTool = null;
    });

    // ── Handle draw:created — the NORMAL (non-bulk) drawing handler ──
    // In bulk mode v2-bulk.js handles this event; we skip here.
    map.on(L.Draw.Event.CREATED, function(event) {
      // View-only project: the draw toolbar is hidden, but a stray shortcut
      // must never turn a shape into an (unsaveable) annotation.
      if (window.catReadOnly) return;
      // Skip in bulk mode — v2-bulk.js handles it
      if (window.v2BulkMode && window.v2BulkMode.enabled) return;
      // Skip while the standalone measure tool is active — annotation-runtime-measure.js
      // has its own CREATED listener and this shape must never become a saved annotation.
      if (window.catMeasureModeActive) return;

      const layer = event.layer;
      const type  = event.layerType;

      console.log(`🎨 Draw created (normal mode): type=${type}`);

      // Ensure the layer uses the annotations pane for proper z-index
      if (layer.options) {
        layer.options.pane = 'annotationsPane';
      }

      // SAM3 AI segmentation: a rectangle drawn while an AI mode is armed
      // is handed to the segmentation module instead of becoming a normal
      // manual annotation.
      if (type === 'rectangle' && window.catSam3PendingMode && typeof window.catSam3HandleRectangle === 'function') {
        window.catSam3HandleRectangle(layer);
        return;
      }

      // ── Normal drawing flow ──

      // Remove any previous unsaved annotation to prevent ghost shapes
      if (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData) {
        console.log('🧹 Removing previous unsaved annotation');
        drawnItems.removeLayer(currentAnnotation.layer);
      }

      // Add the new layer to the map
      drawnItems.addLayer(layer);

      // Snap new vertices onto nearby existing-annotation vertices so adjacent
      // colony boundaries share exact edges (annotation-runtime-snapping.js).
      if (typeof window.snapNewLayerVertices === 'function') {
        window.snapNewLayerVertices(layer);
      }

      // Store the current drawing with full-precision geometry
      currentAnnotation = {
        type: type,
        layer: layer,
        geometry: getFullPrecisionGeometry(layer)
      };

      // Broadcast to form popout if one is open
      if (window._catChannel) {
        window._catChannel.postMessage({
          type: 'new-shape',
          geometry: currentAnnotation.geometry,
          shapeType: type
        });
      }

      // Auto-start / resume timer on first annotation draw
      if (!timerState.isRunning) {
        console.log('🎬 First annotation drawn — starting timer');
        startTimer();
      } else if (timerState.isPaused) {
        console.log('▶️ Annotation drawn — resuming timer');
        startTimer();
      }

      // Show the Discard button for easy cancel
      const discardBtn = document.getElementById('discardAnnotationBtn');
      if (discardBtn) discardBtn.style.display = '';

      // Show status
      showStatus('Draw created! Fill out the form and click Save.', 'info');

      // Auto-focus on species field for quick data entry
      const speciesField = document.getElementById('spcode');
      if (speciesField) {
        // Quick-repeat: pre-fill last species if field is empty
        if (!speciesField.value && window._catLastSpcode) {
          speciesField.value = window._catLastSpcode;
          speciesField.style.background = 'linear-gradient(to right, #eff6ff 0%, #fff 100%)';
          speciesField.style.borderColor = '#3b82f6';
          speciesField.addEventListener('input', function() {
            speciesField.style.background = '';
            speciesField.style.borderColor = '';
          }, { once: true });
        }
        setTimeout(() => {
          speciesField.focus();
          speciesField.select();
          console.log('✅ Auto-focused on species field');
        }, 100);
      }

      // Debug log
      const bounds = layer.getBounds ? layer.getBounds() : null;
      const center = bounds ? bounds.getCenter() : (layer.getLatLng ? layer.getLatLng() : null);
      console.log('🖊️ Drew annotation:', {
        type: type,
        geometry: currentAnnotation.geometry,
        coordinates: currentAnnotation.geometry.coordinates,
        visualCenter: center,
        layerType: layer.constructor.name
      });
    });

    // Monitor toolbar button clicks to detect deactivation
    // Leaflet Draw adds/removes 'leaflet-draw-toolbar-button-enabled' class
    setTimeout(() => {
      const toolbar = document.querySelector('.leaflet-draw-toolbar-top');
      if (toolbar) {
        // Use event delegation to catch all button clicks
        toolbar.addEventListener('click', function(e) {
          const button = e.target.closest('a');
          if (button) {
            // Check if button is being deactivated (has enabled class before click)
            const wasEnabled = button.classList.contains('leaflet-draw-toolbar-button-enabled');
            
            // Use setTimeout to check state after Leaflet processes the click
            setTimeout(() => {
              const isEnabled = button.classList.contains('leaflet-draw-toolbar-button-enabled');
              
              if (wasEnabled && !isEnabled) {
                // Button was just deactivated
                console.log('🔘 Drawing tool button deactivated');
                updateDrawingToolVisualFeedback(null);
                lastDrawingTool = null;
              } else if (!wasEnabled && isEnabled) {
                // Button was just activated - add visual feedback
                console.log('🔘 Drawing tool button activated');
                const buttonClass = button.classList.contains('leaflet-draw-draw-polyline') ? '.leaflet-draw-draw-polyline' :
                                   button.classList.contains('leaflet-draw-draw-polygon') ? '.leaflet-draw-draw-polygon' :
                                   button.classList.contains('leaflet-draw-draw-rectangle') ? '.leaflet-draw-draw-rectangle' : null;
                if (buttonClass) {
                  updateDrawingToolVisualFeedback(buttonClass);
                }
              }
            }, 50);
          }
        });
        console.log('✅ Added toolbar button click monitor');
      }
    }, 500); // Delay to ensure toolbar is rendered
    
    // Shared by Backspace (below) and Ctrl+Z (annotation-undo.js): the
    // Leaflet.Draw handler for whatever shape is currently mid-draw
    // (polyline/polygon/rectangle with at least one vertex placed), or null.
    // Exported so annotation-undo.js's Ctrl+Z handler — which has no
    // visibility into drawControl — can tell "still placing points" apart
    // from "nothing active, undo my last saved annotation instead."
    function _getActiveDrawVertexHandler() {
      const activeMode = drawControl && drawControl._toolbars && drawControl._toolbars.draw
        ? drawControl._toolbars.draw._activeMode
        : null;
      const handler = activeMode && activeMode.handler;
      if (handler && typeof handler.deleteLastVertex === 'function' &&
          Array.isArray(handler._markers) && handler._markers.length > 0) {
        return handler;
      }
      return null;
    }
    window.catGetActiveDrawVertexHandler = _getActiveDrawVertexHandler;

    // Backspace mid-draw removes the last placed vertex (Task 7 fix: the drawing
    // hints bar advertises "Backspace undo vertex" but nothing bound the key —
    // leaflet-draw only exposes deleteLastVertex() via its "Delete last point" link).
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Backspace') return;
      // Never hijack Backspace while typing in a form control
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      const handler = _getActiveDrawVertexHandler();
      if (handler) {
        e.preventDefault();
        handler.deleteLastVertex();
      }
    });

    // Add global ESC key handler to cancel drawing tools AND discard unsaved annotations
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Escape') return;
      // Skip if a modal is open
      if (document.getElementById('editModal')?.classList.contains('active')) return;
      if (document.getElementById('catConfirmOverlay')?.style.display === 'flex') return;
      // Task 9 review fix: this handler fires before annotation-runtime-
      // settings-app.js's own Escape-to-close handler (script load order),
      // and both are plain (non-capturing) document keydown listeners, so
      // stopPropagation() in the settings handler can't stop this one from
      // also running. Without this guard, pressing Escape to close a
      // settings modal ALSO cancelled the active drawing tool and silently
      // discarded any unsaved annotation underneath it.
      const openSettingsModal = ['speciesFilterModal', 'timerSettingsModal',
        'autoSaveSettingsModal', 'mapDisplaySettingsModal']
        .find(id => document.getElementById(id)?.style.display === 'flex');
      if (openSettingsModal) return;

      // Close any open autocomplete dropdown (but keep going — single-press discard)
      const openDropdown = document.querySelector('.species-autocomplete-dropdown.active');
      if (openDropdown) openDropdown.classList.remove('active');

      // Typing in a form field (species search, analyst/site/mission text,
      // an inline table-cell edit) and pressing Escape to clear or blur it is
      // ordinary browser behavior — it must not ALSO cancel the active
      // drawing tool and discard the unsaved annotation underneath it. Only
      // suppress the cascade while there's actually something to lose.
      const active = document.activeElement;
      const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' || active.isContentEditable);
      if (isTyping && (lastDrawingTool || (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData))) {
        active.blur();
        return;
      }

      // If a drawing tool is active mid-draw, cancel it
      if (lastDrawingTool) {
        console.log('⌨️ ESC pressed - cancelling drawing tool');
        updateDrawingToolVisualFeedback(null);
        // Hide drawing hints bar
        if (typeof showDrawingHints === 'function') showDrawingHints(null);
        const hintsBar = document.getElementById('drawingHintsBar');
        if (hintsBar) hintsBar.style.display = 'none';
        lastDrawingTool = null;
      }

      // Discard unsaved (not yet saved) annotation
      if (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData) {
        console.log('⌨️ ESC pressed - discarding unsaved annotation');
        drawnItems.removeLayer(currentAnnotation.layer);
        currentAnnotation = null;
        // An open popout is still holding this geometry in its form; without
        // this it would happily save an annotation for a shape that no longer
        // exists on the map.
        if (window._catChannel) window._catChannel.postMessage({ type: 'shape-discarded' });
        // Clear form fields (preserve session fields)
        ['transect','segment','seglength','segwidth','no_colony','spcode','juvenile',
         'juv_substrate','remnant','morph_code','ex_bound','olddead',
         'rdcause1','rd_1','rdcause2','rd_2','rdcause3','rd_3',
         'con_1','extent_1','sev_1','con_2','extent_2','sev_2','con_3','extent_3','sev_3'
        ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        // Reset numeric defaults
        ['no_colony','juvenile','remnant','ex_bound'].forEach(id => {
          const el = document.getElementById(id); if (el) el.value = '0';
        });
        // Hide discard button
        const discardBtn = document.getElementById('discardAnnotationBtn');
        if (discardBtn) discardBtn.style.display = 'none';
        showStatus('Annotation discarded', 'info');
      }
    });

    // ── Discard button handler ──
    // discardCurrentAnnotation is called by the Discard button's onclick in the HTML.
    // Defined here because annotation-drawing.js (which originally held it) is not loaded.
    window.discardCurrentAnnotation = function() {
      if (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData) {
        console.log('🧹 Discarding unsaved annotation via button');
        drawnItems.removeLayer(currentAnnotation.layer);
        currentAnnotation = null;
        // Keep an open popout's form from saving the shape we just threw away.
        if (window._catChannel) window._catChannel.postMessage({ type: 'shape-discarded' });
        // Clear per-annotation form fields (preserve session fields)
        ['transect','segment','seglength','segwidth','no_colony','spcode','juvenile',
         'juv_substrate','remnant','morph_code','ex_bound','olddead',
         'rdcause1','rd_1','rdcause2','rd_2','rdcause3','rd_3',
         'con_1','extent_1','sev_1','con_2','extent_2','sev_2','con_3','extent_3','sev_3'
        ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        ['no_colony','juvenile','remnant','ex_bound'].forEach(id => {
          const el = document.getElementById(id); if (el) el.value = '0';
        });
        const discardBtn = document.getElementById('discardAnnotationBtn');
        if (discardBtn) discardBtn.style.display = 'none';
        showStatus('Annotation discarded', 'info');
      }
    };

    // ── Minimap, map view persistence ──
    if (typeof catMapSaveView === 'function') catMapSaveView(map);
    if (typeof catInitMinimap === 'function') catInitMinimap(map);
    
    // COG layer
    let cogLayer = null;
    let cogBounds = null; // Store COG bounds for zoom functionality
    let demLayer = null;
    let shapefileLayers = {}; // Object to store multiple shapefile layers by name
    
    // ========== Panel Layout: Float / Dock-Right ==========

    const LAYOUT_KEY = 'cat_layout_mode';
    const PANEL_WIDTH_KEY = 'cat_panel_width';
    const MIN_PANEL_WIDTH = 280;
    const MAX_PANEL_WIDTH = 1600;
    const MIN_MAP_WIDTH = 320;

    // The saved width (up to 1600px) was applied as-is, so on a smaller
    // screen the docked table ran off the edge or left no map. Keep it within
    // the window, always leaving some map visible.
    function _clampPanelWidth(w) {
      const maxForWindow = Math.max(MIN_PANEL_WIDTH, window.innerWidth - MIN_MAP_WIDTH);
      return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, maxForWindow, w || 420));
    }

    function toggleLayoutMode() {
      const isDocked = document.body.classList.contains('layout-docked');
      isDocked ? _setLayoutFloat() : _setLayoutDocked();
    }

    function _setLayoutDocked() {
      const savedWidth = _clampPanelWidth(parseInt(localStorage.getItem(PANEL_WIDTH_KEY)) || 420);
      document.documentElement.style.setProperty('--panel-width', savedWidth + 'px');
      document.body.classList.add('layout-docked');
      const ltb = document.getElementById('layoutToggleBtn');
      if (ltb) { ltb.textContent = '⬜ Float'; ltb.title = 'Switch to floating panel'; }
      const ddlt = document.getElementById('ddLayoutToggle');
      if (ddlt) ddlt.textContent = '⬜ Float Panel';
      localStorage.setItem(LAYOUT_KEY, 'docked');
      setTimeout(() => { if (typeof map !== 'undefined') map.invalidateSize(); }, 50);
    }

    function _setLayoutFloat() {
      document.body.classList.remove('layout-docked');
      const ltb2 = document.getElementById('layoutToggleBtn');
      if (ltb2) { ltb2.textContent = '⬛ Dock Right'; ltb2.title = 'Dock panel to right side'; }
      const ddlt2 = document.getElementById('ddLayoutToggle');
      if (ddlt2) ddlt2.textContent = '⬛ Dock Right';
      localStorage.setItem(LAYOUT_KEY, 'float');
      setTimeout(() => { if (typeof map !== 'undefined') map.invalidateSize(); }, 50);
    }

    // Drag-to-resize the divider
    (function initResizeHandle() {
      const handle = document.getElementById('layout-resize-handle');
      if (!handle) return;

      let dragging = false;
      let startX = 0;
      let startWidth = 420;

      handle.addEventListener('mousedown', (e) => {
        if (!document.body.classList.contains('layout-docked')) return;
        dragging = true;
        startX = e.clientX;
        startWidth = parseInt(getComputedStyle(document.documentElement)
          .getPropertyValue('--panel-width')) || 420;
        handle.classList.add('dragging');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const delta = startX - e.clientX; // dragging left = wider panel
        const newWidth = _clampPanelWidth(startWidth + delta);
        document.documentElement.style.setProperty('--panel-width', newWidth + 'px');
        if (typeof map !== 'undefined') map.invalidateSize();
      });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const finalWidth = parseInt(getComputedStyle(document.documentElement)
          .getPropertyValue('--panel-width')) || 420;
        localStorage.setItem(PANEL_WIDTH_KEY, finalWidth);
      });
    })();

    // Restore layout preference on load
    (function restoreLayout() {
      if (localStorage.getItem(LAYOUT_KEY) === 'docked') {
        _setLayoutDocked();
      }
    })();

    // Re-fit the docked panel when the window shrinks (or a laptop moves
    // from an external monitor to its own screen).
    window.addEventListener('resize', () => {
      if (!document.body.classList.contains('layout-docked')) return;
      const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-width')) || 420;
      const wanted = parseInt(localStorage.getItem(PANEL_WIDTH_KEY)) || current;
      const fitted = _clampPanelWidth(wanted);
      if (fitted !== current) {
        document.documentElement.style.setProperty('--panel-width', fitted + 'px');
        if (typeof map !== 'undefined') map.invalidateSize();
      }
    });

    // ========== End Panel Layout ==========

    } // end if (!window._catPopoutMode) — map + drawing tools only in normal mode

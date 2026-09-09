// Extracted from annotation-file-mode-runtime.js (Phase 2e: shell/init/map/sam3 bootstrap)
    async function saveProjectAndAnnotations() {
      if (!currentProject) {
        alert('No project loaded');
        return;
      }

      // Task A2 Step 3: a manual Save click while an autosave/retry is already
      // in flight would otherwise silently no-op (or race it) — tell the user
      // their changes are already covered by the in-progress save instead.
      if (window._catAutoSaveInFlight) {
        if (typeof showStatus === 'function') showStatus('A save is already in progress — your changes are included.', 'info');
        return;
      }

      try {
        // Prepare annotations data
        const annotationsToSave = [];
        drawnItems.eachLayer(layer => {
          if (layer.annotationData) {
            annotationsToSave.push(layer.annotationData);
          }
        });
        
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
          hasUnsavedChanges = true;
          await runAutoSave();
          if (hasUnsavedChanges) {
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

          showStatus(`✅ Saved ${annotationsToSave.length} annotation(s) to Oracle project #${projectId}`, 'success');
          return;
        }

        // File-mode combined JSON save
        const response = await fetch(`${serverUrl}/api/file-projects/project/${projectId}/save-combined`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            annotations: annotationsToSave,
            session_metadata: sessionMetadata
          })
        });
        
        if (!response.ok) {
          throw new Error('Failed to save');
        }
        
        const result = await response.json();
        
        // Download single combined JSON file
        const combinedBlob = new Blob([JSON.stringify(result.combined_file, null, 2)], { type: 'application/json' });
        const combinedUrl = URL.createObjectURL(combinedBlob);
        const combinedLink = document.createElement('a');
        combinedLink.href = combinedUrl;
        combinedLink.download = result.suggested_filename;
        combinedLink.click();
        URL.revokeObjectURL(combinedUrl);
        
        // Mark as saved - reset unsaved changes flag
        hasUnsavedChanges = false;
        lastSaveTime = Date.now();
        setAutoSaveBadge('saved', '✅ Saved');
        
        // Show success message in console instead of popup
        console.log(`✅ Project saved: ${result.suggested_filename} (${annotationsToSave.length} annotations)`);
        if (result.base_path) {
          console.log(`💡 Suggested location: ${result.base_path}`);
        }
        
        // Alert removed - file downloads automatically
        
      } catch (error) {
        console.error('Error saving:', error);
        alert(`❌ Error saving: ${error.message}`);
      }
    }
    
    // Toggle timer on click
    document.addEventListener('DOMContentLoaded', async () => {
      await initializeStorageBackend();

      // Show file-mode hint in autosave badge area so users know save = download
      if (storageBackend !== 'oracle') {
        const badge = document.getElementById('autoSaveBadge');
        if (badge) {
          badge.style.display = 'inline-block';
          badge.style.background = 'rgba(102,126,234,0.08)';
          badge.style.color = '#667eea';
          badge.textContent = '💾 File mode — save to download';
          badge.title = 'Click the Save button to download your annotations as JSON';
        }
      }

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
      
      // Check for project from localStorage (from project creator)
      const storedProject = localStorage.getItem('annotationProject');
      if (storedProject) {
        try {
          const projectBlob = new Blob([storedProject], { type: 'application/json' });
          const projectFile = new File([projectBlob], 'project.json', { type: 'application/json' });
          loadProjectFromFile(projectFile);
          localStorage.removeItem('annotationProject');
        } catch (error) {
          console.error('Error loading stored project:', error);
        }
      }

      // DB mode project bootstrap via URL parameter: ?project_id=123
      const urlParams = new URLSearchParams(window.location.search);
      const dbProjectId = urlParams.get('project_id') || urlParams.get('db_project_id');
      // Oracle mode has no useful "no project loaded" state on this page —
      // projects are opened from the project manager, not uploaded here.
      // Send the user there instead of showing an empty annotator. Skip the
      // redirect if a project was just handed off via the localStorage
      // bridge above (e.g. a one-off local file opened from the project
      // manager without a numeric project_id).
      if (storageBackend === 'oracle' && !dbProjectId && !storedProject) {
        window.location.href = '/project_creator.html';
        return;
      }
      if (storageBackend === 'oracle' && dbProjectId) {
        try {
          await loadProjectFromDatabase(dbProjectId);
          // Task 8 fix: honor the persisted "Auto-save enabled" preference
          // (Settings → Auto-save) on load. Previously this unconditionally
          // called startAutoSave() regardless of what the user had saved,
          // so disabling auto-save never survived a page reload — the
          // interval always re-armed as soon as a project loaded.
          let autoSaveEnabled = true;
          try {
            const saved = JSON.parse(localStorage.getItem('cat_autosave_settings') || '{}');
            if (saved.enabled === false) autoSaveEnabled = false;
          } catch (e) { /* fall back to enabled */ }
          if (autoSaveEnabled) {
            startAutoSave();
          } else {
            console.log('⏸️ Auto-save disabled in settings — not starting');
          }
        } catch (error) {
          console.error('Error loading DB project:', error);
          const overlay = document.getElementById('fullLoadingOverlay');
          if (overlay) overlay.style.display = 'none';
          document.getElementById('uploadStatus').innerHTML = `<span style="color: #ef4444;">❌ DB load failed: ${error.message}</span>`;
          // Task 11: uploadStatus lives inside the (often collapsed) upload
          // panel, so a failed initial project load could go unnoticed.
          // Also raise a toast, consistent with catFetch's failure UX.
          if (typeof showStatus === 'function') showStatus(`❌ Failed to load project: ${error.message}`, 'error');
        }
      }
      
      // Add event listeners for file upload
      document.getElementById('loadProjectBtn').addEventListener('click', () => {
        const fileInput = document.getElementById('projectFileInput');
        if (fileInput.files.length > 0) {
          loadProjectFromFile(fileInput.files[0]);
        } else {
          alert('Please select a project JSON file');
        }
      });
      
      // Add event listener for save button
      document.getElementById('saveProjectBtn').addEventListener('click', saveProjectAndAnnotations);
    });

    // Alias saveProject → saveProjectAndAnnotations so table-edit auto-save works
    // (annotation-runtime-annotations.js calls saveProject() after inline edits)
    function saveProject() {
      return saveProjectAndAnnotations();
    }
    
    // File mode uses simple local timer - no inactivity tracking needed
    
    // End timer when leaving page (file mode - local only)
    // Also warn user about unsaved changes
    window.addEventListener('beforeunload', (e) => {
      // Stop auto-save timer
      if (autoSaveIntervalId) clearInterval(autoSaveIntervalId);

      // Final best-effort save for Oracle mode (sendBeacon for async).
      // Task 8 review note: this is the one remaining save path that still
      // uses bulk-replace (delete-all-then-reinsert) instead of the
      // differential POST-new/PUT-changed sync the manual Save button and
      // auto-save now share. That's intentional, not an oversight:
      // sendBeacon is fire-and-forget POST-only with no response handling,
      // so it cannot sequence per-annotation PUTs/DELETEs the way
      // runAutoSave() does, and bulk-replace's DELETE-then-INSERT semantics
      // (see /annotations/bulk-replace in cat/api/db_projects.py) mean this
      // payload must include every current annotation, not just the dirty
      // ones -- omitting a synced-but-unchanged annotation would delete it
      // outright. The known cost: ids/versions of already-synced rows churn
      // on unload, which can 404 a stale reference held by another open
      // window/popout (it self-heals via Task 7's 404-recovery re-POST).
      if (isOracleProjectMode() && hasUnsavedChanges && currentProject?.project_id) {
        const annotationsToSave = [];
        drawnItems.eachLayer(layer => {
          if (layer.annotationData) annotationsToSave.push(layer.annotationData);
        });
        const projectId = currentProject.project_id;
        const payload = JSON.stringify({ annotations: annotationsToSave.map(normalizeAnnotationForDb) });
        navigator.sendBeacon(
          `${serverUrl}/api/db/projects/${projectId}/annotations/bulk-replace`,
          new Blob([payload], { type: 'application/json' })
        );
        console.log('📤 Final save beacon sent on page unload');
      }

      // Save timer state to localStorage for file mode
      if (timerState.sessionId) {
        localStorage.setItem('cat_timer_state', JSON.stringify({
          sessionId: timerState.sessionId,
          elapsedSeconds: timerState.elapsedSeconds,
          annotationCount: timerState.annotationCount,
          timestamp: Date.now()
        }));
      }
      
      // Show warning if project is loaded and there are unsaved changes
      if (currentProject && hasUnsavedChanges) {
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
      invalidateSize: ()=>{}, panTo: ()=>{},
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
      // Skip in bulk mode — v2-bulk.js handles it
      if (window.v2BulkMode && window.v2BulkMode.enabled) return;

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
    
    // Backspace mid-draw removes the last placed vertex (Task 7 fix: the drawing
    // hints bar advertises "Backspace undo vertex" but nothing bound the key —
    // leaflet-draw only exposes deleteLastVertex() via its "Delete last point" link).
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Backspace') return;
      // Never hijack Backspace while typing in a form control
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      const activeMode = drawControl && drawControl._toolbars && drawControl._toolbars.draw
        ? drawControl._toolbars.draw._activeMode
        : null;
      const handler = activeMode && activeMode.handler;
      if (handler && typeof handler.deleteLastVertex === 'function') {
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

    function toggleLayoutMode() {
      const isDocked = document.body.classList.contains('layout-docked');
      isDocked ? _setLayoutFloat() : _setLayoutDocked();
    }

    function _setLayoutDocked() {
      const savedWidth = parseInt(localStorage.getItem(PANEL_WIDTH_KEY)) || 420;
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
        const newWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidth + delta));
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

    // ========== End Panel Layout ==========

    } // end if (!window._catPopoutMode) — map + drawing tools only in normal mode

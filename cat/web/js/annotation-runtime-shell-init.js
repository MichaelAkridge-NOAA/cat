// Extracted from annotation-file-mode-runtime.js (Phase 2e: shell/init/map/sam3 bootstrap)
    async function saveProjectAndAnnotations() {
      if (!currentProject) {
        alert('No project loaded');
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
          const dbPayload = {
            annotations: annotationsToSave.map(normalizeAnnotationForDb)
          };

          const dbResponse = await fetch(`${serverUrl}/api/db/projects/${projectId}/annotations/bulk-replace`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dbPayload)
          });

          if (!dbResponse.ok) {
            const error = await dbResponse.json().catch(() => ({}));
            throw new Error(error.detail || 'Failed to save annotations to database');
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

          hasUnsavedChanges = false;
          lastSaveTime = Date.now();
          setAutoSaveBadge('saved', '✅ Saved');
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
      if (storageBackend === 'oracle' && dbProjectId) {
        try {
          await loadProjectFromDatabase(dbProjectId);
          startAutoSave();
        } catch (error) {
          console.error('Error loading DB project:', error);
          const overlay = document.getElementById('loadingOverlay');
          if (overlay) overlay.style.display = 'none';
          document.getElementById('uploadStatus').innerHTML = `<span style="color: #ef4444;">❌ DB load failed: ${error.message}</span>`;
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

      // Final best-effort save for Oracle mode (sendBeacon for async)
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

      // SAM3 Smart Grid: rectangle + magic wand + grid mode
      if (type === 'rectangle' && magicWandActive && typeof sam3Mode !== 'undefined' && sam3Mode === 'grid' && currentCOG) {
        console.log('🎯 SAM3 Smart Grid triggered');
        if (typeof window.runSAM3SmartGrid === 'function') {
          window.runSAM3SmartGrid(layer);
        }
        return;
      }

      // SAM3 Box: rectangle + magic wand + box mode
      if (type === 'rectangle' && magicWandActive && typeof sam3Mode !== 'undefined' && sam3Mode === 'box' && currentCOG) {
        console.log('📦 SAM3 Box segmentation triggered');
        if (typeof window.handleSAM3Box === 'function') {
          window.handleSAM3Box(layer);
          return;
        }
        // Fall through to normal drawing if SAM3 box handler unavailable
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
    
    // Add global ESC key handler to cancel drawing tools AND discard unsaved annotations
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Escape') return;
      // Skip if a modal is open
      if (document.getElementById('editModal')?.classList.contains('active')) return;
      if (document.getElementById('catConfirmOverlay')?.style.display === 'flex') return;

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
    
    // ========================================
    // SAM3 Magic Wand Tool Integration
    // ========================================
    let magicWandActive = false;
    let magicWandButton = null;
    
    // Create custom magic wand button
    async function initSAM3MagicWand() {
      // Check if SAM3 is available
      try {
        const response = await fetch(`${serverUrl}/api/sam/status`);
        if (!response.ok) {
          console.log('SAM3 not available');
          return;
        }
        const status = await response.json();
        if (!status.available) {
          console.log('SAM3 not available');
          return;
        }
        console.log('✅ SAM3 available - adding magic wand tool');
      } catch (error) {
        console.log('SAM3 API not available:', error);
        return;
      }
      
      // Add magic wand button to the draw toolbar
      const toolbar = document.querySelector('.leaflet-draw-toolbar-top');
      if (!toolbar) {
        console.warn('Draw toolbar not found, retrying...');
        setTimeout(initSAM3MagicWand, 500);
        return;
      }
      
      // Check if already added
      if (document.querySelector('.leaflet-draw-draw-magicwand')) {
        console.log('Magic wand button already exists');
        return;
      }
      
      const magicWandBtn = document.createElement('a');
      magicWandBtn.className = 'leaflet-draw-draw-magicwand';
      magicWandBtn.href = '#';
      magicWandBtn.title = 'S';
      magicWandBtn.setAttribute('role', 'button');
      magicWandBtn.textContent = 'S'; // Show SAM text
      magicWandBtn.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        toggleMagicWand();
        return false;
      };
      toolbar.appendChild(magicWandBtn);
      magicWandButton = magicWandBtn;
      
      console.log('✅ Magic wand button added to toolbar');
      showStatus('SAM3 Magic Wand ready - Press F or click the wand icon', 'success');
    }
    
    // SAM3 Mode and Settings
    let sam3Mode = 'point'; // 'point' or 'box'
    let sam3ModelSize = 'large';
    let sam3ConfidenceThreshold = 0.5;
    
    function toggleMagicWand() {
      magicWandActive = !magicWandActive;
      
      const sam3Panel = document.getElementById('sam3Panel');
      
      if (magicWandActive) {
        // Activate magic wand mode - open control panel
        magicWandButton?.classList.add('active');
        map.getContainer().style.cursor = 'crosshair';
        if (sam3Panel) sam3Panel.classList.add('active');
        showStatus('🪄 SAM3 Panel opened - Select mode and settings', 'info');
      } else {
        // Deactivate magic wand mode
        magicWandButton?.classList.remove('active');
        map.getContainer().style.cursor = '';
        if (sam3Panel) sam3Panel.classList.remove('active');
        showStatus('SAM3 Panel closed', 'info');
      }
    }
    
    function closeSAM3Panel() {
      magicWandActive = false;
      magicWandButton?.classList.remove('active');
      map.getContainer().style.cursor = '';
      const sam3Panel = document.getElementById('sam3Panel');
      if (sam3Panel) sam3Panel.classList.remove('active');
      showStatus('SAM3 Panel closed', 'info');
    }
    
    function setSAM3Mode(mode) {
      sam3Mode = mode;
      document.getElementById('sam3PointMode')?.classList.toggle('active', mode === 'point');
      document.getElementById('sam3BoxMode')?.classList.toggle('active', mode === 'box');
      document.getElementById('sam3GridMode')?.classList.toggle('active', mode === 'grid');
      
      console.log(`🎯 SAM3 mode changed to: ${mode}`);
      console.log(`📋 Current state: magicWandActive=${magicWandActive}, sam3Mode=${sam3Mode}, currentCOG=${currentCOG}`);
      
      if (mode === 'point') {
        showStatus('✅ Point Mode: Click directly on any coral to auto-segment it', 'info');
      } else if (mode === 'box' || mode === 'grid') {
        // Box/Grid mode - automatically activate the rectangle drawing tool
        const modeLabel = mode === 'grid' ? 'Smart Grid' : 'Box';
        showStatus(`✅ ${modeLabel} Mode: Draw a rectangle (tool auto-activated)`, 'info');
        
        // Auto-activate the rectangle drawing tool
        setTimeout(() => {
          const rectangleButton = document.querySelector('.leaflet-draw-draw-rectangle');
          if (rectangleButton) {
            rectangleButton.click();
            console.log(`📦 Rectangle tool auto-activated for ${mode} mode`);
          } else {
            console.warn('Rectangle tool button not found');
            showStatus(`⚠️ ${modeLabel} Mode: Manually click the rectangle tool (■) to draw`, 'info');
          }
        }, 100);
      }
    }
    
    function updateConfidenceDisplay() {
      const slider = document.getElementById('sam3Confidence');
      const display = document.getElementById('confidenceValue');
      if (slider && display) {
        const value = slider.value;
        display.textContent = value + '%';
        sam3ConfidenceThreshold = value / 100;
      }
    }
    
    function clearSAM3TempSegments() {
      // Remove all layers from drawnItems that have createdBy === 'SAM3' or 'SAM3-box'
      // and haven't been saved yet (not in annotations array)
      let removedCount = 0;
      
      drawnItems.eachLayer(function(layer) {
        // Check if this is a temp SAM3 segment (not saved)
        const layerId = layer._leaflet_id;
        const isSaved = annotations.some(ann => ann.leaflet_id === layerId);
        
        if (!isSaved && (layer.options.color === '#8b5cf6' || layer.options.fillColor === '#8b5cf6')) {
          drawnItems.removeLayer(layer);
          removedCount++;
        }
      });
      
      // Also clear currentAnnotation if it's a SAM3 temp
      if (currentAnnotation && (currentAnnotation.createdBy === 'SAM3' || currentAnnotation.createdBy === 'SAM3-box')) {
        currentAnnotation = null;
      }
      
      if (removedCount > 0) {
        showStatus(`🗑️ Cleared ${removedCount} temporary SAM3 segment(s)`, 'success');
        console.log(`Cleared ${removedCount} SAM3 temp segments`);
      } else {
        showStatus('No temporary segments to clear', 'info');
      }
    }
    
    // Update settings from panel controls
    document.addEventListener('DOMContentLoaded', function() {
      const modelSizeSelect = document.getElementById('sam3ModelSize');
      if (modelSizeSelect) {
        modelSizeSelect.addEventListener('change', function() {
          sam3ModelSize = this.value;
          showStatus(`Model size changed to ${this.value}`, 'info');
        });
      }
      
      // Keyboard shortcut: F key to toggle magic wand
      document.addEventListener('keydown', function(e) {
        if (e.key === 'f' || e.key === 'F') {
          // Don't trigger if typing in an input field
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            return;
          }
          e.preventDefault();
          toggleMagicWand();
        }
      });
    });
    
    // Handle map clicks for magic wand (Point Mode only)
    map.on('click', async function(e) {
      if (!magicWandActive) return;
      if (sam3Mode !== 'point') return; // Only process in point mode
      if (!currentCOG) {
        showStatus('Please load an orthomosaic first', 'error');
        return;
      }
      
      try {
        showLoading(true);
        showStatus('Loading SAM3 model...', 'info');
        
        // Ensure SAM3 model is loaded with selected size
        const loadResponse = await fetch(`${serverUrl}/api/sam/load-model`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model_size: sam3ModelSize })
        });
        
        if (!loadResponse.ok) {
          throw new Error('Failed to load SAM3 model');
        }
        
        showStatus('Running SAM3 segmentation...', 'info');
        
        // Get click coordinates
        const latlng = e.latlng;
        
        // Get map bounds and size for coordinate conversion
        const bounds = map.getBounds();
        const mapSize = map.getSize();
        const boundsNorth = bounds.getNorth();
        const boundsSouth = bounds.getSouth();
        const boundsEast = bounds.getEast();
        const boundsWest = bounds.getWest();
        
        console.log(`📍 Map info:`, {
          bounds: { north: boundsNorth, south: boundsSouth, east: boundsEast, west: boundsWest },
          size: { width: mapSize.x, height: mapSize.y },
          clickLatLng: { lat: latlng.lat, lng: latlng.lng }
        });
        
        // Get visible map area as image
        const mapContainer = map.getContainer();
        const mapCanvas = await html2canvas(mapContainer, {
          useCORS: true,
          allowTaint: true,
          logging: false,
          width: mapSize.x,
          height: mapSize.y
        });
        
        // Convert to base64
        const imageData = mapCanvas.toDataURL('image/png');
        
        // Calculate click position in image coordinates
        const containerPoint = map.latLngToContainerPoint(latlng);
        const click_x = Math.round(containerPoint.x);
        const click_y = Math.round(containerPoint.y);
        
        console.log(`🎯 Click at pixel (${click_x}, ${click_y}), canvas size: ${mapCanvas.width}x${mapCanvas.height}`);
        
        // Call SAM3 API
        const response = await fetch(`${serverUrl}/api/sam/click-segment`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            image_data: imageData,
            click_x: click_x,
            click_y: click_y,
            return_polygon: true,
            confidence_threshold: sam3ConfidenceThreshold
          })
        });
        
        if (!response.ok) {
          throw new Error(`SAM3 API error: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.success && data.polygon) {
          // Convert pixel polygon to geographic coordinates
          // data.polygon is array of [x, y] pixel coordinates
          // Use the actual canvas dimensions for accurate conversion
          const canvasWidth = mapCanvas.width;
          const canvasHeight = mapCanvas.height;
          
          console.log(`🗺️ Conversion params:`, {
            canvas: { width: canvasWidth, height: canvasHeight },
            bounds: { north: boundsNorth, south: boundsSouth, east: boundsEast, west: boundsWest }
          });
          
          console.log(`📊 SAM3 response data:`, {
            polygonType: typeof data.polygon,
            polygonLength: data.polygon?.length,
            firstValues: data.polygon?.slice(0, 6),
            isFlat: typeof data.polygon?.[0] === 'number'
          });
          
          // Check if polygon is in the right format
          if (!data.polygon || !Array.isArray(data.polygon) || data.polygon.length === 0) {
            throw new Error('Invalid polygon data from SAM3');
          }
          
          const geoCoords = [];
          
          // SAM3 returns flat array: [x1, y1, x2, y2, x3, y3, ...]
          if (typeof data.polygon[0] === 'number') {
            for (let i = 0; i < data.polygon.length; i += 2) {
              const px = data.polygon[i];
              const py = data.polygon[i + 1];
              
              if (px === undefined || py === undefined || isNaN(px) || isNaN(py)) {
                console.error(`Invalid pixel coordinates at index ${i}: px=${px}, py=${py}`);
                continue;
              }
              
              // Calculate lat/lng from pixel position
              // X maps to longitude (west to east)
              // Y maps to latitude (north to south, inverted)
              const lng = boundsWest + (px / canvasWidth) * (boundsEast - boundsWest);
              const lat = boundsNorth - (py / canvasHeight) * (boundsNorth - boundsSouth);
              
              geoCoords.push([lat, lng]);
            }
          } else {
            // Handle array of pairs format [[x, y], ...] or objects [{x, y}, ...]
            for (let idx = 0; idx < data.polygon.length; idx++) {
              const point = data.polygon[idx];
              let px, py;
              
              if (Array.isArray(point) && point.length >= 2) {
                px = point[0];
                py = point[1];
              } else if (typeof point === 'object' && point !== null) {
                px = point.x;
                py = point.y;
              } else {
                console.error(`Invalid point format at index ${idx}:`, point);
                continue;
              }
              
              if (px === undefined || py === undefined || isNaN(px) || isNaN(py)) {
                console.error(`Invalid pixel coordinates at index ${idx}: px=${px}, py=${py}`);
                continue;
              }
              
              const lng = boundsWest + (px / canvasWidth) * (boundsEast - boundsWest);
              const lat = boundsNorth - (py / canvasHeight) * (boundsNorth - boundsSouth);
              
              geoCoords.push([lat, lng]);
            }
          }
          
          console.log(`✨ SAM3 segmented ${geoCoords.length} points with ${(data.confidence * 100).toFixed(1)}% confidence`);
          if (geoCoords.length > 0) {
            console.log(`First point: geo (${geoCoords[0][0]}, ${geoCoords[0][1]})`);
          }
          
          // Validate coordinates
          if (geoCoords.length === 0) {
            throw new Error('No valid coordinates generated from SAM3 polygon');
          }
          
          const hasNaN = geoCoords.some(coord => isNaN(coord[0]) || isNaN(coord[1]));
          if (hasNaN) {
            throw new Error('Invalid coordinates generated - check console for debug info');
          }
          
          // Create polygon with annotations pane
          const polygon = L.polygon(geoCoords, {
            color: '#8b5cf6',
            weight: 3,
            fillOpacity: 0.4,
            fillColor: '#8b5cf6',
            pane: 'annotationsPane'
          });
          
          // Add to drawn items layer
          drawnItems.addLayer(polygon);
          
          // Force map to redraw to show the polygon
          polygon.addTo(map);
          map.fitBounds(polygon.getBounds(), { 
            padding: [50, 50],
            maxZoom: map.getZoom() // Don't zoom out
          });
          
          // Store as current annotation for the modal
          currentAnnotation = {
            layer: polygon,
            type: 'polygon',
            shape: 'Polygon',
            createdBy: 'SAM3',
            confidence: data.confidence
          };
          
          console.log(`✅ SAM3 polygon added to map with ${geoCoords.length} points`);
          console.log(`Polygon bounds:`, polygon.getBounds());
          
          // Small delay to ensure polygon is visible before opening modal
          setTimeout(() => {
            // Open edit modal to let user fill in annotation details
            const modal = document.getElementById('annotationModal');
            if (modal) {
              modal.style.display = 'block';
            }
          }, 100);
          
          showStatus(`✅ SAM3 segmented! ${(data.confidence * 100).toFixed(1)}% confidence - Fill in details`, 'success');
        } else {
          showStatus('No segment detected', 'warning');
        }
        
      } catch (error) {
        console.error('SAM3 error:', error);
        showStatus(`SAM3 error: ${error.message}`, 'error');
      } finally {
        showLoading(false);
      }
    });
    
    // Keyboard shortcut: F key for magic wand
    document.addEventListener('keydown', function(e) {
      if (e.key === 'f' || e.key === 'F') {
        // Don't trigger if typing in an input field
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        toggleMagicWand();
      }
    });
    
    // SAM3 disabled for file-based mode
    // setTimeout(initSAM3MagicWand, 100);
    
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

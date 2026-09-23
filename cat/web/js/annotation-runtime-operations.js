// Extracted from annotation-file-mode-runtime.js (Phase 2g: operations/utilities)
    function getFullPrecisionGeometry(layer) {
      let coordinates;
      const geoJson = layer.toGeoJSON();
      const geometryType = geoJson.geometry.type;
      
      // Extract coordinates directly from Leaflet (bypasses toGeoJSON precision loss)
      if (geometryType === 'LineString') {
        coordinates = layer.getLatLngs().map(latlng => [latlng.lng, latlng.lat]);
      } else if (geometryType === 'Polygon') {
        const ring = layer.getLatLngs()[0].map(latlng => [latlng.lng, latlng.lat]);
        // Close the ring per GeoJSON spec (first point == last point)
        if (ring.length > 0 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
          ring.push([...ring[0]]);
        }
        coordinates = [ring];
      } else if (geometryType === 'Point') {
        const latlng = layer.getLatLng();
        coordinates = [latlng.lng, latlng.lat];
      } else {
        // Fallback to toGeoJSON for unknown types
        console.warn('Unknown geometry type:', geometryType);
        coordinates = geoJson.geometry.coordinates;
      }
      
      return {
        type: geometryType,
        coordinates: coordinates
      };
    }
    
    // Map toolbar Edit / Delete. Project annotations carry their data on
    // layer.annotationData (never layer.options.objectId, which only the old
    // file mode set), so these handlers used to do nothing for them: the
    // shape moved or vanished on screen and came back after a refresh.
    map.on(L.Draw.Event.EDITED, function (event) {
      let changed = 0;
      event.layers.eachLayer(function (layer) {
        if (layer.annotationData) {
          layer.annotationData.geometry = getFullPrecisionGeometry(layer);
          layer.annotationData._syncStatus = 'pending';
          changed++;
          return;
        }
      });
      if (changed > 0) {
        hasUnsavedChanges = true;
        if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
        if (typeof saveProject === 'function') saveProject();
      }
    });

    map.on(L.Draw.Event.DELETED, async function (event) {
      const removed = [];
      event.layers.eachLayer(function (layer) {
        if (layer.annotationData) {
          removed.push({ layer, ann: layer.annotationData });
        }
      });
      if (removed.length === 0) return;

      // Several at once needs an explicit yes; deleting most of a project
      // from here is owner/admin only, same rule as File → Clear All.
      const putBack = () => {
        removed.forEach(item => {
          drawnItems.addLayer(item.layer);
          if (item.layer.setStyle && typeof getAnnotationLayerStyle === 'function') item.layer.setStyle(getAnnotationLayerStyle(item.ann));
          if (typeof labelsVisible !== 'undefined' && labelsVisible && typeof addLabelToAnnotation === 'function') addLabelToAnnotation(item.layer);
        });
      };
      const bulk = removed.length > 1;
      const most = removed.length >= Math.max(2, Math.ceil(annotations.length * 0.5));
      if (bulk && most && isOracleProjectMode() && window.catProjectRole !== 'owner') {
        putBack();
        showStatus('Deleting most of a project at once is limited to the project owner or an admin. Delete annotations individually instead.', 'error');
        return;
      }
      if (bulk && !await catConfirm(`Delete ${removed.length} annotations?`, { danger: true, ok: `Delete ${removed.length}` })) {
        putBack();
        showStatus('Nothing deleted', 'info');
        return;
      }

      const failed = [];
      for (const item of removed) {
        try {
          if (typeof isOracleProjectMode === 'function' && isOracleProjectMode()) {
            await deleteAnnotationFromDb(item.ann);
          }
          const ai = annotations.indexOf(item.ann);
          if (ai !== -1) annotations.splice(ai, 1);
          const pa = typeof getProjectAnnotations === 'function' ? getProjectAnnotations() : null;
          if (pa && pa !== annotations) {
            const pi = pa.indexOf(item.ann);
            if (pi !== -1) pa.splice(pi, 1);
          }
          if (typeof removeAnnotationLabel === 'function') removeAnnotationLabel(item.layer._leaflet_id);
        } catch (err) {
          // Server refused: put the shape back so the screen matches the DB.
          failed.push(err);
          drawnItems.addLayer(item.layer);
        }
      }
      if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
      if (typeof updateStatistics === 'function') updateStatistics();
      if (failed.length > 0) {
        showStatus(`❌ ${failed.length} annotation(s) could not be deleted: ${failed[0].message}`, 'error');
      } else {
        showStatus(`🗑️ Deleted ${removed.length} annotation(s)`, 'success');
      }
    });
    
    // Status messages — delegate to global toast system (defined in HTML <script>)
    function showStatus(message, type) {
      // Use the global toast-based showStatus if available
      if (typeof window._catToast === 'function') {
        window._catToast(message, type);
        return;
      }
      // Fallback: inline banner
      const statusDiv = document.getElementById('statusMessage');
      if (!statusDiv) return;
      statusDiv.className = 'status ' + type;
      statusDiv.textContent = message;
      statusDiv.style.display = 'block';
      if (type === 'success') {
        setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
      }
    }
    
    function showLoading(show) {
      document.getElementById('loadingOverlay').classList.toggle('active', show);
    }
    
    // Mark field as auto-filled with visual indicator
    function markFieldAsAutofilled(field) {
      if (field) {
        field.style.background = 'linear-gradient(to right, #e0f2fe 0%, #ffffff 100%)';
        field.style.borderColor = '#667eea';
        field.title = '✨ Auto-filled from database';
        
        // Remove the styling when user edits the field
        field.addEventListener('input', function() {
          field.style.background = '';
          field.style.borderColor = '';
          field.title = '';
        }, { once: true });
      }
    }
    
    // User identity helpers extracted to js/annotation-runtime-user.js

    // Load available COG files (filtered by site)
    async function loadCOGList() {
      try {
        const response = await fetch(`${serverUrl}/api/cog-files`);
        const data = await response.json();
        
        const select = document.getElementById('cogSelect');
        select.innerHTML = '';
        
        if (data.files && data.files.length > 0) {
          // Filter files to only show those matching the current site
          let filteredFiles = data.files;
          if (selectedSiteData && selectedSiteData.SITE_NAME) {
            const siteName = selectedSiteData.SITE_NAME;
            filteredFiles = data.files.filter(file => {
              // Match pattern like: 2025_GUA-2838_mos_cog.tif or 2025_GUA-2838_dem_cog.tif
              // Extract site name from file: YYYY_{SITE}_{type}_cog.tif
              const match = file.match(/\d{4}_([^_]+)_(?:mos|dem)_cog\.tif/);
              if (match) {
                return match[1] === siteName;
              }
              return false;
            });
            
            // Only show orthomosaics (_mos_cog.tif) in the dropdown, not DEMs
            filteredFiles = filteredFiles.filter(file => file.includes('_mos_cog.tif'));
          }
          
          if (filteredFiles.length > 0) {
            filteredFiles.forEach(file => {
              const option = document.createElement('option');
              option.value = 'data/' + file;  // Prepend data/ for TiTiler
              option.textContent = file;
              select.appendChild(option);
            });
            
            loadSelectedCOG();
            
            // Check if DEM exists for this site and load it
            loadDEMIfAvailable();
          } else {
            select.innerHTML = '<option value="">No orthomosaics for this site</option>';
          }
        } else {
          select.innerHTML = '<option value="">No COG files available</option>';
        }
      } catch (error) {
        console.error('Error loading COG list:', error);
        showStatus('Error loading COG file list', 'error');
      }
    }
    
    // Load selected COG
    async function loadSelectedCOG() {
      const cogPath = document.getElementById('cogSelect').value;
      if (!cogPath) return;
      
      currentCOG = cogPath;
      showLoading(true);
      
      try {
        // Remove existing COG layer
        if (cogLayer) {
          map.removeLayer(cogLayer);
        }
        
        // Fetch COG info to get bounds
        const infoUrl = `${serverUrl}/info?url=${encodeURIComponent(toGdalPath(cogPath))}`;
        const infoResponse = await fetch(infoUrl);
        const info = await infoResponse.json();
        
        // Create tile URL
        const tileUrl = `${serverUrl}/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(toGdalPath(cogPath))}`;
        
        console.log('📸 Loading COG:', cogPath);
        console.log('🔗 Tile URL template:', tileUrl);
        
        // Get current opacity setting
        const cogOpacity = document.getElementById('cogOpacity').value / 100;
        
        // Add new COG layer using cogPane for proper z-index
        cogLayer = L.tileLayer(tileUrl, {
          tileSize: 256,
          opacity: cogOpacity,
          maxZoom: 2000,
          pane: 'cogPane',  // Use custom pane (z-index 150) so shapefile (450) and annotations (650) appear on top
          errorTileUrl: '' // Don't show broken tile images
        }).addTo(map);
        
        // Listen for tile errors
        cogLayer.on('tileerror', function(error) {
          console.error('❌ COG tile failed to load:', error.tile.src);
        });
        
        // Listen for tile load events
        cogLayer.on('load', function() {
          console.log('COG tiles finished loading');
          // Check all shapefile layers still on map
          Object.keys(shapefileLayers).forEach(layerName => {
            const layerData = shapefileLayers[layerName];
            if (layerData && layerData.layer && map.hasLayer(layerData.layer)) {
              console.log(`Shapefile ${layerName} still on map after tiles loaded`);
            }
          });
        });
        
        console.log('COG layer added to cogPane (z-index 150)');
        console.log('COG layer pane setting:', cogLayer.options.pane);
        
        // Verify z-indices after COG is added
        console.log('Current pane z-indices:');
        console.log('  cogPane (bottom):', map.getPane('cogPane')?.style.zIndex || 'not found');
        console.log('  demPane (DEM):', map.getPane('demPane')?.style.zIndex || 'not found');
        console.log('  shapefilePane (middle):', map.getPane('shapefilePane')?.style.zIndex || 'not found');
        console.log('  annotationsPane (TOP - for drawing):', map.getPane('annotationsPane')?.style.zIndex || 'not found');
        console.log('  tilePane (default):', map.getPane('tilePane')?.style.zIndex || 'not found');
        
        // Check all layers on map
        console.log('Layers currently on map:');
        map.eachLayer(function(layer) {
          if (layer === cogLayer) console.log('  - COG tiles (in cogPane)');
          else if (layer === demLayer) console.log('  - DEM (in demPane)');
          else if (layer === drawnItems) console.log('  - Annotations (in annotationsPane)');
          else {
            // Check if it's one of the shapefile layers
            let isShapefile = false;
            Object.keys(shapefileLayers).forEach(layerName => {
              if (shapefileLayers[layerName].layer === layer) {
                console.log(`  - Shapefile: ${layerName} (in shapefilePane)`);
                isShapefile = true;
              }
            });
            if (!isShapefile) {
              console.log('  - Other layer:', layer.constructor.name);
            }
          }
        });
        
        // Enable the COG toggle
        document.getElementById('toggleCOG').disabled = false;
        
        // Fetch bounds in WGS84 from TileJSON endpoint
        try {
          const tilejsonUrl = `${serverUrl}/WebMercatorQuad/tilejson.json?url=${encodeURIComponent(cogPath)}`;
          const tilejsonResponse = await fetch(tilejsonUrl);
          const tilejson = await tilejsonResponse.json();
          
          if (tilejson && tilejson.bounds) {
            const b = tilejson.bounds;

            // Check for bogus / global-fallback bounds (LOCAL_CS or unknown CRS)
            const boundsCheck = (typeof areBoundsBogus === 'function')
              ? areBoundsBogus(b, null)
              : { bogus: (b[0] <= -179.9 && b[1] <= -89.9 && b[2] >= 179.9 && b[3] >= 89.9) };

            if (boundsCheck.bogus) {
              console.warn('⚠️ TileJSON returned bogus bounds:', b);
              const fallback = (typeof getMetadataFallbackCenter === 'function')
                ? getMetadataFallbackCenter()
                : null;
              if (fallback) {
                map.flyTo([fallback.lat, fallback.lon], 18, { duration: 1 });
                if (typeof showCrsWarning === 'function') showCrsWarning(boundsCheck.reason || 'global fallback bounds');
                showStatus('⚠️ COG bounds invalid — centred on site metadata', 'warning');
              } else {
                setTimeout(() => { zoomToSite(); }, 500);
                showStatus('COG loaded — bounds unreliable, zoom to site', 'warning');
              }
            } else {
              cogBounds = b; // Store for zoom button
              const leafletBounds = [[b[1], b[0]], [b[3], b[2]]];

              console.log('Geographic bounds from TileJSON:', b);
              map.flyToBounds(leafletBounds, {
                padding: [50, 50],
                maxZoom: 24,
                duration: 1
              });
              console.log('🎯 Auto-zoomed to COG bounds');
              showStatus('COG loaded - zoomed to imagery', 'success');
            }
          } else {
            // Fallback: try to zoom to shapefile if no COG bounds
            console.log('No COG bounds available, trying shapefile zoom...');
            setTimeout(() => {
              zoomToSite();
              console.log('🎯 Auto-zoomed to site (shapefile)');
            }, 500);
            showStatus('COG loaded - zoom to site to view imagery', 'info');
          }
        } catch (boundsError) {
          console.warn('Could not fetch bounds:', boundsError);
          // Fallback: try to zoom to shapefile
          setTimeout(() => {
            zoomToSite();
          }, 500);
          showStatus('COG loaded - zoom to site to view imagery', 'info');
        }
        
        // Load existing annotations for this COG
        loadAnnotations();
        
        showLoading(false);
      } catch (error) {
        console.error('Error loading COG:', error);
        showStatus('Error loading COG file', 'error');
        showLoading(false);
      }
    }
    
    // Load DEM if available for current site
    async function loadDEMIfAvailable() {
      try {
        // Get list of all COG files
        const response = await fetch(`${serverUrl}/api/cog-files`);
        const data = await response.json();
        
        if (!data.files || !selectedSiteData || !selectedSiteData.SITE_NAME) {
          return;
        }
        
        const siteName = selectedSiteData.SITE_NAME;
        
        // Find DEM file matching the site pattern: YYYY_{SITE}_dem_cog.tif
        const demFile = data.files.find(file => {
          const match = file.match(/\d{4}_([^_]+)_dem_cog\.tif/);
          return match && match[1] === siteName;
        });
        
        if (demFile) {
          console.log(`✓ Found DEM file for site ${siteName}: ${demFile}`);
          loadDEM('data/' + demFile);
        } else {
          console.log(`No DEM file found for site ${siteName}`);
          // Disable DEM toggle if no DEM available
          document.getElementById('toggleDEM').disabled = true;
          document.getElementById('toggleDEM').checked = false;
        }
      } catch (error) {
        console.error('Error checking for DEM:', error);
      }
    }
    
    // Load DEM layer with viridis colormap
    async function loadDEM(demPath) {
      try {
        // Remove existing DEM layer
        if (demLayer) {
          map.removeLayer(demLayer);
        }
        
        // Build tile URL with viridis colormap
        // For single-band DEMs, we need: bidx=1, colormap_name, and rescale
        let tileUrl = `${serverUrl}/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(demPath)}&bidx=1&colormap_name=viridis`;
        
        // Fetch statistics to get proper rescale values for the DEM
        try {
          const statsUrl = `${serverUrl}/statistics?url=${encodeURIComponent(demPath)}`;
          const statsResponse = await fetch(statsUrl);
          const stats = await statsResponse.json();
          
          console.log('DEM statistics:', stats);
          
          // Handle different statistics response formats
          const bandStats = stats.b1 || stats['1'] || (stats.statistics && stats.statistics[0]) || {};
          
          // Use percentiles if available (more robust than min/max with outliers)
          const min = bandStats.percentile_2 || bandStats.min;
          const max = bandStats.percentile_98 || bandStats.max;
          
          if (min !== undefined && max !== undefined && !isNaN(min) && !isNaN(max)) {
            // Round to avoid precision issues
            const rescaleMin = Math.round(min * 100) / 100;
            const rescaleMax = Math.round(max * 100) / 100;
            tileUrl += `&rescale=${rescaleMin},${rescaleMax}`;
            console.log(`✓ DEM rescale applied: ${rescaleMin} to ${rescaleMax}`);
          } else {
            console.warn('Could not determine DEM value range, colormap may not display correctly');
          }
        } catch (error) {
          console.warn('Could not fetch DEM statistics, using colormap without rescale:', error);
        }
        
        console.log('DEM tile URL:', tileUrl);
        
        // Get current opacity setting
        const demOpacity = document.getElementById('demOpacity').value / 100;
        
        // Create DEM layer using demPane for proper z-index (300 - between COG and shapefile)
        // But don't add it to map by default - let user toggle it on
        demLayer = L.tileLayer(tileUrl, {
          tileSize: 256,
          opacity: demOpacity,
          maxZoom: 2000,
          pane: 'demPane'
        });
        
        console.log('✓ DEM layer ready with viridis colormap (toggled off by default)');
        
        // Enable the DEM toggle but leave it unchecked
        document.getElementById('toggleDEM').disabled = false;
        document.getElementById('toggleDEM').checked = false;
        
      } catch (error) {
        console.error('Error loading DEM:', error);
        document.getElementById('toggleDEM').disabled = true;
      }
    }
    
    // Function to re-enable the last used drawing tool
    function reEnableDrawingTool() {
      // Pan (no tool armed) is the default after a save; re-arming the last
      // tool is opt-in via the 🔁 map button (window.catKeepToolAfterSave).
      if (!window.catKeepToolAfterSave) return;
      if (!lastDrawingTool) {
        console.log('No previous drawing tool to re-enable');
        return;
      }

      console.log('🔄 Re-enabling drawing tool:', lastDrawingTool);

      // Click the matching Leaflet Draw toolbar button to activate the tool.
      // This avoids referencing drawControl (which is scoped inside the
      // DOMContentLoaded callback in shell-init.js and not globally accessible).
      const toolClassMap = {
        'polyline': '.leaflet-draw-draw-polyline',
        'polygon': '.leaflet-draw-draw-polygon',
        'rectangle': '.leaflet-draw-draw-rectangle'
      };
      const selector = toolClassMap[lastDrawingTool];
      if (!selector) {
        console.log('Unknown tool type:', lastDrawingTool);
        return;
      }

      // Delay to let species field focus happen first (at 100ms). Kept in a
      // handle so picking another tool in the meantime cancels it.
      if (window._catReEnableTimer) clearTimeout(window._catReEnableTimer);
      window._catReEnableTimer = setTimeout(() => {
        window._catReEnableTimer = null;
        const activeElement = document.activeElement;

        const btn = document.querySelector(selector);
        if (btn) {
          btn.click();
          console.log('✅ Drawing tool re-enabled:', lastDrawingTool);
        } else {
          console.warn('Drawing toolbar button not found:', selector);
        }

        // Restore focus to the species field if it was focused
        if (activeElement && activeElement.id === 'spcode') {
          setTimeout(() => {
            activeElement.focus();
            console.log('🔍 Focus restored to species field');
          }, 10);
        }
      }, 250);
    }
    
    // ── Popout form save: geometry comes from BroadcastChannel, saved directly to DB ──
    // One popout save at a time: the create POST isn't idempotent, and a
    // double-click (or Enter + click) used to save the same shape twice.
    let _popoutSaveInFlight = false;
    async function _saveAnnotationFromPopout() {
      if (_popoutSaveInFlight) return;
      if (!window._popoutGeometry) {
        showStatus('Waiting for a shape from the main map window…', 'info');
        return;
      }
      _popoutSaveInFlight = true;
      try {
        await _saveAnnotationFromPopoutInner();
      } finally {
        _popoutSaveInFlight = false;
      }
    }

    async function _saveAnnotationFromPopoutInner() {
      const analyst = document.getElementById('analyst')?.value.trim();
      const obs_year = document.getElementById('obs_year')?.value;
      const mission_id = document.getElementById('mission_id')?.value.trim();
      const site = document.getElementById('site')?.value.trim();
      if (!analyst || !obs_year || !mission_id || !site) {
        showStatus('Please fill in all required fields (marked with *)', 'error');
        return;
      }
      const getV = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
      const getI = (id) => { const v = getV(id); return (v !== null && v !== '') ? parseInt(v) : null; };
      const getF = (id) => { const v = getV(id); return (v !== null && v !== '') ? parseFloat(v) : null; };

      const timeSeconds = (typeof getAnnotationTime === 'function') ? getAnnotationTime() : 0;

      // Drawn line length in metres, same as the main-window save path. The
      // popout has no Leaflet layer to measure, so compute it from the
      // broadcast GeoJSON coordinates instead — without this, lines saved from
      // the popout landed in the database with an empty LINE_LENGTH_M while
      // identical lines saved from the main window did not.
      let line_length_m = null;
      try {
        const g = window._popoutGeometry;
        if (g && g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length > 1) {
          let meters = 0;
          for (let i = 0; i < g.coordinates.length - 1; i++) {
            const a = L.latLng(g.coordinates[i][1], g.coordinates[i][0]);
            const b = L.latLng(g.coordinates[i + 1][1], g.coordinates[i + 1][0]);
            meters += a.distanceTo(b);
          }
          line_length_m = parseFloat(meters.toFixed(3));
        }
      } catch (e) { /* leave null — length is optional metadata */ }

      const annotationData = {
        colony_id: 0,
        geometry: window._popoutGeometry,
        type: window._popoutShapeType || 'polygon',
        line_length_m,
        analyst, obs_year: parseInt(obs_year), mission_id, site,
        transect: getV('transect') || null,
        segment: getI('segment'),
        seglength: getF('seglength'),
        segwidth: getF('segwidth'),
        no_colony: getI('no_colony') || 0,
        spcode: getV('spcode') || null,
        juvenile: getI('juvenile') || 0,
        juv_substrate: getV('juv_substrate') || null,
        remnant: getI('remnant') || 0,
        morph_code: getV('morph_code') || null,
        ex_bound: getI('ex_bound') || 0,
        old_dead: getI('olddead'),
        rdcause1: getV('rdcause1') || null, rd_1: getI('rd_1'),
        rdcause2: getV('rdcause2') || null, rd_2: getI('rd_2'),
        rdcause3: getV('rdcause3') || null, rd_3: getI('rd_3'),
        con_1: getV('con_1') || null, extent_1: getI('extent_1'), sev_1: getI('sev_1'),
        con_2: getV('con_2') || null, extent_2: getI('extent_2'), sev_2: getI('sev_2'),
        con_3: getV('con_3') || null, extent_3: getI('extent_3'), sev_3: getI('sev_3'),
        created_at: new Date().toISOString(),
        annotation_time_seconds: timeSeconds
      };

      try {
        if (typeof isOracleProjectMode === 'function' && isOracleProjectMode() &&
            typeof syncAnnotationToDb === 'function') {
          await syncAnnotationToDb(annotationData);
        }
        if (window._catChannel) {
          window._catChannel.postMessage({ type: 'annotations-changed', project_id: (typeof currentProject !== 'undefined' && currentProject) ? currentProject.project_id : null });
        }
        // Clear annotation-specific fields, keep session fields
        ['transect','segment','seglength','segwidth','no_colony','spcode','juvenile',
         'juv_substrate','remnant','fragment','morph_code','ex_bound','olddead',
         'rdcause1','rd_1','rdcause2','rd_2','rdcause3','rd_3',
         'con_1','extent_1','sev_1','con_2','extent_2','sev_2','con_3','extent_3','sev_3'
        ].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

        window._popoutGeometry = null;
        window._popoutShapeType = null;
        // Return to waiting state. Toggling both halves through the popout
        // module's single state setter is what makes the form come back on the
        // next shape — this used to hide #formSectionContent directly, and
        // nothing ever un-hid it, so the popout could only ever save once.
        if (typeof window._catSetPopoutFormState === 'function') {
          window._catSetPopoutFormState(false);
        }

        if (typeof incrementAnnotationCount === 'function') incrementAnnotationCount();
        if (typeof resetAnnotationTimer === 'function') resetAnnotationTimer();
        showStatus('✅ Annotation saved!', 'success');
        setTimeout(() => { document.getElementById('spcode')?.focus(); }, 100);
      } catch (err) {
        showStatus(`❌ Error saving annotation: ${err.message}`, 'error');
      }
    }

    // Save annotation (File Mode - no database)
    let _isSaving = false;
    async function saveAnnotation() {
      // In popout mode, geometry comes from BroadcastChannel (the popout has no map
      // of its own to draw on), not from a locally-drawn Leaflet layer. This used to
      // check for a mode literally named 'form', a name that predates the merge of
      // the separate form/table popouts into the single 'panel' mode opened by
      // openAnnotationPopout() (window._catPopoutMode is always 'panel' today, never
      // 'form') - so this branch was silent dead code and every save attempt from the
      // popout fell through to the currentAnnotation-based path below, which is never
      // set in a popout (confirmed: saving from the popout previously did nothing but
      // show "Please draw a shape first").
      if (window._catPopoutMode) {
        return _saveAnnotationFromPopout();
      }
      if (_isSaving) return;
      if (!currentAnnotation) {
        showStatus('Please draw a shape first', 'error');
        return;
      }
      _isSaving = true;
      
      // Validate required fields with visual feedback
      const requiredFields = ['analyst', 'obs_year', 'mission_id', 'site'];
      if (typeof catValidateRequired === 'function' && !catValidateRequired(requiredFields)) {
        showStatus('Please fill in all required fields (highlighted in red)', 'error');
        _isSaving = false;
        return;
      }
      const analyst = document.getElementById('analyst').value.trim();
      const obs_year = document.getElementById('obs_year').value;
      const mission_id = document.getElementById('mission_id').value.trim();
      const site = document.getElementById('site').value.trim();

      if (!analyst || !obs_year || !mission_id || !site) {
        showStatus('Please fill in all required fields (marked with *)', 'error');
        _isSaving = false;
        return;
      }
      
      // Get geometry from the layer with FULL PRECISION
      // IMPORTANT: Use getFullPrecisionGeometry() to preserve all decimal places
      // Leaflet's toGeoJSON() truncates to 6 decimals, causing ~1m precision loss
      const layer = currentAnnotation.layer || currentAnnotation;
      const geometry = getFullPrecisionGeometry(layer);

      // Compute drawn line length in meters (polylines only)
      let line_length_m = null;
      try {
        const annType = currentAnnotation.type || 'polygon';
        if ((annType === 'polyline' || annType === 'line') && layer.getLatLngs) {
          const latlngs = layer.getLatLngs();
          let meters = 0;
          for (let i = 0; i < latlngs.length - 1; i++) {
            meters += latlngs[i].distanceTo(latlngs[i + 1]);
          }
          line_length_m = parseFloat(meters.toFixed(3));
        }
      } catch (e) { /* ignore */ }
      
      // Get time spent on this annotation
      const annotationTimeSeconds = getAnnotationTime();
      
      // Helper function to safely get field value
      const getFieldValue = (id) => {
        const element = document.getElementById(id);
        if (!element) {
          console.warn(`Field '${id}' not found in form`);
          return null;
        }
        return element.value;
      };
      
      // Numeric fields where 0 is a real answer (e.g. 0% old dead). The old
      // `parseInt(v) || null` turned every 0 into null.
      const _intOrNull = (v) => {
        if (v === null || v === undefined || String(v).trim() === '') return null;
        const n = parseInt(v, 10);
        return Number.isNaN(n) ? null : n;
      };
      const _floatOrNull = (v) => {
        if (v === null || v === undefined || String(v).trim() === '') return null;
        const n = parseFloat(v);
        return Number.isNaN(n) ? null : n;
      };

      // Build annotation data (lowercase for file mode, matching expected format)
      const annotationData = {
        colony_id: annotations.length + 1,
        geometry: geometry,
        type: currentAnnotation.type || 'polygon',
        analyst: analyst,
        obs_year: parseInt(obs_year),
        mission_id: mission_id,
        site: site,
        transect: getFieldValue('transect') || null,
        segment: _intOrNull(getFieldValue('segment')),
        seglength: _floatOrNull(getFieldValue('seglength')),
        segwidth: _floatOrNull(getFieldValue('segwidth')),
        no_colony: parseInt(getFieldValue('no_colony')) || 0,
        spcode: getFieldValue('spcode') || null,
        juvenile: parseInt(getFieldValue('juvenile')) || 0,
        juv_substrate: getFieldValue('juv_substrate') || null,
        remnant: parseInt(getFieldValue('remnant')) || 0,
        morph_code: getFieldValue('morph_code') || null,
        ex_bound: parseInt(getFieldValue('ex_bound')) || 0,
        old_dead: _intOrNull(getFieldValue('olddead')),
        rdcause1: getFieldValue('rdcause1') || null,
        rd_1: _intOrNull(getFieldValue('rd_1')),
        rdcause2: getFieldValue('rdcause2') || null,
        rd_2: _intOrNull(getFieldValue('rd_2')),
        rdcause3: getFieldValue('rdcause3') || null,
        rd_3: _intOrNull(getFieldValue('rd_3')),
        con_1: getFieldValue('con_1') || null,
        extent_1: _intOrNull(getFieldValue('extent_1')),
        sev_1: _intOrNull(getFieldValue('sev_1')),
        con_2: getFieldValue('con_2') || null,
        extent_2: _intOrNull(getFieldValue('extent_2')),
        sev_2: _intOrNull(getFieldValue('sev_2')),
        con_3: getFieldValue('con_3') || null,
        extent_3: _intOrNull(getFieldValue('extent_3')),
        sev_3: _intOrNull(getFieldValue('sev_3')),
        line_length_m: line_length_m,       // Auto-computed from drawn geometry (polylines only)
        created_at: new Date().toISOString(),
        annotation_time_seconds: annotationTimeSeconds // Time spent on this annotation
      };
      
      // File mode: just add to local annotations array
      try {
        // Stable local identity for undo/redo: the undo op snapshots a copy at
        // push time, and the DB sync later REPLACES the array entry with the
        // server response object — _localId (round-tripped through
        // properties_json) is the only link that survives (Task 7 fix).
        annotationData._localId = 'loc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

        // Attach annotation data to the layer
        layer.annotationData = annotationData;

        // Style saved annotation with uniform line color
        if (layer.setStyle) {
          layer.setStyle(getAnnotationLayerStyle(annotationData)); // was a hard-coded 3px blue that ignored the line-width setting
        }

        // Add to annotations array (and projectAnnotations for autosave/poll sync)
        annotations.push(annotationData);
        if (typeof getProjectAnnotations === 'function') {
          const pa = getProjectAnnotations();
          if (pa && pa !== annotations) pa.push(annotationData);
        }

        // Push to undo stack so Ctrl+Z can revert
        if (typeof undoPushAdd === 'function') {
          undoPushAdd(annotationData, layer);
        }

        // Update table
        updateAnnotationTable();
        
        // Add click handler for editing (same as loaded annotations)
        layer.off('click'); // Remove any existing handlers
        layer.on('click', function(e) {
          L.DomEvent.stopPropagation(e);
          showAnnotationPopup(layer, e.latlng);
        });
        
        // Add label if labels are enabled
        if (labelsVisible) {
          addLabelToAnnotation(layer);
        }
        
        // Helper function to safely clear a field
        const clearField = (id, defaultValue = '') => {
          const element = document.getElementById(id);
          if (element) {
            element.value = defaultValue;
          }
        };
        
        // Clear form - preserve key fields (match database mode behavior)
        // Preserve: analyst, obs_year, mission_id, site
        // Clear: spcode and all other annotation-specific fields
        clearField('transect');
        clearField('segment');
        clearField('seglength');
        clearField('segwidth');
        clearField('no_colony', '0');
        // Remember last species for quick-repeat, then clear
        const _lastSpcode = document.getElementById('spcode')?.value || '';
        clearField('spcode');
        clearField('juvenile', '0');
        clearField('juv_substrate'); // Clear substrate field
        clearField('remnant', '0');
        clearField('morph_code');
        clearField('ex_bound', '0');
        clearField('olddead');
        clearField('rdcause1');
        clearField('rd_1');
        clearField('rdcause2');
        clearField('rd_2');
        clearField('rdcause3');
        clearField('rd_3');
        clearField('con_1');
        clearField('extent_1');
        clearField('sev_1');
        clearField('con_2');
        clearField('extent_2');
        clearField('sev_2');
        clearField('con_3');
        clearField('extent_3');
        clearField('sev_3');

        
        currentAnnotation = null;
        // Hide discard button (inline — hideDiscardButton lives in unloaded annotation-drawing.js)
        const _discardBtn = document.getElementById('discardAnnotationBtn');
        if (_discardBtn) _discardBtn.style.display = 'none';

        // Increment annotation count and reset timer for next annotation
        incrementAnnotationCount();
        resetAnnotationTimer();

        // Mark as having unsaved changes
        hasUnsavedChanges = true;
        if (isOracleProjectMode()) setAutoSaveBadge('pending', '🔵 Unsaved changes');
        
        // Quick-repeat: remember last species for rapid annotation of the same coral
        window._catLastSpcode = _lastSpcode;

        // Focus back on species field for quick data entry
        const speciesField = document.getElementById('spcode');
        if (speciesField) {
          setTimeout(() => {
            speciesField.focus();
          }, 100); // Small delay to ensure form is cleared first
        }
        
        showStatus(`✅ Annotation saved! Total: ${annotations.length} (${formatTime(annotationTimeSeconds)})`, 'success');
        console.log('💾 Annotation saved to local array:', annotationData);
        // Notify popout windows of the change
        if (window._catChannel) window._catChannel.postMessage({ type: 'annotations-changed', project_id: (typeof currentProject !== 'undefined' && currentProject) ? currentProject.project_id : null });
        
        // Re-enable the drawing tool AFTER save to keep workflow going
        // This is better than re-enabling immediately after drawing, as it allows
        // the user to fill out the form without the drawing tool interfering with clicks
        setTimeout(() => {
          reEnableDrawingTool();
        }, 150); // Small delay to ensure form focus is set first
        
      } catch (error) {
        console.error('Error saving annotation:', error);
        showStatus(`❌ Error: ${error.message}`, 'error');
      } finally {
        _isSaving = false;
      }
    }
    

    // Refresh annotations - clears and reloads from database
    // Called when a map file is (re)selected. It used to fetch the project's
    // annotations and ADD them as new layers without removing the existing
    // ones — every call duplicated the whole set on the map. The project's
    // annotations are already loaded; just re-sync them the safe way.
    function loadAnnotations() {
      return refreshAnnotations({ auto: true });
    }

    // opts.auto = triggered by another window (not a user click): never ask,
    // never discard — just skip if this tab has unsaved changes.
    async function refreshAnnotations(opts) {
      opts = opts || {};
      if (!currentCOG && !isOracleProjectMode()) return;

      // A refresh rebuilds everything from the server, so any change not yet
      // saved would be thrown away. It used to be — and refresh runs on its
      // own whenever a popout/other tab saves, so edits vanished silently.
      // Save first; if that can't finish, keep local work and skip refresh.
      if (isOracleProjectMode() && typeof countUnsavedAnnotations === 'function' && countUnsavedAnnotations() > 0) {
        const waitStart = Date.now();
        while (window._catAutoSaveInFlight && Date.now() - waitStart < 15000) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        if (!window._catAutoSaveInFlight) await runAutoSave();
        const stillUnsaved = countUnsavedAnnotations();
        if (stillUnsaved > 0) {
          if (opts.auto) {
            console.log(`Refresh from another window skipped: ${stillUnsaved} unsaved change(s) here`);
            return;
          }
          const discard = await catConfirm(
            `${stillUnsaved} change(s) in this tab could not be saved yet.\n\nRefreshing now will DISCARD them. Export a backup first if unsure.\n\nDiscard and refresh?`,
            { danger: true, ok: 'Discard & refresh' }
          );
          if (!discard) {
            showStatus(`Refresh cancelled — ${stillUnsaved} unsaved change(s) kept. Saving keeps retrying.`, 'info');
            return;
          }
        }
      }

      console.log('🔄 Refreshing annotations from database...');
      
      // Save current map view to restore after refresh
      const currentCenter = map.getCenter();
      const currentZoom = map.getZoom();
      
      try {
        const url = `${serverUrl}/api/db/projects/${currentProject.project_id}/annotations/geojson`;
        const response = await fetch(url);
        
        if (!response.ok) {
          console.error(`Failed to refresh annotations: ${response.status} ${response.statusText}`);
          return;
        }
        
        const geojson = await response.json();
        
        // Clear all existing annotation layers from the map
        const layersToRemove = [];
        drawnItems.eachLayer(layer => {
          if ((layer.options && layer.options.objectId) || layer.annotationData) {
            layersToRemove.push(layer);
          }
        });
        layersToRemove.forEach(layer => drawnItems.removeLayer(layer));
        
        // Clear all labels
        hideAllAnnotationLabels();
        
        // Normalize features: flatten GeoJSON properties to root level
        // so the table, labels, stats, and style all read fields correctly.
        const rawFeatures = geojson.features || [];
        annotations = rawFeatures.map((feature, idx) => {
          const gf = isOracleProjectMode() ? normalizeDbGeoJsonFeature(feature) : feature;
          const props = gf.properties || {};
          // Flatten: merge nested properties to root (same as
          // loadProjectAnnotations). No nested `.properties` copy is kept —
          // a second copy of the fields went stale on edit and was what got
          // saved (see normalizeAnnotationForDb).
          const flat = {
            ...props,
            geometry: gf.geometry
          };
          // Server-owned keys aren't user fields
          delete flat.annotation_id;
          delete flat.version;
          if (flat.client_uuid) flat._clientUuid = flat.client_uuid;
          delete flat.client_uuid;
          delete flat.created_by_user_id;
          delete flat.creator_display_name;
          // Carry over DB tracking fields (feature.id is the authoritative id)
          const dbId = gf.id ?? props.annotation_id;
          if (dbId != null) {
            flat.id = dbId;
            flat._dbAnnotationId = dbId;
          }
          // Mark as synced (came from DB) with version for poll comparison
          flat._syncStatus = 'synced';
          flat._dbAnnotationVersion = props.version ?? 1;
          flat._displayIndex = idx + 1;
          flat._creatorUserId = props.created_by_user_id ?? null;
          flat._creatorLabel = props.creator_display_name || 'Unknown';
          if (dbId != null && typeof annotationPayloadFingerprint === 'function') {
            flat._syncedFingerprint = annotationPayloadFingerprint(flat);
          }
          return flat;
        });

        // Keep projectAnnotations in sync for poll and auto-save
        if (typeof getProjectAnnotations === 'function') {
          const pa = getProjectAnnotations();
          if (pa) { pa.length = 0; annotations.forEach(a => pa.push(a)); }
        }

        console.log(`✅ Refreshed: ${annotations.length} annotations from database`);
        
        // Add all annotations to map
        annotations.forEach((ann, index) => {
          // Determine style based on species completeness
          const _refreshStyle = (typeof getAnnotationLayerStyle === 'function')
            ? getAnnotationLayerStyle(ann)
            : { color: '#3388ff', weight: 7, opacity: 0.8, fillOpacity: 0.3 };

          const geoFeature = { type: 'Feature', geometry: ann.geometry, properties: ann.properties || {} };
          const layer = L.geoJSON(geoFeature, {
            pane: 'annotationsPane',
            style: _refreshStyle
          });

          layer.eachLayer(l => {
            // Use annotationData (same as loadProjectAnnotations) so labels,
            // table, and edits all use the consistent flat format.
            l.annotationData = ann;
            l._creatorUserId = ann._creatorUserId;
            l._creatorLabel = ann._creatorLabel;
            drawnItems.addLayer(l);
            
            // Remove any existing click handlers before adding new one
            l.off('click');
            
            // Add click handler
            l.on('click', function(e) {
              L.DomEvent.stopPropagation(e);
              showAnnotationPopup(l, e.latlng);
            });
            
            // Add label if labels are enabled
            if (labelsVisible) {
              addLabelToAnnotation(l);
            }
          });
        });
        
        // Safety net: ensure all labels are restored
        if (labelsVisible && typeof showAllAnnotationLabels === 'function') {
          showAllAnnotationLabels();
        }
        
        // Update UI
        updateStatistics();
        updateAnnotationTable();
        if (typeof buildContributorVisibilityPanel === 'function') buildContributorVisibilityPanel();

        // IMPORTANT: Restore the previous map view to prevent jumping
        map.setView(currentCenter, currentZoom, { animate: false });
        
        console.log('✅ Annotations refreshed successfully (view preserved)');
        
      } catch (error) {
        console.error('Error refreshing annotations:', error);
        showStatus('Error refreshing annotations', 'error');
      }
    }
    
    // Expose for the multi-user poll banner's Refresh button (autosave.js)
    window.refreshAnnotationsFromDb = refreshAnnotations;

    // Clear all annotations
    async function clearAllAnnotations() {
      if (!currentCOG && !isOracleProjectMode()) {
        showStatus('No site loaded', 'error');
        return;
      }
      
      // Clearing a whole project (every annotator's work) is for the project
      // owner or an admin (both resolve to 'owner'). Editors can still delete
      // individual annotations.
      if (isOracleProjectMode() && window.catProjectRole !== 'owner') {
        showStatus('Only the project owner or an admin can clear all annotations. You can still delete individual annotations.', 'error');
        return;
      }

      if (annotations.length === 0) {
        showStatus('No annotations to clear', 'info');
        return;
      }
      
      const siteName = selectedSiteData?.SITE_NAME || 'current site';
      const count = annotations.length;
      
      if (!await catConfirm(`Delete all ${count} annotations for ${siteName}?\n\nThis action cannot be undone!`, { danger: true, ok: 'Delete All' })) {
        return;
      }
      
      console.log(`🗑️ Clearing all ${count} annotations for ${currentCOG}...`);
      
      try {
        if (isOracleProjectMode()) {
          // Soft-delete exactly the annotations shown here, one by one (each
          // is restorable). This used to call /bulk-replace with [], which
          // hard-deleted every row in the project — other users' too — and
          // then left every layer on the map (it only removed layers with
          // options.objectId, which project layers never have).
          const targets = annotations.slice();
          const failed = [];
          let done = 0;
          for (const ann of targets) {
            try {
              await deleteAnnotationFromDb(ann);
              done++;
            } catch (err) {
              failed.push({ ann, err });
            }
          }
          const failedSet = new Set(failed.map(f => f.ann));
          const layersToRemove = [];
          drawnItems.eachLayer(layer => {
            if (layer.annotationData && !failedSet.has(layer.annotationData)) layersToRemove.push(layer);
          });
          layersToRemove.forEach(layer => {
            if (typeof removeAnnotationLabel === 'function') removeAnnotationLabel(layer._leaflet_id);
            drawnItems.removeLayer(layer);
          });
          const keep = targets.filter(a => failedSet.has(a));
          annotations.length = 0;
          keep.forEach(a => annotations.push(a));
          const pa = typeof getProjectAnnotations === 'function' ? getProjectAnnotations() : null;
          if (pa && pa !== annotations) {
            pa.length = 0;
            keep.forEach(a => pa.push(a));
          }

          updateAnnotationTable();
          updateStatistics();
          if (failed.length > 0) {
            showStatus(`Deleted ${done}; ${failed.length} could not be deleted: ${failed[0].err.message}`, 'error');
          } else {
            showStatus(`✅ Deleted ${done} annotation(s) (soft-deleted — still recoverable in the database)`, 'success');
          }
          if (window._catChannel) window._catChannel.postMessage({ type: 'annotations-changed', project_id: currentProject.project_id });
          return;
        }

      } catch (error) {
        console.error('Error clearing annotations:', error);
        showStatus('Error clearing annotations', 'error');
      }
    }
    
    // Update statistics
    function updateStatistics() {
      const stats = {
        total: annotations.length,
        lines: 0,
        boxes: 0,
        polygons: 0
      };
      
      annotations.forEach(ann => {
        const shape = ann.properties?.SHAPE || ann.type || (ann.geometry && ann.geometry.type) || '';
        if (shape === 'Polyline' || shape === 'LineString' || shape === 'polyline') stats.lines++;
        else if (shape === 'Rectangle' || shape === 'rectangle') stats.boxes++;
        else if (shape === 'Polygon' || shape === 'polygon') stats.polygons++;
      });
      
      document.getElementById('statTotal').textContent = stats.total;
      document.getElementById('statLines').textContent = stats.lines;
      document.getElementById('statBoxes').textContent = stats.boxes;
      document.getElementById('statPolygons').textContent = stats.polygons;
      document.getElementById('annotationCount').textContent = stats.total;
      if (typeof window.updateNavAnnotationCount === 'function') window.updateNavAnnotationCount(stats.total);

      // Species breakdown
      const speciesCounts = {};
      annotations.forEach(ann => {
        // Flat fields are authoritative (a nested .properties copy can be stale)
        const p = ann;
        const sp = p.SPCODE || p.spcode || p.species_code || p.SPECIES_CODE || '';
        if (sp) speciesCounts[sp] = (speciesCounts[sp] || 0) + 1;
      });
      renderSpeciesBreakdown(speciesCounts, stats.total);
    }

    // Render species breakdown into stats panel
    function renderSpeciesBreakdown(speciesCounts, total) {
      let el = document.getElementById('speciesBreakdown');
      if (!el) {
        // Create it inside stats panel
        const statsPanel = document.getElementById('statsPanel');
        if (!statsPanel) return;
        el = document.createElement('div');
        el.id = 'speciesBreakdown';
        el.style.cssText = 'margin-top:8px;border-top:1px solid #dee2e6;padding-top:6px;';
        statsPanel.appendChild(el);
      }

      const entries = Object.entries(speciesCounts).sort((a, b) => b[1] - a[1]);
      if (entries.length === 0) {
        el.innerHTML = '<div style="font-size:11px;color:#999;">No species data</div>';
        return;
      }

      const getColor = (typeof catSpeciesColor === 'function') ? catSpeciesColor : () => '#667eea';
      const rows = entries.map(([sp, count]) => {
        const pct = Math.round((count / total) * 100);
        const color = getColor(sp);
        return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></span>
          <span style="font-size:11px;font-weight:600;color:#333;min-width:50px;">${sp}</span>
          <div style="flex:1;background:#eee;border-radius:2px;height:6px;overflow:hidden;">
            <div style="width:${pct}%;background:${color};height:100%;border-radius:2px;"></div>
          </div>
          <span style="font-size:10px;color:#666;min-width:24px;text-align:right;">${count}</span>
        </div>`;
      }).join('');

      el.innerHTML = `<div style="font-size:10px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Species (${entries.length})</div>${rows}`;
    }
    
    // updateAnnotationList removed — all callers now use updateAnnotationTable()
    // (defined in annotation-runtime-annotations.js with full 35-column rendering)
    
    
    
    
    
    // Clear form
    function clearForm() {
      // Preserve key fields: analyst, obs_year, mission_id, site
      // Only clear annotation-specific fields
      
      // DO NOT CLEAR: analyst, obs_year, mission_id, site
      // These should persist across multiple annotations
      
      document.getElementById('transect').value = '';
      document.getElementById('segment').value = '';
      document.getElementById('seglength').value = '';
      document.getElementById('segwidth').value = '';
      document.getElementById('no_colony').value = '0';
      document.getElementById('spcode').value = '';
      document.getElementById('juvenile').value = '0';
      document.getElementById('remnant').value = '0';
      document.getElementById('morph_code').value = '';
      document.getElementById('ex_bound').value = '0';
      document.getElementById('olddead').value = '';
      document.getElementById('rdcause1').value = '';
      document.getElementById('rd_1').value = '';
      document.getElementById('rdcause2').value = '';
      document.getElementById('rd_2').value = '';
      document.getElementById('rdcause3').value = '';
      document.getElementById('rd_3').value = '';
      document.getElementById('con_1').value = '';
      document.getElementById('extent_1').value = '';
      document.getElementById('sev_1').value = '';
      document.getElementById('con_2').value = '';
      document.getElementById('extent_2').value = '';
      document.getElementById('sev_2').value = '';
      document.getElementById('con_3').value = '';
      document.getElementById('extent_3').value = '';
      document.getElementById('sev_3').value = '';
      
      currentAnnotation = null;
      
      // Reset save button text
      const saveBtn = document.querySelector('button[onclick="saveAnnotation()"]');
      if (saveBtn) {
        saveBtn.textContent = '💾 Save Annotation';
        saveBtn.style.backgroundColor = '';
      }
    }
    
    
    // Export annotations as Shapefile (File Mode)
    async function exportShapefile() {
      // Collect all annotations from drawnItems
      const annotationsToExport = [];
      drawnItems.eachLayer(layer => {
        if (layer.annotationData) {
          annotationsToExport.push(layer.annotationData);
        }
      });
      
      if (annotationsToExport.length === 0) {
        showStatus('No annotations to export. Please draw and save some annotations first.', 'error');
        return;
      }
      
      try {
        showStatus('Exporting annotations to shapefile...', 'info');
        
        // Send annotations to backend for shapefile conversion
        const response = await fetch(`${serverUrl}/api/exports/shapefile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            annotations: annotationsToExport,
            project_name: currentProject?.project_name || 'annotations',
            site: currentProject?.site || 'unknown'
          })
        });
        
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Export failed: ${error}`);
        }
        
        // Download the zip file
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentProject?.project_name || 'annotations'}_shapefile.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showStatus(`✅ Exported ${annotationsToExport.length} annotations to shapefile!`, 'success');
        
      } catch (error) {
        console.error('Error exporting shapefile:', error);
        showStatus(`Error exporting shapefile: ${error.message}`, 'error');
        showStatus('Error exporting shapefile', 'error');
      }
    }
    
    // ── KML / GeoPackage Export (server round-trip, same shape as exportShapefile) ──
    async function _exportViaServer(endpoint, extension, label) {
      const annotationsToExport = [];
      drawnItems.eachLayer(layer => {
        if (layer.annotationData) annotationsToExport.push(layer.annotationData);
      });
      if (annotationsToExport.length === 0) {
        showStatus('No annotations to export. Please draw and save some annotations first.', 'error');
        return;
      }
      try {
        showStatus(`Exporting annotations to ${label}...`, 'info');
        const response = await fetch(`${serverUrl}/api/exports/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            annotations: annotationsToExport,
            project_name: currentProject?.project_name || 'annotations',
            site: currentProject?.site || 'unknown'
          })
        });
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Export failed: ${error}`);
        }
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentProject?.project_name || 'annotations'}_annotations.${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showStatus(`✅ Exported ${annotationsToExport.length} annotations to ${label}!`, 'success');
      } catch (error) {
        console.error(`Error exporting ${label}:`, error);
        showStatus(`Error exporting ${label}: ${error.message}`, 'error');
      }
    }
    function exportKML() { return _exportViaServer('kml', 'kml', 'KML'); }
    function exportGeoPackage() { return _exportViaServer('geopackage', 'gpkg', 'GeoPackage'); }

    // ── GeoJSON Export (client-side) ────────────────────────────────────────────
    function exportGeoJSON() {
      if (annotations.length === 0) {
        showStatus('No annotations to export.', 'error');
        return;
      }

      const features = annotations.map((ann, i) => ({
        type: 'Feature',
        id: i + 1,
        geometry: ann.geometry,
        properties: Object.fromEntries(
          Object.entries(ann).filter(([k]) => k !== 'geometry' && !k.startsWith('_'))
        )
      }));

      const geojson = { type: 'FeatureCollection', features };
      const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentProject?.project_name || 'annotations'}.geojson`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showStatus(`✅ Exported ${features.length} annotations as GeoJSON`, 'success');
    }

    // ── CSV Export (client-side) ─────────────────────────────────────────────────
    function exportCSV() {
      if (annotations.length === 0) {
        showStatus('No annotations to export.', 'error');
        return;
      }

      // Collect all unique keys across annotations (excluding geometry and internals)
      const excludeKeys = new Set(['geometry', '_displayIndex', '_dbAnnotationId', '_localId', '_syncStatus', '_dbAnnotationVersion', 'properties', 'feature']);
      const allKeys = new Set();
      annotations.forEach(ann => {
        Object.keys(ann).forEach(k => { if (!excludeKeys.has(k) && !k.startsWith('_')) allKeys.add(k); });
      });
      const columns = ['id', ...Array.from(allKeys).filter(k => k !== 'id')];

      // Build CSV
      const escape = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const rows = [columns.map(escape).join(',')];
      annotations.forEach((ann, i) => {
        const row = columns.map(col => {
          if (col === 'id') return i + 1;
          return escape(ann[col]);
        });
        rows.push(row.join(','));
      });

      const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentProject?.project_name || 'annotations'}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showStatus(`✅ Exported ${annotations.length} annotations as CSV`, 'success');
    }

    // ── Copy from last annotation ──
    // Fills per-annotation form fields (species, morph, conditions) from the most
    // recently saved annotation. Session fields (analyst, obs_year, site, etc.) are
    // left alone since they're already sticky.
    function copyFromLastAnnotation() {
      const src = annotations.length > 0 ? annotations[annotations.length - 1] : null;
      if (!src) {
        showStatus('No previous annotation to copy from', 'info');
        return;
      }

      const setField = (id, value) => {
        const el = document.getElementById(id);
        if (el && value != null && value !== '') el.value = value;
      };

      setField('spcode',       src.spcode || src.SPCODE || '');
      setField('morph_code',   src.morph_code || '');
      setField('juvenile',     src.juvenile ?? 0);
      setField('juv_substrate', src.juv_substrate || '');
      setField('remnant',      src.remnant ?? 0);
      setField('ex_bound',     src.ex_bound ?? 0);
      setField('olddead',      src.old_dead ?? '');
      setField('rdcause1',     src.rdcause1 || '');
      setField('rd_1',         src.rd_1 ?? '');
      setField('rdcause2',     src.rdcause2 || '');
      setField('rd_2',         src.rd_2 ?? '');
      setField('rdcause3',     src.rdcause3 || '');
      setField('rd_3',         src.rd_3 ?? '');
      setField('con_1',        src.con_1 || '');
      setField('extent_1',     src.extent_1 ?? '');
      setField('sev_1',        src.sev_1 ?? '');
      setField('con_2',        src.con_2 || '');
      setField('extent_2',     src.extent_2 ?? '');
      setField('sev_2',        src.sev_2 ?? '');
      setField('con_3',        src.con_3 || '');
      setField('extent_3',     src.extent_3 ?? '');
      setField('sev_3',        src.sev_3 ?? '');

      showStatus(`⎘ Copied from annotation #${annotations.length}`, 'success');
    }

    // Database mode functions removed - file mode uses index-based versions defined earlier
    
    // Auto-set current year
    document.getElementById('obs_year').value = new Date().getFullYear();
    
    // Add keyboard shortcut for saving (Ctrl+S or Cmd+S)
    document.addEventListener('keydown', function(e) {
      // Check for Ctrl+S (Windows/Linux) or Cmd+S (Mac)
      // Use toLowerCase() so Caps Lock doesn't break the shortcut
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); // Prevent browser's default save dialog
        // If there's an active drawn shape, save that annotation
        if (currentAnnotation) {
          saveAnnotation();
        } else {
          // No active shape — save the whole project (DB or file mode)
          if (typeof saveProjectAndAnnotations === 'function') {
            saveProjectAndAnnotations();
          } else if (typeof saveProject === 'function') {
            saveProject();
          } else {
            showStatus('No annotation to save — draw a shape or edit the table first', 'info');
          }
        }
      }

      // Drawing tool hotkeys: D = line, P = polygon, R = rectangle
      // Only when no input is focused and no modifier keys
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;

        const key = e.key.toLowerCase();
        // H = hand / pan: stop whatever tool is armed.
        if (key === 'h' && typeof window.catActivatePanTool === 'function') {
          e.preventDefault();
          window.catActivatePanTool();
          return;
        }
        const toolMap = {
          'd': '.leaflet-draw-draw-polyline',
          'p': '.leaflet-draw-draw-polygon',
          'r': '.leaflet-draw-draw-rectangle',
        };
        const selector = toolMap[key];
        if (selector) {
          e.preventDefault();
          const tool = { d: 'polyline', p: 'polygon', r: 'rectangle' }[key];
          // The toolbar button toggles: pressing R while the rectangle tool
          // is already armed used to switch it OFF. Leave it on instead.
          let alreadyActive = false;
          try {
            const active = drawControl && drawControl._toolbars && drawControl._toolbars.draw && drawControl._toolbars.draw._activeMode;
            alreadyActive = !!(active && active.handler && active.handler.type === tool);
          } catch (err) { /* ignore */ }
          if (alreadyActive) return;
          if (typeof window.catStopAllDrawing === 'function') window.catStopAllDrawing();
          const btn = document.querySelector(selector);
          if (btn) {
            btn.click();
            lastDrawingTool = tool;
          }
        }
      }
    });

    // Initialize
    // =========================================================================
    // SPECIES AUTOCOMPLETE
    // =========================================================================
    
    let autocompleteTimeout = null;
    let autocompleteSelectedIndex = -1;
    let autocompleteResults = [];
    
    // Inputs/autocomplete/onload runtime extracted to js/annotation-runtime-inputs-init.js

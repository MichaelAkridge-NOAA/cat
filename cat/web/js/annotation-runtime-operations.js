// Extracted from annotation-file-mode-runtime.js (Phase 2g: operations/utilities)
    function getFullPrecisionGeometry(layer) {
      let coordinates;
      const geoJson = layer.toGeoJSON();
      const geometryType = geoJson.geometry.type;
      
      // Extract coordinates directly from Leaflet (bypasses toGeoJSON precision loss)
      if (geometryType === 'LineString') {
        coordinates = layer.getLatLngs().map(latlng => [latlng.lng, latlng.lat]);
      } else if (geometryType === 'Polygon') {
        coordinates = [layer.getLatLngs()[0].map(latlng => [latlng.lng, latlng.lat])];
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
    
    map.on(L.Draw.Event.EDITED, function (event) {
      const layers = event.layers;
      layers.eachLayer(function (layer) {
        // Update annotation geometry with full precision
        const objectId = layer.options.objectId;
        if (objectId) {
          updateAnnotationGeometry(objectId, getFullPrecisionGeometry(layer));
        }
      });
    });
    
    map.on(L.Draw.Event.DELETED, function (event) {
      const layers = event.layers;
      layers.eachLayer(function (layer) {
        const objectId = layer.options.objectId;
        if (objectId) {
          deleteAnnotationFromDB(objectId);
        }
      });
    });
    
    // Status messages
    function showStatus(message, type) {
      const statusDiv = document.getElementById('statusMessage');
      statusDiv.className = 'status ' + type;
      statusDiv.textContent = message;
      statusDiv.style.display = 'block';
      
      if (type === 'success') {
        setTimeout(() => {
          statusDiv.style.display = 'none';
        }, 3000);
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
                map.setView([fallback.lat, fallback.lon], 18, { animate: true });
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
              map.fitBounds(leafletBounds, { 
                padding: [50, 50],
                maxZoom: 24,
                animate: true
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
      if (!lastDrawingTool) {
        console.log('No previous drawing tool to re-enable');
        return;
      }
      
      console.log('🔄 Re-enabling drawing tool:', lastDrawingTool);
      
      // Use a longer delay to ensure focus has been set on species field first
      // The species field focus happens at 100ms, so we wait 250ms to avoid stealing focus
      setTimeout(() => {
        // Store the currently focused element
        const activeElement = document.activeElement;
        
        // Get the appropriate draw handler based on tool type
        let drawHandler;
        let buttonClass;
        
        switch(lastDrawingTool) {
          case 'polyline':
            drawHandler = new L.Draw.Polyline(map, drawControl.options.draw.polyline);
            buttonClass = '.leaflet-draw-draw-polyline';
            break;
          case 'polygon':
            drawHandler = new L.Draw.Polygon(map, drawControl.options.draw.polygon);
            buttonClass = '.leaflet-draw-draw-polygon';
            break;
          case 'rectangle':
            drawHandler = new L.Draw.Rectangle(map, drawControl.options.draw.rectangle);
            buttonClass = '.leaflet-draw-draw-rectangle';
            break;
          default:
            console.log('Unknown tool type:', lastDrawingTool);
            return;
        }
        
        // Enable the drawing handler
        drawHandler.enable();
        
        // Add visual feedback - highlight the active button
        updateDrawingToolVisualFeedback(buttonClass);
        
        console.log('✅ Drawing tool re-enabled:', lastDrawingTool);
        
        // Restore focus to the species field if it was focused
        if (activeElement && activeElement.id === 'spcode') {
          // Use a tiny delay to ensure the drawing handler is fully enabled
          setTimeout(() => {
            activeElement.focus();
            console.log('🔍 Focus restored to species field');
          }, 10);
        }
        
      }, 250); // Longer delay to ensure species field gets focus first
    }
    
    // Save annotation (File Mode - no database)
    async function saveAnnotation() {
      if (!currentAnnotation) {
        showStatus('Please draw a shape first', 'error');
        return;
      }
      
      // Validate required fields
      const analyst = document.getElementById('analyst').value.trim();
      const obs_year = document.getElementById('obs_year').value;
      const mission_id = document.getElementById('mission_id').value.trim();
      const site = document.getElementById('site').value.trim();
      
      if (!analyst || !obs_year || !mission_id || !site) {
        showStatus('Please fill in all required fields (marked with *)', 'error');
        return;
      }
      
      // Get geometry from the layer with FULL PRECISION
      // IMPORTANT: Use getFullPrecisionGeometry() to preserve all decimal places
      // Leaflet's toGeoJSON() truncates to 6 decimals, causing ~1m precision loss
      const layer = currentAnnotation.layer || currentAnnotation;
      const geometry = getFullPrecisionGeometry(layer);
      
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
      
      // Build annotation data (lowercase for file mode, matching expected format)
      const annotationData = {
        geometry: geometry,
        type: currentAnnotation.type || 'polygon',
        analyst: analyst,
        obs_year: parseInt(obs_year),
        mission_id: mission_id,
        site: site,
        transect: getFieldValue('transect') || null,
        segment: parseInt(getFieldValue('segment')) || null,
        seglength: parseFloat(getFieldValue('seglength')) || null,
        segwidth: parseFloat(getFieldValue('segwidth')) || null,
        no_colony: parseInt(getFieldValue('no_colony')) || 0,
        spcode: getFieldValue('spcode') || null,
        juvenile: parseInt(getFieldValue('juvenile')) || 0,
        juv_substrate: getFieldValue('juv_substrate') || null,
        remnant: parseInt(getFieldValue('remnant')) || 0,
        fragment: parseInt(getFieldValue('fragment')) || 0,
        morph_code: getFieldValue('morph_code') || null,
        ex_bound: parseInt(getFieldValue('ex_bound')) || 0,
        old_dead: parseInt(getFieldValue('olddead')) || null,
        rdcause1: getFieldValue('rdcause1') || null,
        rd_1: parseInt(getFieldValue('rd_1')) || null,
        rdcause2: getFieldValue('rdcause2') || null,
        rd_2: parseInt(getFieldValue('rd_2')) || null,
        rdcause3: getFieldValue('rdcause3') || null,
        rd_3: parseInt(getFieldValue('rd_3')) || null,
        con_1: getFieldValue('con_1') || null,
        extent_1: parseInt(getFieldValue('extent_1')) || null,
        sev_1: parseInt(getFieldValue('sev_1')) || null,
        con_2: getFieldValue('con_2') || null,
        extent_2: parseInt(getFieldValue('extent_2')) || null,
        sev_2: parseInt(getFieldValue('sev_2')) || null,
        con_3: getFieldValue('con_3') || null,
        extent_3: parseInt(getFieldValue('extent_3')) || null,
        sev_3: parseInt(getFieldValue('sev_3')) || null,
        created_at: new Date().toISOString(),
        annotation_time_seconds: annotationTimeSeconds // Time spent on this annotation
      };
      
      // File mode: just add to local annotations array
      try {
        // Attach annotation data to the layer
        layer.annotationData = annotationData;
        
        // Add to annotations array
        annotations.push(annotationData);
        
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
        clearField('spcode'); // Clear species field
        clearField('juvenile', '0');
        clearField('juv_substrate'); // Clear substrate field
        clearField('remnant', '0');
        clearField('fragment', '0');
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
        
        // Increment annotation count and reset timer for next annotation
        incrementAnnotationCount();
        resetAnnotationTimer();
        
        // Mark as having unsaved changes
        hasUnsavedChanges = true;
        if (isOracleProjectMode()) setAutoSaveBadge('pending', '🔵 Unsaved changes');
        
        // Focus back on species field for quick data entry
        const speciesField = document.getElementById('spcode');
        if (speciesField) {
          setTimeout(() => {
            speciesField.focus();
          }, 100); // Small delay to ensure form is cleared first
        }
        
        showStatus(`✅ Annotation saved! Total: ${annotations.length} (${formatTime(annotationTimeSeconds)})`, 'success');
        console.log('💾 Annotation saved to local array:', annotationData);
        
        // Re-enable the drawing tool AFTER save to keep workflow going
        // This is better than re-enabling immediately after drawing, as it allows
        // the user to fill out the form without the drawing tool interfering with clicks
        setTimeout(() => {
          reEnableDrawingTool();
        }, 150); // Small delay to ensure form focus is set first
        
      } catch (error) {
        console.error('Error saving annotation:', error);
        showStatus(`❌ Error: ${error.message}`, 'error');
      }
    }
    
    // Load annotations from database (initial load - adds to existing)
    async function loadAnnotations() {
      if (!currentCOG && !isOracleProjectMode()) return;
      
      try {
        let url;
        let response;

        if (isOracleProjectMode()) {
          const projectId = currentProject.project_id;
          url = `${serverUrl}/api/db/projects/${projectId}/annotations/geojson`;
          console.log('Loading annotations from DB project:', url);
          response = await fetch(url);
        } else {
          // Try with current path first, then with data/ prefix for backward compatibility
          url = `${serverUrl}/api/annotations/geojson?ortho_file=${encodeURIComponent(currentCOG)}`;
          console.log('Loading annotations from:', url);
          response = await fetch(url);

          // If no annotations found and path doesn't have data/ prefix, try with it
          if (response.ok) {
            const testData = await response.json();
            if (testData.features && testData.features.length === 0 && !currentCOG.startsWith('data/')) {
              console.log('No annotations with filename only, trying with data/ prefix...');
              url = `${serverUrl}/api/annotations/geojson?ortho_file=${encodeURIComponent('data/' + currentCOG)}`;
              response = await fetch(url);
            } else {
              // Reset response if we already have data
              response = await fetch(`${serverUrl}/api/annotations/geojson?ortho_file=${encodeURIComponent(currentCOG)}`);
            }
          }
        }
        
        // Check if response is OK before parsing
        if (!response.ok) {
          console.error(`Failed to load annotations: ${response.status} ${response.statusText}`);
          console.error('Request URL:', url);
          const errorText = await response.text();
          console.error('Error response:', errorText);
          try {
            const errorData = JSON.parse(errorText);
            console.error('Error details:', errorData);
          } catch (e) {
            console.error('Could not parse error as JSON');
          }
          // Don't throw - just return early so we don't break the UI
          return;
        }
        
        const geojson = await response.json();
        
        // Store existing layer IDs to avoid duplicates
        const existingIds = new Set();
        drawnItems.eachLayer(layer => {
          if (layer.options && layer.options.objectId) {
            existingIds.add(layer.options.objectId);
          }
        });
        
        // Add annotations to map
        annotations = isOracleProjectMode()
          ? (geojson.features || []).map(normalizeDbGeoJsonFeature)
          : (geojson.features || []);
        
        console.log(`Loading ${annotations.length} annotations from database`);
        
        annotations.forEach(feature => {
          // Skip if already on map
          if (existingIds.has(feature.id)) {
            console.log(`Annotation ${feature.id} already on map, skipping`);
            return;
          }
          
          const layer = L.geoJSON(feature, {
            pane: 'annotationsPane',  // Use custom pane for proper z-index
            style: {
              color: feature.properties.SHAPE === 'Polyline' ? '#f357a1' : 
                     feature.properties.SHAPE === 'Rectangle' ? '#f59e0b' : '#667eea',
              weight: 2,
              fillOpacity: 0.3
            },
            objectId: feature.id
          });
          
          layer.eachLayer(l => {
            l.options.objectId = feature.id;
            l.feature = feature;  // Store feature data on layer
            drawnItems.addLayer(l);
            
            // Remove any existing click handlers before adding new one
            l.off('click');
            
            // Add click handler for editing
            l.on('click', function(e) {
              L.DomEvent.stopPropagation(e);  // Prevent map click
              selectAnnotationForEdit(feature.id);
            });
            
            // Add popup with info
            const popup = `
              <b>ID:</b> ${feature.id}<br>
              <b>Type:</b> ${feature.properties.SHAPE}<br>
              <b>Species:</b> ${feature.properties.SPCODE || 'N/A'}<br>
              <b>Site:</b> ${feature.properties.SITE}<br>
              <b>Analyst:</b> ${feature.properties.ANALYST}<br>
              <small style="color: #666;">Click to edit</small>
            `;
            l.bindPopup(popup);
            
            // Add label if labels are enabled
            if (labelsVisible) {
              addLabelToAnnotation(l);
            }
          });
        });
        
        // Update statistics
        updateStatistics();
        
        // Update annotation list
        updateAnnotationList();
        
      } catch (error) {
        console.error('Error loading annotations:', error);
      }
    }
    
    // Refresh annotations - clears and reloads from database
    async function refreshAnnotations() {
      if (!currentCOG && !isOracleProjectMode()) return;
      
      console.log('🔄 Refreshing annotations from database...');
      
      // Save current map view to restore after refresh
      const currentCenter = map.getCenter();
      const currentZoom = map.getZoom();
      
      try {
        const url = isOracleProjectMode()
          ? `${serverUrl}/api/db/projects/${currentProject.project_id}/annotations/geojson`
          : `${serverUrl}/api/annotations/geojson?ortho_file=${encodeURIComponent(currentCOG)}`;
        const response = await fetch(url);
        
        if (!response.ok) {
          console.error(`Failed to refresh annotations: ${response.status} ${response.statusText}`);
          return;
        }
        
        const geojson = await response.json();
        
        // Clear all existing annotation layers from the map
        drawnItems.eachLayer(layer => {
          if (layer.options && layer.options.objectId) {
            drawnItems.removeLayer(layer);
          }
        });
        
        // Clear all labels
        hideAllAnnotationLabels();
        
        // Update annotations array
        annotations = isOracleProjectMode()
          ? (geojson.features || []).map(normalizeDbGeoJsonFeature)
          : (geojson.features || []);
        
        console.log(`✅ Refreshed: ${annotations.length} annotations from database`);
        
        // Add all annotations to map
        annotations.forEach(feature => {
          // Calculate expected visual position from coordinates
          let expectedCenter = null;
          if (feature.geometry.type === 'LineString' && feature.geometry.coordinates.length >= 2) {
            const c = feature.geometry.coordinates;
            expectedCenter = L.latLng(
              (c[0][1] + c[c.length-1][1]) / 2,
              (c[0][0] + c[c.length-1][0]) / 2
            );
          } else if (feature.geometry.type === 'Polygon' && feature.geometry.coordinates.length > 0) {
            const coords = feature.geometry.coordinates[0];
            let latSum = 0, lngSum = 0;
            coords.forEach(c => { lngSum += c[0]; latSum += c[1]; });
            expectedCenter = L.latLng(latSum / coords.length, lngSum / coords.length);
          }
          
          // Debug: Log loading
          console.log(`📥 Loading annotation ${feature.id} from DB`);
          
          const layer = L.geoJSON(feature, {
            pane: 'annotationsPane',
            style: {
              color: feature.properties.SHAPE === 'Polyline' ? '#f357a1' : 
                     feature.properties.SHAPE === 'Rectangle' ? '#f59e0b' : '#667eea',
              weight: 2,
              fillOpacity: 0.3
            },
            objectId: feature.id
          });
          
          layer.eachLayer(l => {
            l.options.objectId = feature.id;
            l.feature = feature;
            drawnItems.addLayer(l);
            

            
            // Remove any existing click handlers before adding new one
            l.off('click');
            
            // Add click handler for editing
            l.on('click', function(e) {
              L.DomEvent.stopPropagation(e);
              selectAnnotationForEdit(feature.id);
            });
            
            // Add popup
            const popup = `
              <b>ID:</b> ${feature.id}<br>
              <b>Type:</b> ${feature.properties.SHAPE}<br>
              <b>Species:</b> ${feature.properties.SPCODE || 'N/A'}<br>
              <b>Site:</b> ${feature.properties.SITE}<br>
              <b>Analyst:</b> ${feature.properties.ANALYST}<br>
              <small style="color: #666;">Click to edit</small>
            `;
            l.bindPopup(popup);
            
            // Add label if labels are enabled
            if (labelsVisible) {
              addLabelToAnnotation(l);
            }
          });
        });
        
        // Update UI
        updateStatistics();
        updateAnnotationList();
        
        // IMPORTANT: Restore the previous map view to prevent jumping
        map.setView(currentCenter, currentZoom, { animate: false });
        
        console.log('✅ Annotations refreshed successfully (view preserved)');
        
      } catch (error) {
        console.error('Error refreshing annotations:', error);
        showStatus('Error refreshing annotations', 'error');
      }
    }
    
    // Clear all annotations
    async function clearAllAnnotations() {
      if (!currentCOG && !isOracleProjectMode()) {
        showStatus('No site loaded', 'error');
        return;
      }
      
      if (annotations.length === 0) {
        showStatus('No annotations to clear', 'info');
        return;
      }
      
      const siteName = selectedSiteData?.SITE_NAME || 'current site';
      const count = annotations.length;
      
      if (!confirm(`⚠️ Delete all ${count} annotations for ${siteName}?\n\nThis action cannot be undone!`)) {
        return;
      }
      
      console.log(`🗑️ Clearing all ${count} annotations for ${currentCOG}...`);
      
      try {
        if (isOracleProjectMode()) {
          const projectId = currentProject.project_id;
          const response = await fetch(`${serverUrl}/api/db/projects/${projectId}/annotations/bulk-replace`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ annotations: [] })
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || 'Failed to clear DB annotations');
          }

          drawnItems.eachLayer(layer => {
            if (layer.options && layer.options.objectId) {
              drawnItems.removeLayer(layer);
            }
          });
          annotations = [];
          
          // Clear all labels from map
          if (typeof hideAllAnnotationLabels === 'function') {
            hideAllAnnotationLabels();
          }
          
          updateAnnotationList();
          updateStatistics();
          showStatus('✅ Cleared all project annotations', 'success');
          return;
        }

        // Delete each annotation from the database
        let deletedCount = 0;
        let failedCount = 0;
        
        for (const annotation of annotations) {
          const objectId = annotation.id;
          try {
            const response = await fetch(`${serverUrl}/api/annotations/${objectId}`, {
              method: 'DELETE'
            });
            
            if (response.ok) {
              deletedCount++;
            } else {
              failedCount++;
              console.error(`Failed to delete annotation ${objectId}`);
            }
          } catch (error) {
            failedCount++;
            console.error(`Error deleting annotation ${objectId}:`, error);
          }
        }
        
        // Clear all annotation layers from the map
        drawnItems.eachLayer(layer => {
          if (layer.options && layer.options.objectId) {
            drawnItems.removeLayer(layer);
          }
        });
        
        // Clear annotations array
        annotations = [];
        
        // Clear all labels from map
        if (typeof hideAllAnnotationLabels === 'function') {
          hideAllAnnotationLabels();
        }
        
        // Update UI
        updateAnnotationList();
        updateStatistics();
        
        if (failedCount === 0) {
          showStatus(`✅ Cleared all ${deletedCount} annotations`, 'success');
          console.log(`✅ Successfully deleted ${deletedCount} annotations`);
        } else {
          showStatus(`⚠️ Deleted ${deletedCount} annotations, ${failedCount} failed`, 'warning');
          console.warn(`⚠️ Deleted ${deletedCount}, failed ${failedCount}`);
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
        if (ann.properties.SHAPE === 'Polyline') stats.lines++;
        else if (ann.properties.SHAPE === 'Rectangle') stats.boxes++;
        else if (ann.properties.SHAPE === 'Polygon') stats.polygons++;
      });
      
      document.getElementById('statTotal').textContent = stats.total;
      document.getElementById('statLines').textContent = stats.lines;
      document.getElementById('statBoxes').textContent = stats.boxes;
      document.getElementById('statPolygons').textContent = stats.polygons;
      document.getElementById('annotationCount').textContent = stats.total;
    }
    
    // Update annotation table
    function updateAnnotationList() {
      const tbody = document.getElementById('annotationTableBody');
      
      if (annotations.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="12" style="text-align: center; padding: 20px; color: #6c757d;">
              No annotations yet - draw on the map to create one
            </td>
          </tr>
        `;
        return;
      }
      
      tbody.innerHTML = '';
      
      annotations.forEach(ann => {
        const row = document.createElement('tr');
        row.dataset.id = ann.id;
        row.onclick = (e) => {
          if (!e.target.closest('button')) {
            document.querySelectorAll('.annotation-table tbody tr').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');
            selectAnnotationForEdit(ann.id);
          }
        };
        
        row.innerHTML = `
          <td><strong>${ann.id}</strong></td>
          <td>${ann.properties.SHAPE || '-'}</td>
          <td>${ann.properties.SPCODE || '-'}</td>
          <td>${ann.properties.ANALYST || '-'}</td>
          <td>${ann.properties.SITE || '-'}</td>
          <td>${ann.properties.OBS_YEAR || '-'}</td>
          <td>${ann.properties.MISSION_ID || '-'}</td>
          <td>${ann.properties.SEGMENT || '-'}</td>
          <td>${ann.properties.TRANSECT || '-'}</td>
          <td>${ann.properties.MORPH_CODE || '-'}</td>
          <td>${ann.properties.OLDDEAD || '-'}</td>
          <td>
            <div class="actions">
              <button class="btn-sm btn-edit" onclick="event.stopPropagation(); openEditModal(${ann.id})">Edit</button>
              <button class="btn-sm btn-delete" onclick="event.stopPropagation(); deleteAnnotation(${ann.id})">Del</button>
            </div>
          </td>
        `;
        
        tbody.appendChild(row);
      });
    }
    
    // Zoom to annotation
    function zoomToAnnotation(objectId) {
      drawnItems.eachLayer(layer => {
        if (layer.options.objectId === objectId) {
          map.fitBounds(layer.getBounds());
          layer.openPopup();
        }
      });
    }
    
    // Delete annotation
    // Database mode delete function (not used in file mode, kept for compatibility)
    async function deleteAnnotationDB(objectId) {
      if (!confirm('Delete this annotation?')) return;
      
      await deleteAnnotationFromDB(objectId);
    }
    
    async function deleteAnnotationFromDB(objectId) {
      showLoading(true);
      
      try {
        let response;
        if (isOracleProjectMode()) {
          response = await fetch(`${serverUrl}/api/db/projects/${currentProject.project_id}/annotations/${objectId}`, {
            method: 'DELETE'
          });
        } else {
          response = await fetch(`${serverUrl}/api/annotations/${objectId}`, {
            method: 'DELETE'
          });
        }
        
        if (response.ok) {
          showStatus(`Annotation ${objectId} deleted`, 'success');
          
          // Remove from map
          drawnItems.eachLayer(layer => {
            if (layer.options && layer.options.objectId === objectId) {
              drawnItems.removeLayer(layer);
            }
          });
          
          // Remove label if exists
          removeAnnotationLabel(objectId);
          
          // Remove from annotations array
          const index = annotations.findIndex(ann => ann.id === objectId);
          if (index !== -1) {
            annotations.splice(index, 1);
          }
          
          // Update UI
          updateStatistics();
          updateAnnotationList();
          
          console.log(`✅ Annotation ${objectId} deleted from map and database`);
        } else {
          const errorData = await response.json();
          showStatus(`Error deleting annotation: ${errorData.detail || 'Unknown error'}`, 'error');
        }
      } catch (error) {
        console.error('Error deleting annotation:', error);
        showStatus('Error deleting annotation', 'error');
      } finally {
        showLoading(false);
      }
    }
    
    // Update annotation geometry
    async function updateAnnotationGeometry(objectId, geometry) {
      showLoading(true);
      try {
        let response;
        if (isOracleProjectMode()) {
          response = await fetch(`${serverUrl}/api/db/projects/${currentProject.project_id}/annotations/${objectId}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              feature: {
                type: 'Feature',
                geometry,
                properties: {}
              }
            })
          });
        } else {
          response = await fetch(`${serverUrl}/api/annotations/${objectId}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ GEOMETRY: geometry })
          });
        }
        
        if (response.ok) {
          showStatus(`Annotation ${objectId} geometry updated`, 'success');
          
          // Update geometry in annotations array
          const index = annotations.findIndex(ann => ann.id === objectId);
          if (index !== -1) {
            annotations[index].geometry = geometry;
          }
          
          console.log(`✅ Annotation ${objectId} geometry updated`);
        } else {
          showStatus('Error updating annotation geometry', 'error');
        }
      } catch (error) {
        console.error('Error updating annotation:', error);
        showStatus('Error updating annotation geometry', 'error');
      } finally {
        showLoading(false);
      }
    }
    
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
      document.getElementById('fragment').value = '0';
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
    
    // Export annotations as CSV
    async function exportAnnotations() {
      if (!currentCOG && !isOracleProjectMode()) {
        showStatus('Please select a COG file first', 'error');
        return;
      }
      
      try {
        if (isOracleProjectMode()) {
          if (!annotations.length) {
            showStatus('No annotations to export', 'warning');
            return;
          }

          const headers = ['id', 'shape', 'species', 'analyst', 'site', 'obs_year', 'mission_id'];
          const rows = annotations.map((ann) => ([
            ann.id || ann.properties?.annotation_id || '',
            ann.properties?.SHAPE || '',
            ann.properties?.SPCODE || '',
            ann.properties?.ANALYST || '',
            ann.properties?.SITE || '',
            ann.properties?.OBS_YEAR || '',
            ann.properties?.MISSION_ID || ''
          ]));

          const escapeCsv = (v) => {
            const str = String(v ?? '');
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          };

          const csv = [headers, ...rows].map(row => row.map(escapeCsv).join(',')).join('\n');
          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `project_${currentProject.project_id}_annotations.csv`;
          link.click();
          URL.revokeObjectURL(url);
          showStatus('CSV export complete', 'success');
          return;
        }

        window.open(`${serverUrl}/api/annotations/export/csv?ortho_file=${encodeURIComponent(currentCOG)}`, '_blank');
        showStatus('CSV export started', 'success');
      } catch (error) {
        console.error('Error exporting CSV:', error);
        showStatus('Error exporting annotations', 'error');
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
        alert('No annotations to export. Please draw and save some annotations first.');
        return;
      }
      
      try {
        showStatus('Exporting annotations to shapefile...', 'info');
        
        // Send annotations to backend for shapefile conversion
        const response = await fetch(`${serverUrl}/api/file-projects/export-shapefile`, {
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
        alert(`Error exporting shapefile: ${error.message}`);
        showStatus('Error exporting shapefile', 'error');
      }
    }
    
    // Database mode functions removed - file mode uses index-based versions defined earlier
    
    // Auto-set current year
    document.getElementById('obs_year').value = new Date().getFullYear();
    
    // Add keyboard shortcut for saving (Ctrl+S or Cmd+S)
    document.addEventListener('keydown', function(e) {
      // Check for Ctrl+S (Windows/Linux) or Cmd+S (Mac)
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
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
    });
    
    // Initialize
    // =========================================================================
    // SPECIES AUTOCOMPLETE
    // =========================================================================
    
    let autocompleteTimeout = null;
    let autocompleteSelectedIndex = -1;
    let autocompleteResults = [];
    
    // Inputs/autocomplete/onload runtime extracted to js/annotation-runtime-inputs-init.js

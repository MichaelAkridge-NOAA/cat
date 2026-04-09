// Extracted from annotation-file-mode-runtime.js (Phase 2h: layer controls)
    function toggleCOGLayer() {
      const checked = document.getElementById('toggleCOG').checked;
      if (cogLayer) {
        if (checked) {
          map.addLayer(cogLayer);
        } else {
          map.removeLayer(cogLayer);
        }
      }
    }
    
    function setCOGOpacity(value) {
      document.getElementById('cogOpacityValue').textContent = value;
      if (cogLayer) {
        cogLayer.setOpacity(value / 100);
      }
    }
    
    function zoomToSite() {
      // File-based mode: Use project bounds first
      if (currentProject && projectBounds) {
        map.fitBounds(projectBounds, { padding: [50, 50] });
        showStatus('✅ Zoomed to project extent', 'success');
        return;
      }
      
      // Try to zoom to shapefile bounds if available
      if (Object.keys(shapefileLayers).length > 0) {
        const allBounds = [];
        Object.values(shapefileLayers).forEach(layerData => {
          if (layerData && layerData.layer) {
            const bounds = layerData.layer.getBounds();
            if (bounds && bounds.isValid()) {
              allBounds.push(bounds);
            }
          }
        });
        
        if (allBounds.length > 0) {
          const combinedBounds = allBounds.reduce((acc, bounds) => acc.extend(bounds), allBounds[0]);
          const center = combinedBounds.getCenter();
          
          // For underwater imagery, zoom directly to high zoom level (40)
          map.setView(center, 24, { animate: true });
          showStatus('✅ Zoomed to site extent', 'success');
        } else {
          showStatus('⚠️ No shapefile bounds available', 'warning');
        }
      } else if (selectedSiteData && selectedSiteData.geometry) {
        // Fallback: zoom to site selection polygon
        const coords = selectedSiteData.geometry.coordinates[0];
        const bounds = L.latLngBounds(coords.map(c => [c[1], c[0]]));
        const center = bounds.getCenter();
        
        // For underwater imagery, zoom directly to high zoom level (24)
        map.setView(center, 24, { animate: true });
        showStatus('✅ Zoomed to site', 'success');
      } else if (cogBounds && cogBounds.length === 4) {
        // COG bounds fallback: validate before using
        const b = cogBounds;
        const boundsCheck = (typeof areBoundsBogus === 'function')
          ? areBoundsBogus(b, null)
          : { bogus: false };

        if (boundsCheck.bogus) {
          // COG bounds are bogus – skip to metadata fallback below
          console.warn('⚠️ COG bounds are bogus, trying metadata fallback');
        } else {
          const minLng = b[0];
          const minLat = b[1];
          const maxLng = b[2];
          const maxLat = b[3];

          // Check for valid bounds
          if (minLng > maxLng || minLat > maxLat) {
            console.warn('Invalid COG bounds:', b);
            showStatus('⚠️ Invalid coordinate bounds', 'warning');
            return;
          }

          // Create Leaflet bounds
          const leafletBounds = [[minLat, minLng], [maxLat, maxLng]];

          // Use fitBounds for better automatic zooming
          map.fitBounds(leafletBounds, { 
            padding: [50, 50],
            maxZoom: 24,
            animate: true
          });
          console.log('✅ Zoomed to COG imagery');
          showStatus('✅ Zoomed to imagery', 'success');
          return;
        }
      }

      // Metadata lat/lon fallback (last resort before giving up)
      const fallback = (typeof getMetadataFallbackCenter === 'function')
        ? getMetadataFallbackCenter()
        : null;
      if (fallback) {
        map.setView([fallback.lat, fallback.lon], 18, { animate: true });
        console.log('📍 Zoomed to metadata site location:', fallback);
        showStatus('📍 Zoomed to site (from metadata coordinates)', 'success');
      } else {
        if (currentProject) {
          showStatus('⚠️ No bounds available yet - load a layer with the checkboxes above', 'warning');
        } else {
          showStatus('⚠️ No site boundaries available to zoom to', 'warning');
        }
      }
    }
    
    function toggleDEMLayer() {
      const checked = document.getElementById('toggleDEM').checked;
      if (demLayer) {
        if (checked) {
          map.addLayer(demLayer);
        } else {
          map.removeLayer(demLayer);
        }
      }
    }
    
    function setTifOpacity(tifId, value, safeId) {
      // Update display value
      const opacityDisplay = document.getElementById(`${safeId}_opacityValue`);
      if (opacityDisplay) {
        opacityDisplay.textContent = value;
      }
      
      // Update layer opacity
      const tifData = tifLayers[tifId];
      if (tifData && tifData.layer) {
        tifData.layer.setOpacity(value / 100);
        console.log(`Updated TIF ${tifId} opacity to ${value}%`);
      }
    }
    
    function setShapefileOpacity(shapefileName, value, safeId) {
      // Update display value
      document.getElementById(`shapefile_${safeId}_opacityValue`).textContent = value;

      // Update layer opacity
      const shapefileData = shapefileLayers[shapefileName];
      if (shapefileData && shapefileData.layer) {
        // Store the opacity value
        shapefileData.opacity = parseInt(value);

        // Update both stroke and fill opacity proportionally
        const opacityRatio = value / 100;
        const borderOnly = shapefileData.borderOnly || false;
        shapefileData.layer.setStyle({
          opacity: opacityRatio * 0.8,
          fillOpacity: borderOnly ? 0 : opacityRatio * 0.15
        });
      }
    }

    function toggleShapefileBorderOnly(shapefileName, borderOnly, safeId) {
      const shapefileData = shapefileLayers[shapefileName];
      if (!shapefileData || !shapefileData.layer) return;

      shapefileData.borderOnly = borderOnly;
      const opacityRatio = (shapefileData.opacity || 80) / 100;
      shapefileData.layer.setStyle({
        fillOpacity: borderOnly ? 0 : opacityRatio * 0.15
      });
    }
    
    async function updateTifColormap(tif, safeId) {
      const colormapSelect = document.getElementById(`${safeId}_colormap`);
      if (!colormapSelect) {
        console.warn('No colormap selector found');
        return;
      }
      
      const colormap = colormapSelect.value;
      console.log(`🔄 Updating TIF ${tif.id} colormap to ${colormap}...`);
      
      // Remove existing layer
      if (tifLayers[tif.id]) {
        map.removeLayer(tifLayers[tif.id].layer);
        delete tifLayers[tif.id];
      }
      
      // Reload with new colormap (loadTifLayer will read the selector value)
      await loadTifLayer(tif);
      
      console.log(`✅ TIF ${tif.id} colormap updated to ${colormap}`);
    }
    
    // ===== SHAPEFILE EDITOR FUNCTIONS =====
    
    // Track edit state for each layer
    const shapefileEditState = {};
    
    function toggleEditMode(layerName, enabled) {
      const editControls = document.getElementById(`editControls_${layerName}`);
      const layerData = shapefileLayers[layerName];
      
      if (!layerData || !layerData.layer) {
        console.error(`Layer ${layerName} not found`);
        return;
      }
      
      if (enabled) {
        editControls.style.display = 'block';
        // Initialize edit state for this layer
        shapefileEditState[layerName] = {
          mode: 'select',
          selectedFeatures: [],
          originalData: JSON.parse(JSON.stringify(layerData.geojson)), // Deep copy
          hasChanges: false
        };
        setEditTool(layerName, 'select');
        console.log(`✏️ Edit mode enabled for ${layerName}`);
      } else {
        editControls.style.display = 'none';
        // Disable editing
        disableEditingForLayer(layerName);
        console.log(`✏️ Edit mode disabled for ${layerName}`);
      }
    }
    
    function setEditTool(layerName, tool) {
      const state = shapefileEditState[layerName];
      if (!state) return;
      
      state.mode = tool;
      
      // Update button styles
      ['select', 'move', 'rotate', 'vertices'].forEach(t => {
        const btn = document.getElementById(`editTool_${layerName}_${t}`);
        if (btn) {
          btn.style.background = t === tool ? '#007bff' : 'white';
          btn.style.color = t === tool ? 'white' : 'black';
        }
      });
      
      // Apply tool to layer
      const layerData = shapefileLayers[layerName];
      if (!layerData || !layerData.layer) return;
      
      // Clear previous selections
      state.selectedFeatures = [];
      
      layerData.layer.eachLayer(layer => {
        // Remove previous editing handlers
        layer.off('click');
        layer.off('mousedown');
        
        // Reset style
        if (layer.setStyle) {
          layer.setStyle({
            color: layerData.color || '#ff7800',
            weight: 2,
            fillOpacity: 0.2
          });
        }
        
        // Apply new tool behavior
        switch(tool) {
          case 'select':
            layer.on('click', function(e) {
              L.DomEvent.stopPropagation(e);
              toggleFeatureSelection(layerName, layer);
            });
            break;
            
          case 'move':
            makeFeatureDraggable(layerName, layer);
            break;
            
          case 'rotate':
            layer.on('click', function(e) {
              L.DomEvent.stopPropagation(e);
              selectFeatureForRotation(layerName, layer);
            });
            break;
            
          case 'vertices':
            enableVertexEditing(layerName, layer);
            break;
        }
      });
      
      console.log(`🛠️ Edit tool set to: ${tool}`);
    }
    
    function toggleFeatureSelection(layerName, layer) {
      const state = shapefileEditState[layerName];
      if (!state) return;
      
      const idx = state.selectedFeatures.indexOf(layer);
      if (idx > -1) {
        // Deselect
        state.selectedFeatures.splice(idx, 1);
        if (layer.setStyle) {
          const layerData = shapefileLayers[layerName];
          layer.setStyle({
            color: layerData.color || '#ff7800',
            weight: 2,
            fillOpacity: 0.2
          });
        }
      } else {
        // Select
        state.selectedFeatures.push(layer);
        if (layer.setStyle) {
          layer.setStyle({
            color: '#00ff00',
            weight: 3,
            fillOpacity: 0.4
          });
        }
      }
      
      console.log(`Selected features: ${state.selectedFeatures.length}`);
    }
    
    function makeFeatureDraggable(layerName, layer) {
      let isDragging = false;
      let startLatLng = null;
      
      layer.on('mousedown', function(e) {
        isDragging = true;
        startLatLng = e.latlng;
        map.dragging.disable();
        L.DomEvent.stopPropagation(e);
        
        if (layer.setStyle) {
          layer.setStyle({ color: '#00ff00', weight: 3 });
        }
      });
      
      map.on('mousemove', function(e) {
        if (!isDragging) return;
        
        const latDiff = e.latlng.lat - startLatLng.lat;
        const lngDiff = e.latlng.lng - startLatLng.lng;
        
        // Move the layer
        if (layer.getLatLngs) {
          // Polygon or Polyline
          const latlngs = layer.getLatLngs();
          const moved = moveLatLngs(latlngs, latDiff, lngDiff);
          layer.setLatLngs(moved);
        } else if (layer.getLatLng) {
          // Marker
          const newPos = L.latLng(
            layer.getLatLng().lat + latDiff,
            layer.getLatLng().lng + lngDiff
          );
          layer.setLatLng(newPos);
        }
        
        startLatLng = e.latlng;
      });
      
      map.on('mouseup', function() {
        if (isDragging) {
          isDragging = false;
          map.dragging.enable();
          
          if (layer.setStyle) {
            const layerData = shapefileLayers[layerName];
            layer.setStyle({
              color: layerData.color || '#ff7800',
              weight: 2
            });
          }
          
          // Mark as changed
          const state = shapefileEditState[layerName];
          if (state) state.hasChanges = true;
          
          console.log('✓ Feature moved');
        }
      });
    }
    
    function moveLatLngs(latlngs, latDiff, lngDiff) {
      if (Array.isArray(latlngs[0])) {
        // Nested array (polygon with holes)
        return latlngs.map(ring => moveLatLngs(ring, latDiff, lngDiff));
      }
      return latlngs.map(ll => L.latLng(ll.lat + latDiff, ll.lng + lngDiff));
    }
    
    function selectFeatureForRotation(layerName, layer) {
      const state = shapefileEditState[layerName];
      if (!state) return;
      
      // Highlight selected feature
      if (layer.setStyle) {
        layer.setStyle({ color: '#ff00ff', weight: 3, fillOpacity: 0.4 });
      }
      
      // Get centroid
      const bounds = layer.getBounds();
      const centroid = bounds.getCenter();
      
      // Show rotation handle
      const rotationMarker = L.circleMarker(centroid, {
        radius: 8,
        color: '#ff00ff',
        fillColor: '#ff00ff',
        fillOpacity: 0.8
      }).addTo(map);
      
      let rotating = false;
      let startAngle = 0;
      
      map.on('click', function(e) {
        if (!rotating) {
          rotating = true;
          startAngle = Math.atan2(e.latlng.lng - centroid.lng, e.latlng.lat - centroid.lat);
        } else {
          rotating = false;
          rotationMarker.remove();
          map.off('mousemove');
          
          if (layer.setStyle) {
            const layerData = shapefileLayers[layerName];
            layer.setStyle({
              color: layerData.color || '#ff7800',
              weight: 2,
              fillOpacity: 0.2
            });
          }
          
          state.hasChanges = true;
          console.log('✓ Feature rotated');
        }
      });
      
      map.on('mousemove', function(e) {
        if (!rotating) return;
        
        const currentAngle = Math.atan2(e.latlng.lng - centroid.lng, e.latlng.lat - centroid.lat);
        const angleDiff = currentAngle - startAngle;
        
        // Rotate the layer
        if (layer.getLatLngs) {
          const latlngs = layer.getLatLngs();
          const rotated = rotateLatLngs(latlngs, centroid, angleDiff);
          layer.setLatLngs(rotated);
          startAngle = currentAngle;
        }
      });
    }
    
    function rotateLatLngs(latlngs, center, angle) {
      if (Array.isArray(latlngs[0])) {
        return latlngs.map(ring => rotateLatLngs(ring, center, angle));
      }
      
      return latlngs.map(ll => {
        const dx = ll.lng - center.lng;
        const dy = ll.lat - center.lat;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        
        return L.latLng(
          center.lat + (dy * cos - dx * sin),
          center.lng + (dx * cos + dy * sin)
        );
      });
    }
    
    function enableVertexEditing(layerName, layer) {
      if (!layer.getLatLngs && !layer.getLatLng) return;
      
      const markers = [];
      const updateFeature = () => {
        const newLatLngs = markers.map(m => m.getLatLng());
        if (layer.setLatLngs) {
          layer.setLatLngs(newLatLngs);
        }
        
        const state = shapefileEditState[layerName];
        if (state) state.hasChanges = true;
      };
      
      // Get vertices
      let vertices = [];
      if (layer.getLatLngs) {
        const latlngs = layer.getLatLngs();
        vertices = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
      } else if (layer.getLatLng) {
        vertices = [layer.getLatLng()];
      }
      
      // Create draggable markers for each vertex
      vertices.forEach((vertex, idx) => {
        const marker = L.circleMarker(vertex, {
          radius: 5,
          color: '#0000ff',
          fillColor: '#0000ff',
          fillOpacity: 0.8,
          draggable: false
        }).addTo(map);
        
        marker.on('mousedown', function() {
          map.dragging.disable();
        });
        
        marker.on('drag', updateFeature);
        
        marker.on('mouseup', function() {
          map.dragging.enable();
          updateFeature();
        });
        
        // Manual drag implementation
        let dragging = false;
        marker.on('mousedown', () => dragging = true);
        map.on('mousemove', function(e) {
          if (dragging) {
            marker.setLatLng(e.latlng);
            updateFeature();
          }
        });
        map.on('mouseup', () => {
          dragging = false;
          map.dragging.enable();
        });
        
        markers.push(marker);
      });
      
      // Store markers for cleanup
      if (!layer._editMarkers) layer._editMarkers = [];
      layer._editMarkers = markers;
    }
    
    async function deleteSelectedFeatures(layerName) {
      const state = shapefileEditState[layerName];
      const layerData = shapefileLayers[layerName];

      if (!state || !layerData || state.selectedFeatures.length === 0) {
        if (typeof showStatus === 'function') showStatus('No features selected', 'error');
        return;
      }

      if (!await catConfirm(`Delete ${state.selectedFeatures.length} selected feature(s)?`, { danger: true, ok: 'Delete' })) {
        return;
      }
      
      // Remove selected features from the layer
      state.selectedFeatures.forEach(feature => {
        layerData.layer.removeLayer(feature);
      });
      
      state.selectedFeatures = [];
      state.hasChanges = true;
      
      console.log(`🗑️ Deleted ${state.selectedFeatures.length} features`);
      if (typeof showStatus === 'function') showStatus('Features deleted. Click "Save Changes" to persist.', 'info');
    }
    
    function disableEditingForLayer(layerName) {
      const layerData = shapefileLayers[layerName];
      if (!layerData || !layerData.layer) return;
      
      // Remove all event handlers and edit markers
      layerData.layer.eachLayer(layer => {
        layer.off('click');
        layer.off('mousedown');
        
        // Remove vertex edit markers
        if (layer._editMarkers) {
          layer._editMarkers.forEach(m => map.removeLayer(m));
          layer._editMarkers = [];
        }
        
        // Reset style
        if (layer.setStyle) {
          layer.setStyle({
            color: layerData.color || '#ff7800',
            weight: 2,
            fillOpacity: 0.2
          });
        }
      });
      
      map.off('mousemove');
      map.off('mouseup');
      delete shapefileEditState[layerName];
    }
    
    async function saveShapefileEdits(layerName) {
      const state = shapefileEditState[layerName];
      const layerData = shapefileLayers[layerName];
      
      if (!state || !layerData) {
        if (typeof showStatus === 'function') showStatus('No edit state found', 'error');
        return;
      }
      
      if (!state.hasChanges) {
        if (typeof showStatus === 'function') showStatus('No changes to save', 'info');
        return;
      }
      
      if (!await catConfirm('Save changes to shapefile layer?', { ok: 'Save' })) {
        return;
      }
      
      try {
        // Convert current layer state to GeoJSON
        const updatedGeojson = layerData.layer.toGeoJSON();
        
        // Update local data
        layerData.geojson = updatedGeojson;
        
        // Send to server
        const formData = new FormData();
        formData.append('site_name', selectedSiteData.SITE_NAME);
        formData.append('layer_name', layerData.name);
        formData.append('geojson', JSON.stringify(updatedGeojson));
        
        const response = await fetch(`${serverUrl}/api/sites/update-shapefile-layer`, {
          method: 'POST',
          body: formData
        });
        
        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }
        
        const result = await response.json();
        console.log('✅ Saved shapefile edits:', result);
        // Alert removed - save happens silently
        
        state.hasChanges = false;
        state.originalData = JSON.parse(JSON.stringify(updatedGeojson));
        
      } catch (error) {
        console.error('Error saving shapefile edits:', error);
        if (typeof showStatus === 'function') showStatus('Error saving changes: ' + error.message, 'error');
      }
    }
    
    function addShapefileLayerControl(layerName) {
      const container = document.getElementById('shapefileLayersContainer');
      const safeLayerName = layerName.replace(/[^a-zA-Z0-9_-]/g, '_');
      
      // Check if control already exists
      if (document.getElementById(`shapefileControl_${safeLayerName}`)) {
        return;
      }
      
      const layerControl = document.createElement('div');
      layerControl.className = 'layer-item';
      layerControl.id = `shapefileControl_${safeLayerName}`;
      layerControl.innerHTML = `
        <div class="layer-header" onclick="toggleLayerDetails('shapefileDetails_${safeLayerName}')" style="cursor: pointer;">
          <div class="layer-name">
            <span>📐</span>
            <span>${layerName}</span>
            <span class="layer-collapse-icon" id="shapefileDetailsIcon_${safeLayerName}">▼</span>
          </div>
          <label class="layer-toggle" onclick="event.stopPropagation();">
            <input type="checkbox" id="toggleShapefile_${safeLayerName}" checked onchange="toggleShapefileLayer('${safeLayerName}')">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="layer-details" id="shapefileDetails_${safeLayerName}">
          <div class="opacity-control">
            <label>Opacity: <span id="shapefileOpacityValue_${safeLayerName}">90</span>%</label>
            <input type="range" class="opacity-slider" id="shapefileOpacity_${safeLayerName}" min="0" max="100" value="90" oninput="setShapefileOpacity('${safeLayerName}', this.value)">
          </div>
          
          <!-- Edit Mode Controls -->
          <div style="margin-top: 10px; padding: 8px; background: #f8f9fa; border-radius: 4px; border: 1px solid #dee2e6;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
              <label style="font-weight: bold; font-size: 11px; color: #495057;">✏️ Edit Mode</label>
              <label class="layer-toggle" style="transform: scale(0.8);">
                <input type="checkbox" id="editMode_${safeLayerName}" onchange="toggleEditMode('${safeLayerName}', this.checked)">
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div id="editControls_${safeLayerName}" style="display: none;">
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 6px;">
                <button onclick="setEditTool('${safeLayerName}', 'select')" id="editTool_${safeLayerName}_select" class="edit-tool-btn" style="padding: 4px; font-size: 10px; border: 1px solid #ccc; border-radius: 3px; background: white; cursor: pointer;">🖱️ Select</button>
                <button onclick="setEditTool('${safeLayerName}', 'move')" id="editTool_${safeLayerName}_move" class="edit-tool-btn" style="padding: 4px; font-size: 10px; border: 1px solid #ccc; border-radius: 3px; background: white; cursor: pointer;">↔️ Move</button>
                <button onclick="setEditTool('${safeLayerName}', 'rotate')" id="editTool_${safeLayerName}_rotate" class="edit-tool-btn" style="padding: 4px; font-size: 10px; border: 1px solid #ccc; border-radius: 3px; background: white; cursor: pointer;">🔄 Rotate</button>
                <button onclick="setEditTool('${safeLayerName}', 'vertices')" id="editTool_${safeLayerName}_vertices" class="edit-tool-btn" style="padding: 4px; font-size: 10px; border: 1px solid #ccc; border-radius: 3px; background: white; cursor: pointer;">📍 Vertices</button>
              </div>
              <button onclick="deleteSelectedFeatures('${safeLayerName}')" style="width: 100%; padding: 4px; margin-bottom: 4px; background: #dc3545; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">🗑️ Delete Selected</button>
              <button onclick="saveShapefileEdits('${safeLayerName}')" style="width: 100%; padding: 6px; background: #28a745; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: bold;">💾 Save Changes</button>
            </div>
          </div>
          
          <button onclick="removeShapefileLayer('${safeLayerName}')" style="width: 100%; padding: 4px; margin-top: 6px; background: #ff4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 11px;">Remove Layer</button>
        </div>
      `;
      
      container.appendChild(layerControl);
      
      // Start collapsed
      const details = document.getElementById(`shapefileDetails_${safeLayerName}`);
      const icon = document.getElementById(`shapefileDetailsIcon_${safeLayerName}`);
      if (details && icon) {
        details.classList.add('collapsed');
        icon.textContent = '▶';
      }
    }
    

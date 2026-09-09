/**
 * Overlay Layer Management for CAT
 * Handles shapefile upload, rendering, and editing of transects/segments
 */

// Store overlay layers
let overlayLayers = {};
let currentProjectId = null;

/**
 * Initialize overlay layer controls for DB mode
 */
function initializeOverlayControls(projectId) {
  currentProjectId = projectId;
  window.isDbMode = true;

  // Add the sidebar panel (header + loaded-layer list) and load existing layers.
  // The upload widget itself lives inside the Manage Overlay Layers modal — see
  // addOverlayUploadUI(), built lazily the first time that modal opens.
  addOverlaySidebarPanel();
  loadExistingOverlays(projectId);
}

/**
 * Add the sidebar panel: a header (with a "Manage" button that opens the modal)
 * plus the list of currently loaded overlay layers with their per-layer controls
 * (color, opacity, border-only, zoom, remove).
 */
function addOverlaySidebarPanel() {
  const container = document.getElementById('shapefileLayersContainer');
  if (!container) return;
  if (document.getElementById('overlaySidebarHeader')) return;

  container.innerHTML = `
    <div id="overlaySidebarHeader" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 10px; background: #f8f9fa; border-radius: 4px; border: 1px solid #e9ecef;">
      <div style="font-size: 12px; color: #495057; font-weight: 500;">
        📁 Shapefile Overlays
      </div>
      <button onclick="openLayerManagementModal()" class="btn btn-sm" style="padding: 4px 10px; font-size: 11px; background: #fff; border: 1px solid #dee2e6; color: #495057;">
        🗂️ Manage / Upload
      </button>
    </div>
    <div id="overlayLayersList" style="margin-top: 4px;">
      <!-- Loaded overlay layers will appear here -->
    </div>
  `;
}

/**
 * Add the upload widget (drop zone + type selector) into the Manage Overlay
 * Layers modal. Built once, lazily, the first time the modal is opened.
 */
function addOverlayUploadUI() {
  const container = document.getElementById('overlayModalUploadHost');
  if (!container) return;

  // Add upload section if not already there
  if (document.getElementById('overlayUploadSection')) return;

  const uploadHTML = `
    <div id="overlayUploadSection" style="padding: 10px; background: #f8f9fa; border-radius: 4px; margin-bottom: 12px; border: 1px solid #e9ecef;">
      <div style="font-size: 12px; color: #495057; font-weight: 500; margin-bottom: 8px;">
        📤 Upload Shapefile
      </div>
      <div id="overlayDropZone" style="
        border: 2px dashed #dee2e6;
        border-radius: 4px;
        padding: 15px;
        text-align: center;
        cursor: pointer;
        background: #fff;
        transition: all 0.3s;
      " ondragover="handleOverlayDragOver(event)" ondragleave="handleOverlayDragLeave(event)"
         ondrop="handleOverlayDrop(event)" onclick="document.getElementById('overlayFileInput').click()">
        <div style="color: #6c757d; font-size: 12px;">
          🗂️ Drop shapefile here<br>
          <span style="font-size: 10px;">.zip or .shp + .shx + .dbf + .prj</span>
        </div>
        <input type="file" id="overlayFileInput" accept=".zip,.shp,.shx,.dbf,.prj,.cpg,.sbn,.sbx,.fbn,.fbx,.ain,.aih,.ixs,.mxs,.atx,.shp.xml,.qix" multiple style="display: none;" onchange="handleOverlayFileSelect(event)">
      </div>
      <div style="display:flex; align-items:center; gap:6px; margin-top:8px;">
        <label style="font-size:11px; color:#6c757d;">Type:</label>
        <select id="overlayUploadType" style="font-size:11px; padding:2px 4px;" onchange="_overlayTypeManuallySet = true;">
          <option value="">Generic</option>
          <option value="transect">Transect</option>
          <option value="segment">Segment</option>
        </select>
        <span style="font-size:10px; color:#999;">(auto-detected from filename if left on Generic)</span>
      </div>
      <div id="overlayUploadProgress" style="display: none; margin-top: 8px;">
        <div style="background: #e9ecef; height: 4px; border-radius: 2px; overflow: hidden;">
          <div id="overlayProgressBar" style="background: #28a745; height: 100%; width: 0%; transition: width 0.3s;"></div>
        </div>
        <div id="overlayUploadStatus" style="font-size: 11px; color: #6c757d; margin-top: 4px;"></div>
      </div>
    </div>
  `;

  container.innerHTML = uploadHTML;
}

/**
 * Guess a layer type from a shapefile's filename (e.g. "2025_GUA-2838_transect.shp"
 * -> "transect"), so the upload type selector doesn't need to be set by hand for
 * the common case of importing an already-named ArcGIS-style shapefile.
 */
function _guessLayerTypeFromFilename(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('transect')) return 'transect';
  if (n.includes('segment')) return 'segment';
  return '';
}

let _overlayTypeManuallySet = false;

/**
 * Handle drag over event
 */
function handleOverlayDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  const dropZone = document.getElementById('overlayDropZone');
  dropZone.style.borderColor = '#28a745';
  dropZone.style.background = '#e8f5e9';
}

/**
 * Handle drag leave event
 */
function handleOverlayDragLeave(event) {
  event.preventDefault();
  event.stopPropagation();
  const dropZone = document.getElementById('overlayDropZone');
  dropZone.style.borderColor = '#dee2e6';
  dropZone.style.background = '#fff';
}

/**
 * Handle file drop
 */
async function handleOverlayDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  
  const dropZone = document.getElementById('overlayDropZone');
  dropZone.style.borderColor = '#555';
  dropZone.style.background = '#1a1a1a';

  const files = event.dataTransfer.files;
  if (files.length > 0) {
    await uploadOverlayFiles(files);
  }
}

/**
 * Handle file selection from input
 */
async function handleOverlayFileSelect(event) {
  const files = event.target.files;
  if (files.length > 0) {
    await uploadOverlayFiles(files);
  }
}

/**
 * Upload shapefile to server — accepts a FileList containing either:
 *   • A single .zip archive, OR
 *   • Loose shapefile component files (.shp, .shx, .dbf, .prj, etc.)
 */
async function uploadOverlayFiles(fileList) {
  if (!currentProjectId) {
    showStatus('⚠️ No project loaded', 'warning');
    return;
  }

  const files = Array.from(fileList);
  const SHAPEFILE_EXTS = ['.shp','.shx','.dbf','.prj','.cpg','.sbn','.sbx','.fbn','.fbx','.ain','.aih','.ixs','.mxs','.atx','.xml','.qix'];
  const isZip = files.length === 1 && files[0].name.toLowerCase().endsWith('.zip');
  const looseFiles = files.filter(f => SHAPEFILE_EXTS.some(ext => f.name.toLowerCase().endsWith(ext)));
  const hasShp = looseFiles.some(f => f.name.toLowerCase().endsWith('.shp'));

  if (!isZip && !hasShp) {
    showStatus('⚠️ Drop a .zip archive OR shapefile components (must include .shp)', 'warning');
    return;
  }

  // Show progress
  const progressDiv = document.getElementById('overlayUploadProgress');
  const statusDiv = document.getElementById('overlayUploadStatus');
  const progressBar = document.getElementById('overlayProgressBar');
  
  progressDiv.style.display = 'block';
  progressBar.style.width = '30%';

  const formData = new FormData();
  let endpoint;
  const typeSelect = document.getElementById('overlayUploadType');
  if (typeSelect && !_overlayTypeManuallySet) {
    const shpFile = isZip ? files[0] : looseFiles.find(f => f.name.toLowerCase().endsWith('.shp'));
    const guess = _guessLayerTypeFromFilename(shpFile && shpFile.name);
    if (guess) typeSelect.value = guess;
  }
  const layerType = typeSelect ? typeSelect.value : '';

  if (isZip) {
    statusDiv.textContent = `Uploading ${files[0].name}...`;
    formData.append('file', files[0]);
    endpoint = `/api/db/projects/${currentProjectId}/overlay-layers/upload-shapefile`;
  } else {
    statusDiv.textContent = `Uploading ${looseFiles.length} shapefile components...`;
    for (const f of looseFiles) {
      formData.append('files', f);
    }
    endpoint = `/api/db/projects/${currentProjectId}/overlay-layers/upload-shapefile-files`;
  }
  if (layerType) {
    formData.append('layer_type', layerType);
  }

  try {
    const response = await fetch(`${window.location.origin}${endpoint}`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Upload failed');
    }

    const result = await response.json();
    
    progressBar.style.width = '100%';
    statusDiv.textContent = `✅ Loaded ${result.feature_count} features`;
    
    showStatus(`✅ Imported layer: ${result.layer_name} (${result.feature_count} features)`, 'success');

    // Load the new layer onto the map
    await loadOverlayLayer(result.layer_id, result.layer_name, '#00ff00', layerType || null);

    // Hide progress after 2 seconds
    setTimeout(() => {
      progressDiv.style.display = 'none';
      progressBar.style.width = '0%';
      document.getElementById('overlayFileInput').value = '';
    }, 2000);

  } catch (error) {
    console.error('Overlay upload error:', error);
    statusDiv.textContent = `❌ Error: ${error.message}`;
    progressBar.style.width = '0%';
    showStatus(`❌ Upload failed: ${error.message}`, 'error');
    // Reset file input so the same file can be retried
    const fileInput = document.getElementById('overlayFileInput');
    if (fileInput) fileInput.value = '';
  }
}

/**
 * Load existing overlay layers from database
 */
async function loadExistingOverlays(projectId) {
  // Clear existing layers first
  Object.keys(overlayLayers).forEach(layerId => {
    if (overlayLayers[layerId]?.layerGroup) {
      map.removeLayer(overlayLayers[layerId].layerGroup);
    }
  });
  overlayLayers = {};
  
  // Clear UI list
  const listContainer = document.getElementById('overlayLayersList');
  if (listContainer) listContainer.innerHTML = '';

  try {
    const response = await fetch(
      `${window.location.origin}/api/db/projects/${projectId}/overlay-layers`
    );

    if (!response.ok) return;

    const data = await response.json();
    
    // Filter to only active layers and sort by display_order
    const activeLayers = (data.layers || [])
      .filter(layer => layer.is_active)
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    
    if (activeLayers.length > 0) {
      console.log(`📂 Loading ${activeLayers.length} active overlay layers...`);
      
      for (const layer of activeLayers) {
        const style = layer.style || {};
        await loadOverlayLayer(layer.layer_id, layer.layer_name, style.color || '#00ff00', layer.layer_type || null);
      }
    }
  } catch (error) {
    console.error('Error loading existing overlays:', error);
    if (typeof showStatus === 'function') showStatus('❌ Failed to load overlay layers', 'error');
  }
}

/**
 * Load overlay layer features and render on map
 */
async function loadOverlayLayer(layerId, layerName, layerColor = '#00ff00', layerType = null) {
  try {
    const response = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}/features`
    );

    if (!response.ok) {
      throw new Error('Failed to load layer features');
    }

    const data = await response.json();
    console.log(`🗺️ Rendering ${data.features.length} features for layer: ${layerName}`);

    // Create Leaflet layer group
    const layerGroup = L.featureGroup();

    // Add each feature
    data.features.forEach(featureData => {
      const feature = featureData.feature;
      
      const geoJsonLayer = L.geoJSON(feature, {
        pane: 'shapefilePane',
        style: {
          color: layerColor,
          weight: 2,
          opacity: 0.8,
          fillOpacity: 0.2,
          interactive: true
        },
        onEachFeature: (feature, layer) => {
          // Store the feature_id and layer_id on the Leaflet layer
          layer._overlayFeatureId = featureData.feature_id;
          layer._overlayLayerId = layerId;

          // Add popup with properties + edit hint
          if (feature.properties) {
            const props = Object.entries(feature.properties)
              .filter(([k, v]) => v !== null && v !== '')
              .map(([k, v]) => `<b>${k}:</b> ${v}`)
              .join('<br>');
            layer.bindPopup(
              props +
              '<br><hr style="margin:4px 0"><i style="font-size:10px;color:#888;line-height:1.5">' +
              'Dbl-click = edit vertices<br>' +
              'Drag = move this feature<br>' +
              'Ctrl+drag = move whole layer<br>' +
              'Alt+drag = rotate feature</i>'
            );
          }

          // Double-click toggles edit mode (Leaflet.Draw adds .editing to layers)
          layer.on('dblclick', (e) => {
            L.DomEvent.stop(e);
            if (layer.editing && layer.editing.enabled()) {
              layer.editing.disable();
              _removeStaleEditHandles(layer);
              layer.setStyle({ color: layerColor, dashArray: null });
              if (layer._catExitEdit) {
                document.removeEventListener('keydown', layer._catExitEdit, true);
                layer._catExitEdit = null;
              }
            } else if (layer.editing) {
              layer.editing.enable();
              layer.setStyle({ color: '#ff9800', dashArray: '6,4' });
              // Task 9: the old copy here said "...then double-click to finish", but
              // that's not how this actually works (confirmed via a diagnostic
              // listener: Leaflet's synthetic 'dblclick' event never reaches a vector
              // layer at all while leaflet-draw's vertex-editing overlay is active on
              // it, so this handler's own disable-branch above can never fire from a
              // literal second double-click) - editing already auto-finishes and
              // persists via the 'edit' handler below as soon as a vertex drag ends,
              // with no further click needed. Say that instead.
              showStatus('✏️ Editing vertices — drag a handle to move it (auto-saves); press Escape to finish', 'info');

              // Escape exits edit mode even if no vertex was dragged (Leaflet suppresses
              // dblclick on the layer while its editing overlay is active, so the dblclick
              // disable-branch above can't fire on its own).
              var _exitEdit = function(ev) {
                if (ev.key !== 'Escape') return;
                if (layer.editing && layer.editing.enabled()) {
                  layer.editing.disable();
                  _removeStaleEditHandles(layer);
                  layer.setStyle({ color: layerColor, dashArray: null });
                  // Consume this Escape so the global bubble-phase handler in
                  // annotation-runtime-shell-init.js (which cancels the active
                  // drawing tool and discards any unsaved annotation) doesn't
                  // ALSO fire from the same keypress. Only swallow it when we
                  // actually exited edit mode here — if editing was somehow
                  // already off, let Escape fall through as normal.
                  ev.stopPropagation();
                  ev.stopImmediatePropagation();
                  ev.preventDefault();
                }
                document.removeEventListener('keydown', _exitEdit, true);
                layer._catExitEdit = null;
              };
              layer._catExitEdit = _exitEdit;
              document.addEventListener('keydown', _exitEdit, true);
            }
          });

          // Shift+mousedown starts translate-drag of the whole layer group
          enableLayerTranslateDrag(layer, layerGroup, layerId, layerColor);

          // Save geometry when edit finishes
          layer.on('edit', async () => {
            const updated = layer.toGeoJSON();
            await saveFeatureGeometry(
              featureData.feature_id,
              layerId,
              updated
            );
            layer.editing.disable();
            _removeStaleEditHandles(layer);
            layer.setStyle({ color: layerColor, dashArray: null });
            if (layer._catExitEdit) {
              document.removeEventListener('keydown', layer._catExitEdit, true);
              layer._catExitEdit = null;
            }
          });
        }
      });

      geoJsonLayer.addTo(layerGroup);
    });

    layerGroup.addTo(map);

    // Store layer reference
    overlayLayers[layerId] = {
      name: layerName,
      layerGroup: layerGroup,
      visible: true,
      opacity: 80,
      color: layerColor,
      layerType: layerType,
      featureCount: data.features.length
    };

    // Add to layer list UI with feature count & color
    addOverlayLayerToUI(layerId, layerName, data.features.length, layerColor, layerType);

  } catch (error) {
    console.error(`Error loading overlay layer ${layerId}:`, error);
    showStatus(`❌ Failed to load layer: ${layerName}`, 'error');
  }
}

/**
 * Add overlay layer to UI list
 */
function addOverlayLayerToUI(layerId, layerName, featureCount = 0, color = '#00ff00', layerType = null) {
  const listContainer = document.getElementById('overlayLayersList');
  if (!listContainer) return;

  const safeId = `overlay_${layerId}`;
  const typeBadge = layerType
    ? `<span style="font-size:9px;color:#fff;background:${layerType === 'transect' ? '#ff8c00' : '#1e90ff'};border-radius:3px;padding:1px 5px;margin-left:5px;text-transform:uppercase;">${layerType}</span>`
    : '';

  const layerHTML = `
    <div class="layer-item" id="${safeId}_item">
      <div class="layer-header" onclick="toggleLayerDetails('${safeId}_details')" style="cursor: pointer;">
        <div class="layer-name">
          <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:4px;"></span>
          <span>${layerName}</span>
          <span style="font-size:10px;color:#888;margin-left:4px;">(${featureCount})</span>
          ${typeBadge}
          <span class="layer-collapse-icon" id="${safeId}_detailsIcon">▼</span>
        </div>
        <label class="layer-toggle" onclick="event.stopPropagation();">
          <input type="checkbox" id="${safeId}_toggle" checked onchange="toggleOverlayLayer(${layerId})">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="layer-details" id="${safeId}_details">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <label style="font-size:11px; color:#aaa;">Color:</label>
          <input type="color" value="${color}" id="${safeId}_color"
                 onchange="changeOverlayColor(${layerId}, this.value)"
                 style="width:28px;height:22px;border:none;padding:0;cursor:pointer;background:transparent;">
          <label style="font-size:11px; color:#aaa; display:flex; align-items:center; gap:3px; cursor:pointer;">
            <input type="checkbox" id="${safeId}_borderOnly" onchange="toggleOverlayBorderOnly(${layerId})"> Border only
          </label>
          <button class="btn btn-sm" onclick="zoomToOverlayLayer(${layerId})"
                  style="font-size:11px;padding:2px 8px;background:#444;" title="Zoom to layer extent">
            🔍 Zoom
          </button>
        </div>
        <div class="opacity-control">
          <label>Opacity: <span id="${safeId}_opacityValue">80</span>%</label>
          <input type="range" class="opacity-slider" id="${safeId}_opacity"
                 min="0" max="100" value="80"
                 oninput="setOverlayOpacity(${layerId}, this.value)">
        </div>
        <button class="btn btn-sm btn-danger" onclick="removeOverlayLayer(${layerId})" 
                style="margin-top: 8px; font-size: 11px; padding: 4px 8px;">
          🗑️ Remove Layer
        </button>
      </div>
    </div>
  `;

  listContainer.insertAdjacentHTML('beforeend', layerHTML);

  // Auto-collapse details so loaded layers show compactly
  const details = document.getElementById(`${safeId}_details`);
  const icon = document.getElementById(`${safeId}_detailsIcon`);
  if (details) details.classList.add('collapsed');
  if (icon) icon.textContent = '▶';

  // Restore saved opacity/visibility from localStorage
  if (typeof catGetOverlayState === 'function') {
    const saved = catGetOverlayState(layerId);
    if (saved) {
      if (saved.opacity !== undefined && saved.opacity !== 80) {
        setOverlayOpacity(layerId, saved.opacity);
        const slider = document.getElementById(`${safeId}_opacity`);
        if (slider) slider.value = saved.opacity;
      }
      if (saved.visible === false) {
        const checkbox = document.getElementById(`overlay_${layerId}_toggle`);
        if (checkbox) { checkbox.checked = false; toggleOverlayLayer(layerId); }
      }
    }
  }
}

/**
 * Toggle overlay layer visibility
 */
function toggleOverlayLayer(layerId) {
  const layerData = overlayLayers[layerId];
  if (!layerData) return;

  const checkbox = document.getElementById(`overlay_${layerId}_toggle`);
  const visible = checkbox.checked;

  if (visible) {
    layerData.layerGroup.addTo(map);
  } else {
    map.removeLayer(layerData.layerGroup);
  }

  layerData.visible = visible;
  if (typeof catSaveOverlayState === 'function') catSaveOverlayState(layerId, layerData.opacity || 80, visible);
}

/**
 * Set overlay layer opacity
 */
function setOverlayOpacity(layerId, value) {
  const layerData = overlayLayers[layerId];
  if (!layerData) return;

  document.getElementById(`overlay_${layerId}_opacityValue`).textContent = value;

  const opacityRatio = value / 100;
  const borderOnly = layerData.borderOnly || false;
  layerData.layerGroup.setStyle({
    opacity: opacityRatio * 0.8,
    fillOpacity: borderOnly ? 0 : opacityRatio * 0.2
  });

  layerData.opacity = parseInt(value);
  if (typeof catSaveOverlayState === 'function') catSaveOverlayState(layerId, parseInt(value), layerData.visible !== false);
}

/**
 * Toggle border-only mode for an overlay layer (hide fill, keep stroke)
 */
function toggleOverlayBorderOnly(layerId) {
  const layerData = overlayLayers[layerId];
  if (!layerData) return;

  const checkbox = document.getElementById(`overlay_${layerId}_borderOnly`);
  const borderOnly = checkbox ? checkbox.checked : false;
  layerData.borderOnly = borderOnly;

  const opacityRatio = (layerData.opacity || 80) / 100;
  layerData.layerGroup.setStyle({
    fillOpacity: borderOnly ? 0 : opacityRatio * 0.2
  });
}

/**
 * Remove overlay layer (deletes from both map and database)
 */
async function removeOverlayLayer(layerId) {
  if (!await catConfirm('Remove this overlay layer and all its features? This cannot be undone.', { danger: true, ok: 'Remove' })) return;

  const layerData = overlayLayers[layerId];
  if (!layerData) return;

  try {
    // Delete from database
    const resp = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}`,
      { method: 'DELETE' }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || 'Delete failed');
    }

    // Clean up any in-flight vertex-edit Escape listener on this layer's
    // features before tearing it down, so deleting a layer mid-edit doesn't
    // leak a document-level capture keydown listener.
    layerData.layerGroup.eachLayer(geoJsonGroup => {
      const cleanupChild = (child) => {
        if (child._catExitEdit) {
          document.removeEventListener('keydown', child._catExitEdit, true);
          child._catExitEdit = null;
        }
      };
      if (geoJsonGroup.eachLayer) {
        geoJsonGroup.eachLayer(cleanupChild);
      } else {
        cleanupChild(geoJsonGroup);
      }
    });

    // Remove from map
    map.removeLayer(layerData.layerGroup);
    delete overlayLayers[layerId];

    // Remove from UI
    const item = document.getElementById(`overlay_${layerId}_item`);
    if (item) item.remove();

    showStatus(`✅ Deleted layer: ${layerData.name}`, 'success');
  } catch (error) {
    console.error('Error deleting overlay layer:', error);
    showStatus(`❌ Failed to delete layer: ${error.message}`, 'error');
  }
}

/**
 * Save edited feature geometry back to Oracle database
 */
async function saveFeatureGeometry(featureId, layerId, geoJSON) {
  try {
    const response = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}/features/${featureId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: geoJSON })
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || 'Save failed');
    }

    console.log(`💾 Feature ${featureId} geometry saved`);
    showStatus('💾 Feature geometry saved', 'success');
  } catch (error) {
    console.error('Error saving feature geometry:', error);
    showStatus(`❌ Failed to save geometry: ${error.message}`, 'error');
  }
}

/**
 * Zoom map to the bounds of an overlay layer
 */
function zoomToOverlayLayer(layerId) {
  const layerData = overlayLayers[layerId];
  if (!layerData || !layerData.layerGroup) return;

  try {
    const bounds = layerData.layerGroup.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
    }
  } catch (e) {
    console.warn('Could not zoom to layer:', e);
  }
}

/**
 * Change overlay layer color and save to database
 */
async function changeOverlayColor(layerId, newColor) {
  const layerData = overlayLayers[layerId];
  if (!layerData) return;

  // Update visual style on the map
  layerData.layerGroup.setStyle({ color: newColor });
  layerData.color = newColor;

  // Update the color swatch in the header
  const item = document.getElementById(`overlay_${layerId}_item`);
  if (item) {
    const swatch = item.querySelector('.layer-name span');
    if (swatch) swatch.style.background = newColor;
  }

  // Persist to database
  try {
    await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style_json: { color: newColor, weight: 2, opacity: 0.7 } })
      }
    );
  } catch (e) {
    console.warn('Failed to save color:', e);
  }
}

// ============================================================================
// FEATURE TRANSFORM — Move/Rotate individual features or entire layers
// ============================================================================
// Controls:
//   Drag (no modifier) = Move the single feature under the cursor
//   Ctrl+drag           = Move the entire layer group
//   Alt+drag            = Rotate the single feature around its centroid
//
// A plain mousedown on a feature is always intercepted (so it can never fall
// through to a map pan, which used to look like "the whole layer moved" when
// no modifier was held) but nothing is committed until the cursor has moved
// past a small pixel threshold — that keeps single-click (popup) and
// double-click (vertex edit) working exactly as before for a feature that's
// merely clicked, not dragged.
// ============================================================================

let _transformState = null;

function enableLayerTranslateDrag(layer, layerGroup, layerId, layerColor) {
  layer.on('mousedown', function (e) {
    // Never let this bubble into Leaflet's own map-drag handling.
    L.DomEvent.stop(e);

    // Don't start a transform while this feature is mid vertex-edit —
    // fighting Leaflet.Draw's own handle state is what was crashing.
    if (layer.editing && layer.editing.enabled()) {
      if (typeof showStatus === 'function') {
        showStatus('⚠️ Press Escape to finish editing vertices before moving/rotating', 'warning');
      }
      return;
    }

    const ctrl = e.originalEvent.ctrlKey || e.originalEvent.metaKey;
    const alt = e.originalEvent.altKey;
    const mode = alt ? 'rotate' : (ctrl ? 'moveLayer' : 'moveFeature');

    const downPoint = map.mouseEventToContainerPoint(e.originalEvent);
    const DRAG_THRESHOLD_PX = 4;

    function armedMove(moveEvt) {
      const p = map.mouseEventToContainerPoint(moveEvt.originalEvent);
      if (downPoint.distanceTo(p) < DRAG_THRESHOLD_PX) return;
      map.off('mousemove', armedMove);
      map.off('mouseup', armedUp);
      _beginTransform(mode, layer, layerGroup, layerId, layerColor, e.latlng);
    }
    function armedUp() {
      map.off('mousemove', armedMove);
      map.off('mouseup', armedUp);
      // Released without moving past the threshold — a plain click, not a
      // drag. Leave it alone; the layer's own click/dblclick handlers
      // (popup, vertex-edit toggle) already fire independently of this.
    }

    map.on('mousemove', armedMove);
    map.on('mouseup', armedUp);
  });
}

function _beginTransform(mode, layer, layerGroup, layerId, layerColor, startLatLng) {
  // Visual feedback
  if (mode === 'moveLayer') {
    layerGroup.setStyle({ color: '#00bcd4', weight: 3, dashArray: '4,4' });
  } else {
    layer.setStyle({ color: '#ff5722', weight: 4, dashArray: '4,4' });
  }

  // Compute centroid for rotation
  let centroid = null;
  if (mode === 'rotate' && layer.getLatLngs) {
    centroid = _computeCentroid(layer.getLatLngs());
  }

  _transformState = {
    mode: mode,
    layer: layer,
    layerGroup: layerGroup,
    layerId: layerId,
    color: layerColor,
    startLatLng: startLatLng,
    centroid: centroid,
    startAngle: centroid ? Math.atan2(startLatLng.lng - centroid.lng, startLatLng.lat - centroid.lat) : 0
  };

  map.dragging.disable();
  map.on('mousemove', _onTransformMove);
  map.on('mouseup', _onTransformEnd);

  const hints = {
    moveFeature: '🔀 Moving this feature — drag to reposition, release to drop.',
    moveLayer: '🔀 Ctrl+drag — moving entire layer. Release to drop.',
    rotate: '🔄 Alt+drag — rotating this feature. Release to apply.'
  };
  if (typeof showStatus === 'function') showStatus(hints[mode], 'info');
}

function _onTransformMove(e) {
  if (!_transformState) return;
  const { mode, layer, layerGroup, startLatLng, centroid, startAngle } = _transformState;

  try {
    if (mode === 'moveFeature') {
      // Move single feature
      const dLat = e.latlng.lat - startLatLng.lat;
      const dLng = e.latlng.lng - startLatLng.lng;
      _offsetLayer(layer, dLat, dLng);
      _transformState.startLatLng = e.latlng;

    } else if (mode === 'moveLayer') {
      // Move entire layer group
      const dLat = e.latlng.lat - startLatLng.lat;
      const dLng = e.latlng.lng - startLatLng.lng;
      layerGroup.eachLayer(geoJsonGroup => {
        if (geoJsonGroup.eachLayer) {
          geoJsonGroup.eachLayer(sub => _offsetLayer(sub, dLat, dLng));
        } else {
          _offsetLayer(geoJsonGroup, dLat, dLng);
        }
      });
      _transformState.startLatLng = e.latlng;

    } else if (mode === 'rotate' && centroid) {
      // Rotate single feature around centroid
      const currentAngle = Math.atan2(e.latlng.lng - centroid.lng, e.latlng.lat - centroid.lat);
      const deltaAngle = currentAngle - startAngle;
      _rotateLayer(layer, centroid, deltaAngle);
      _transformState.startAngle = currentAngle;
    }
  } catch (err) {
    // Never leave the map stuck (dragging disabled, stale state) if a
    // mid-drag geometry update throws — end the transform cleanly instead.
    console.error('Error during feature transform:', err);
    _onTransformEnd();
  }
}

function _onTransformEnd() {
  if (!_transformState) return;
  const { mode, layer, layerGroup, layerId, color } = _transformState;

  // Cleanup that must always happen, even if persistence below throws —
  // this is what previously could leave the map stuck with dragging
  // disabled ("crashed") if something in the save/style-reset step failed.
  map.off('mousemove', _onTransformMove);
  map.off('mouseup', _onTransformEnd);
  map.dragging.enable();

  try {
    // Reset styles
    if (mode === 'moveLayer') {
      layerGroup.setStyle({ color: color, weight: 2, dashArray: null });
    } else {
      layer.setStyle({ color: color, weight: 2, dashArray: null });
    }

    // Persist geometry changes
    if (mode === 'moveLayer') {
      layerGroup.eachLayer(geoJsonGroup => {
        if (geoJsonGroup.eachLayer) {
          geoJsonGroup.eachLayer(sub => {
            if (sub._overlayFeatureId) {
              saveFeatureGeometry(sub._overlayFeatureId, layerId, sub.toGeoJSON());
            }
          });
        }
      });
      if (typeof showStatus === 'function') showStatus('✅ Layer moved & saved', 'success');
    } else {
      // Single feature (move or rotate)
      if (layer._overlayFeatureId) {
        saveFeatureGeometry(layer._overlayFeatureId, layerId, layer.toGeoJSON());
      }
      const msg = mode === 'rotate' ? '✅ Feature rotated & saved' : '✅ Feature moved & saved';
      if (typeof showStatus === 'function') showStatus(msg, 'success');
    }
  } catch (err) {
    console.error('Error finishing feature transform:', err);
    if (typeof showStatus === 'function') showStatus('❌ Error saving move/rotate — see console', 'error');
  } finally {
    _transformState = null;
  }
}

// ── Edit handle cleanup ──
// Leaflet.Draw's editing.disable() doesn't always remove handle DOM elements.
// Force-remove them so white squares don't linger on the map.
function _removeStaleEditHandles(layer) {
  if (layer._map) {
    // Leaflet.Draw stores edit markers in layer.editing._markerGroup
    const mg = layer.editing && layer.editing._markerGroup;
    if (mg) {
      mg.clearLayers();
      if (layer._map.hasLayer(mg)) layer._map.removeLayer(mg);
    }
    // Also remove any leftover resize/move marker groups
    if (layer.editing && layer.editing._verticesHandlers) {
      layer.editing._verticesHandlers.forEach(function(h) {
        if (h._markerGroup) {
          h._markerGroup.clearLayers();
          if (layer._map.hasLayer(h._markerGroup)) layer._map.removeLayer(h._markerGroup);
        }
      });
    }
  }
}

// ── Geometry helpers ──

function _offsetLayer(layer, dLat, dLng) {
  if (layer.getLatLngs) {
    const shifted = _offsetLatLngs(layer.getLatLngs(), dLat, dLng);
    layer.setLatLngs(shifted);
  } else if (layer.getLatLng) {
    const ll = layer.getLatLng();
    layer.setLatLng(L.latLng(ll.lat + dLat, ll.lng + dLng));
  }
}

function _offsetLatLngs(latlngs, dLat, dLng) {
  if (Array.isArray(latlngs[0])) {
    return latlngs.map(ring => _offsetLatLngs(ring, dLat, dLng));
  }
  return latlngs.map(ll => L.latLng(ll.lat + dLat, ll.lng + dLng));
}

function _rotateLayer(layer, centroid, angle) {
  if (!layer.getLatLngs) return;
  const rotated = _rotateLatLngs(layer.getLatLngs(), centroid, angle);
  layer.setLatLngs(rotated);
}

function _rotateLatLngs(latlngs, center, angle) {
  if (Array.isArray(latlngs[0])) {
    return latlngs.map(ring => _rotateLatLngs(ring, center, angle));
  }
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return latlngs.map(ll => {
    const dLat = ll.lat - center.lat;
    const dLng = ll.lng - center.lng;
    return L.latLng(
      center.lat + dLat * cos - dLng * sin,
      center.lng + dLat * sin + dLng * cos
    );
  });
}

function _computeCentroid(latlngs) {
  // Flatten nested arrays (polygons)
  const flat = Array.isArray(latlngs[0]) ? latlngs.flat() : latlngs;
  if (flat.length === 0) return null;
  let sumLat = 0, sumLng = 0;
  flat.forEach(ll => { sumLat += ll.lat; sumLng += ll.lng; });
  return L.latLng(sumLat / flat.length, sumLng / flat.length);
}

// ============================================================================
// TOOLBAR INTEGRATION — called by v2-bulk.js to wire toolbar buttons
// ============================================================================

/**
 * Open a file picker for overlay upload (used by toolbar button)
 */
function triggerOverlayUpload() {
  // Ensure the modal's upload widget (with the type selector) exists before
  // falling back to a bare temporary input.
  addOverlayUploadUI();

  let input = document.getElementById('overlayFileInput');
  if (!input) {
    // Create a temporary file input if the modal upload widget isn't available
    input = document.createElement('input');
    input.type = 'file';
    input.id = 'overlayFileInputToolbar';
    input.accept = '.zip,.shp,.shx,.dbf,.prj,.cpg';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', (e) => handleOverlayFileSelect(e));
    document.body.appendChild(input);
  }
  input.click();
}

// ============================================================================
// AD-HOC SEGMENTS/TRANSECTS — click to draw a multi-point path (straight or a
// bent/irregular shape), auto-generate both the transect + segment layers
// together using the standard 2.5m-segment / 5m-spacing layout from the
// ArcGIS pipeline (arcgis_scripts_v11's non-camera _generate_transect_lines
// convention), without any raster/mask auto-placement.
// ============================================================================

let _transectDrawState = null;

function startTransectDrawMode() {
  if (!currentProjectId) {
    showStatus('⚠️ No project loaded', 'warning');
    return;
  }
  if (typeof map === 'undefined' || !map) {
    showStatus('⚠️ Map not ready', 'warning');
    return;
  }

  cancelTransectDrawMode();

  _transectDrawState = { points: [], markers: [], polyline: null };
  map.getContainer().style.cursor = 'crosshair';
  document.addEventListener('keydown', _onTransectKeydown, true);
  map.on('click', _onTransectClick);
  map.on('mousemove', _onTransectMouseMove);

  showTransectDrawHint();
  showStatus('📏 Click to add points along the transect path. Click Finish when done (Esc to cancel).', 'info');
}

function _onTransectKeydown(e) {
  if (e.key === 'Escape') {
    cancelTransectDrawMode();
  } else if (e.key === 'Enter') {
    finishTransectDraw();
  }
}

function cancelTransectDrawMode() {
  if (typeof map !== 'undefined' && map) {
    map.off('click', _onTransectClick);
    map.off('mousemove', _onTransectMouseMove);
    map.getContainer().style.cursor = '';
    if (_transectDrawState) {
      _transectDrawState.markers.forEach(m => map.removeLayer(m));
      if (_transectDrawState.polyline) map.removeLayer(_transectDrawState.polyline);
    }
  }
  document.removeEventListener('keydown', _onTransectKeydown, true);
  _transectDrawState = null;
  const hint = document.getElementById('transectDrawHint');
  if (hint) hint.remove();
  const panel = document.getElementById('transectGeneratePanel');
  if (panel) panel.remove();
}

function _onTransectClick(e) {
  if (!_transectDrawState) return;
  _transectDrawState.points.push(e.latlng);
  const marker = L.circleMarker(e.latlng, {
    radius: 5, color: '#ff8c00', fillColor: '#ff8c00', fillOpacity: 1
  }).addTo(map);
  _transectDrawState.markers.push(marker);
  _updateTransectPolyline();
  _updateTransectDrawHint();
}

function _onTransectMouseMove(e) {
  if (!_transectDrawState || _transectDrawState.points.length === 0) return;
  _updateTransectPolyline(e.latlng);
}

function _updateTransectPolyline(previewPoint) {
  const pts = _transectDrawState.points.slice();
  if (previewPoint) pts.push(previewPoint);
  if (pts.length < 2) return;
  if (_transectDrawState.polyline) {
    _transectDrawState.polyline.setLatLngs(pts);
  } else {
    _transectDrawState.polyline = L.polyline(pts, { color: '#ff8c00', weight: 2, dashArray: '6,4' }).addTo(map);
  }
}

function finishTransectDraw() {
  if (!_transectDrawState || _transectDrawState.points.length < 2) {
    showStatus('⚠️ Click at least 2 points to define the transect path', 'warning');
    return;
  }
  map.off('click', _onTransectClick);
  map.off('mousemove', _onTransectMouseMove);
  map.getContainer().style.cursor = '';

  const hint = document.getElementById('transectDrawHint');
  if (hint) hint.remove();

  showTransectGeneratePanel();
}

function showTransectDrawHint() {
  const existing = document.getElementById('transectDrawHint');
  if (existing) existing.remove();

  const hint = document.createElement('div');
  hint.id = 'transectDrawHint';
  hint.style.cssText = 'position:fixed; top:70px; right:20px; z-index:5000; background:#232323; ' +
    'border:1px solid #444; border-radius:6px; padding:12px; width:220px; color:#eee; ' +
    'box-shadow:0 4px 16px rgba(0,0,0,0.4); font-size:12px;';
  hint.innerHTML = `
    <div style="font-weight:600; margin-bottom:6px;">📏 Draw Transect Path</div>
    <div style="color:#aaa; margin-bottom:8px;">
      Click to add points (<span id="transectPointCount">0</span> so far).
      Straight line or a bent/irregular path both work.
    </div>
    <div style="display:flex; gap:6px;">
      <button class="btn btn-primary btn-sm" style="flex:1;" onclick="finishTransectDraw()">Finish</button>
      <button class="btn btn-secondary btn-sm" style="flex:1;" onclick="cancelTransectDrawMode()">Cancel</button>
    </div>
  `;
  document.body.appendChild(hint);
}

function _updateTransectDrawHint() {
  const countEl = document.getElementById('transectPointCount');
  if (countEl && _transectDrawState) countEl.textContent = _transectDrawState.points.length;
}

function showTransectGeneratePanel() {
  const existing = document.getElementById('transectGeneratePanel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'transectGeneratePanel';
  panel.style.cssText = 'position:fixed; top:70px; right:20px; z-index:5000; background:#232323; ' +
    'border:1px solid #444; border-radius:6px; padding:14px; width:220px; color:#eee; ' +
    'box-shadow:0 4px 16px rgba(0,0,0,0.4); font-size:12px;';
  panel.innerHTML = `
    <div style="font-weight:600; margin-bottom:8px;">📏 Generate Transect + Segments</div>
    <label style="display:block; margin-bottom:4px;">Segments</label>
    <select id="transectSegCount" style="width:100%; margin-bottom:10px; padding:3px;">
      <option value="4" selected>4 (Medium / Shallow)</option>
      <option value="3">3 (Deep)</option>
    </select>
    <div style="display:flex; gap:6px;">
      <button class="btn btn-primary btn-sm" style="flex:1;" onclick="confirmTransectGenerate()">Generate</button>
      <button class="btn btn-secondary btn-sm" style="flex:1;" onclick="cancelTransectDrawMode()">Cancel</button>
    </div>
  `;
  document.body.appendChild(panel);
}

async function confirmTransectGenerate() {
  const state = _transectDrawState;
  if (!state || state.points.length < 2) return;

  const select = document.getElementById('transectSegCount');
  const numSegments = select ? parseInt(select.value, 10) : 4;
  const points = state.points.map(p => ({ lat: p.lat, lng: p.lng }));

  const panel = document.getElementById('transectGeneratePanel');
  if (panel) panel.innerHTML = '<div style="text-align:center;padding:10px;">Generating…</div>';

  try {
    const response = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/generate-transect`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points, num_segments: numSegments })
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || 'Failed to generate transect');
    }

    const result = await response.json();
    cancelTransectDrawMode();

    // Both layers are created together in one call — load them both immediately.
    await loadOverlayLayer(
      result.transect_layer.layer_id, result.transect_layer.layer_name,
      (result.transect_layer.style || {}).color || '#ff8c00', 'transect'
    );
    await loadOverlayLayer(
      result.segment_layer.layer_id, result.segment_layer.layer_name,
      (result.segment_layer.style || {}).color || '#1e90ff', 'segment'
    );

    showStatus('✅ Transect and segments created', 'success');
  } catch (error) {
    console.error('Error generating transect:', error);
    showStatus(`❌ Failed to generate transect: ${error.message}`, 'error');
    cancelTransectDrawMode();
  }
}

// Make functions globally accessible
if (typeof window !== 'undefined') {
  window.initializeOverlayControls = initializeOverlayControls;
  window.handleOverlayDragOver = handleOverlayDragOver;
  window.handleOverlayDragLeave = handleOverlayDragLeave;
  window.handleOverlayDrop = handleOverlayDrop;
  window.handleOverlayFileSelect = handleOverlayFileSelect;
  window.toggleOverlayLayer = toggleOverlayLayer;
  window.setOverlayOpacity = setOverlayOpacity;
  window.removeOverlayLayer = removeOverlayLayer;
  window.zoomToOverlayLayer = zoomToOverlayLayer;
  window.changeOverlayColor = changeOverlayColor;
  window.openLayerManagementModal = openLayerManagementModal;
  window.closeLayerManagementModal = closeLayerManagementModal;
  window.saveLayerManagement = saveLayerManagement;
  window.triggerOverlayUpload = triggerOverlayUpload;
  window.enableLayerTranslateDrag = enableLayerTranslateDrag;
  window.startTransectDrawMode = startTransectDrawMode;
  window.cancelTransectDrawMode = cancelTransectDrawMode;
  window.finishTransectDraw = finishTransectDraw;
  window.confirmTransectGenerate = confirmTransectGenerate;
}

// ============================================================================
// LAYER MANAGEMENT MODAL
// ============================================================================

let managementLayers = []; // Store layers for management
let layerOrderChanged = false;

/**
 * Open layer management modal
 */
async function openLayerManagementModal() {
  if (!currentProjectId) {
    showStatus('⚠️ No project loaded', 'warning');
    return;
  }

  const modal = document.getElementById('layerManagementModal');
  if (!modal) return;

  addOverlayUploadUI();

  // Load all layers (including inactive)
  try {
    const response = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers`
    );

    if (!response.ok) {
      throw new Error('Failed to load layers');
    }

    const data = await response.json();
    managementLayers = data.layers || [];

    // Sort by display_order
    managementLayers.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

    renderLayerManagementList();

    const cta = document.getElementById('layerManagementTransectCta');
    if (cta) {
      const hasTransect = managementLayers.some(l => l.layer_type === 'transect');
      cta.style.display = 'block';
      const ctaBtn = cta.querySelector('button');
      if (ctaBtn) {
        ctaBtn.className = hasTransect ? 'btn btn-secondary' : 'btn btn-primary';
        ctaBtn.style.width = hasTransect ? 'auto' : '100%';
      }
    }

    modal.style.display = 'flex';
    layerOrderChanged = false;

  } catch (error) {
    console.error('Error loading layers:', error);
    showStatus('❌ Failed to load layers', 'error');
  }
}

/**
 * Close layer management modal
 */
function closeLayerManagementModal() {
  const modal = document.getElementById('layerManagementModal');
  if (modal) modal.style.display = 'none';
  managementLayers = [];
  layerOrderChanged = false;
}

/**
 * Render layer management list
 */
function renderLayerManagementList() {
  const listContainer = document.getElementById('layerManagementList');
  const emptyMessage = document.getElementById('layerManagementEmpty');

  if (!listContainer) return;

  if (managementLayers.length === 0) {
    listContainer.innerHTML = '';
    listContainer.style.display = 'none';
    if (emptyMessage) emptyMessage.style.display = 'block';
    return;
  }

  if (emptyMessage) emptyMessage.style.display = 'none';
  listContainer.style.display = 'block';

  listContainer.innerHTML = managementLayers.map((layer, index) => `
    <div class="layer-management-item" data-layer-id="${layer.layer_id}" data-index="${index}" draggable="true">
      <div style="display: flex; align-items: center; gap: 10px; padding: 12px; background: #2a2a2a; border-radius: 4px; margin-bottom: 8px; cursor: move;">
        <span style="color: #666; font-size: 18px;">☰</span>
        <input type="checkbox" 
               id="layer_active_${layer.layer_id}" 
               ${layer.is_active ? 'checked' : ''}
               onchange="toggleLayerActive(${layer.layer_id})"
               style="cursor: pointer;">
        <label for="layer_active_${layer.layer_id}" style="flex: 1; cursor: pointer; color: ${layer.is_active ? '#fff' : '#888'};">
          ${layer.layer_name}
          ${layer.layer_type ? `<span style="font-size:9px;color:#fff;background:${layer.layer_type === 'transect' ? '#ff8c00' : '#1e90ff'};border-radius:3px;padding:1px 5px;margin-left:5px;text-transform:uppercase;">${layer.layer_type}</span>` : ''}
        </label>
        <span style="color: #666; font-size: 11px;">${layer.created_at?.split('T')[0] || ''}</span>
        <button class="btn btn-sm" onclick="deleteLayerFromManagement(${layer.layer_id})" 
                style="background: #8b0000; padding: 4px 8px; font-size: 11px;">
          🗑️ Delete
        </button>
      </div>
    </div>
  `).join('');

  // Add drag and drop handlers
  const items = listContainer.querySelectorAll('.layer-management-item');
  items.forEach(item => {
    item.addEventListener('dragstart', handleLayerDragStart);
    item.addEventListener('dragover', handleLayerDragOver);
    item.addEventListener('drop', handleLayerDrop);
    item.addEventListener('dragend', handleLayerDragEnd);
  });
}

/**
 * Toggle layer active state
 */
function toggleLayerActive(layerId) {
  const layer = managementLayers.find(l => l.layer_id === layerId);
  if (layer) {
    layer.is_active = layer.is_active ? 0 : 1;
    renderLayerManagementList();
  }
}

/**
 * Delete layer from management
 */
async function deleteLayerFromManagement(layerId) {
  if (!await catConfirm('Are you sure? This will permanently delete the layer and all its features.', { danger: true, ok: 'Delete' })) {
    return;
  }

  try {
    const response = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}`,
      { method: 'DELETE' }
    );

    if (!response.ok) {
      throw new Error('Failed to delete layer');
    }

    // Remove from array
    managementLayers = managementLayers.filter(l => l.layer_id !== layerId);
    renderLayerManagementList();
    showStatus('✅ Layer deleted', 'success');

  } catch (error) {
    console.error('Error deleting layer:', error);
    showStatus('❌ Failed to delete layer', 'error');
  }
}

/**
 * Save layer management changes
 */
async function saveLayerManagement() {
  try {
    // Update display order if changed
    if (layerOrderChanged) {
      const layerOrders = managementLayers.map((layer, index) => ({
        layer_id: layer.layer_id,
        display_order: index
      }));

      const orderResponse = await fetch(
        `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/reorder`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layer_orders: layerOrders })
        }
      );

      if (!orderResponse.ok) {
        throw new Error('Failed to reorder layers');
      }
    }

    // Update each layer's is_active state
    for (const layer of managementLayers) {
      await fetch(
        `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layer.layer_id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: layer.is_active })
        }
      );
    }

    showStatus('✅ Layer settings saved', 'success');
    closeLayerManagementModal();

    // Reload layers on map
    await loadExistingOverlays(currentProjectId);

  } catch (error) {
    console.error('Error saving layer management:', error);
    showStatus('❌ Failed to save changes', 'error');
  }
}

// ============================================================================
// DRAG AND DROP FOR REORDERING
// ============================================================================

let draggedItem = null;

function handleLayerDragStart(e) {
  draggedItem = e.target.closest('.layer-management-item');
  e.dataTransfer.effectAllowed = 'move';
  draggedItem.style.opacity = '0.5';
}

function handleLayerDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  
  const targetItem = e.target.closest('.layer-management-item');
  if (targetItem && targetItem !== draggedItem) {
    targetItem.style.borderTop = '2px solid #4CAF50';
  }
}

function handleLayerDrop(e) {
  e.preventDefault();
  
  const targetItem = e.target.closest('.layer-management-item');
  if (!targetItem || targetItem === draggedItem) return;

  const draggedIndex = parseInt(draggedItem.dataset.index);
  const targetIndex = parseInt(targetItem.dataset.index);

  // Reorder array
  const [removed] = managementLayers.splice(draggedIndex, 1);
  managementLayers.splice(targetIndex, 0, removed);

  layerOrderChanged = true;
  renderLayerManagementList();
}

function handleLayerDragEnd(e) {
  if (draggedItem) {
    draggedItem.style.opacity = '1';
  }
  
  // Remove all border highlights
  document.querySelectorAll('.layer-management-item').forEach(item => {
    item.style.borderTop = 'none';
  });
  
  draggedItem = null;
}

// Export management functions
if (typeof window !== 'undefined') {
  window.toggleLayerActive = toggleLayerActive;
  window.deleteLayerFromManagement = deleteLayerFromManagement;
}

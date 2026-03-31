/* ================================================
   CAT - Coral Annotation Tool
   Layer Management (COG/TIF, Shapefiles, DEM)
   ================================================ */

// Note: Global variables (tifLayers, shapefileLayers, currentCOG) are declared in annotation-main.js
// Local variables for this module
let demLayer = null;
let projectBounds = null;

/**
 * Load a COG/TIF layer onto the map
 * @param {Object} tif - TIF layer configuration object
 */
async function loadTifLayer(tif) {
  const cogPath = encodeURIComponent(tif.cog_path);
  let tileUrl = `${window.location.origin}/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${cogPath}`;
  
  const isDEM = tif.type === 'DEM' || tif.name.toLowerCase().includes('dem');
  
  // For DEMs, fetch statistics and add proper parameters
  if (isDEM) {
    const safeId = `tif_${tif.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const colormapSelect = document.getElementById(`${safeId}_colormap`);
    const colormap = colormapSelect?.value || 'viridis';
    
    try {
      const statsUrl = `${window.location.origin}/statistics?url=${cogPath}`;
      const statsResponse = await fetch(statsUrl);
      const stats = await statsResponse.json();
      
      console.log('DEM statistics:', stats);
      
      const bandStats = stats.b1 || stats['1'] || (stats.statistics && stats.statistics[0]) || {};
      const min = bandStats.percentile_2 || bandStats.min || -10;
      const max = bandStats.percentile_98 || bandStats.max || 10;
      
      console.log('Using DEM rescale:', min, 'to', max);
      tileUrl += `&bidx=1&colormap_name=${colormap}&rescale=${min},${max}`;
    } catch (error) {
      console.warn('Could not fetch DEM statistics, using defaults:', error);
      tileUrl += `&bidx=1&colormap_name=${colormap}&rescale=-10,10`;
    }
  }
  
  console.log('🔧 Loading TIF layer:', {
    name: tif.name,
    cogPath: tif.cog_path,
    tileUrl: tileUrl,
    bounds: tif.bounds,
    epsg: tif.epsg,
    type: tif.type
  });
  
  const defaultOpacity = isDEM ? 0.7 : 1.0;
  
  const layer = L.tileLayer(tileUrl, {
    tms: false,
    opacity: defaultOpacity,
    attribution: tif.name,
    maxZoom: 2000,
    minZoom: 0,
    tileSize: 256,
    errorTileUrl: '',
    crossOrigin: true,
    pane: isDEM ? 'demPane' : 'cogPane'
  });
  
  const map = getMap();
  if (!map) {
    console.error('Map not initialized');
    return;
  }
  
  layer.addTo(map);
  tifLayers[tif.id] = layer;
  
  if (isDEM) {
    demLayer = layer;
    const demControls = document.getElementById('demGlobalControls');
    if (demControls) {
      demControls.style.display = 'block';
    }
  }
  
  // Track tile loading
  setupTileErrorHandling(layer);
  
  // Handle bounds
  if (tif.bounds && tif.bounds.length === 4) {
    handleTifBounds(tif);
  }
  
  console.log('✅ Loaded layer:', tif.name);
  
  // Set as current COG if it's not a DEM
  if (!isDEM) {
    currentCOG = tif;
  }
}

/**
 * Setup tile error handling for a layer
 * @param {L.TileLayer} layer - Tile layer
 */
function setupTileErrorHandling(layer) {
  let tileLoadCount = 0;
  let tileErrorCount = 0;
  
  layer.on('tileerror', (error) => {
    tileErrorCount++;
    if (tileErrorCount <= 3) {
      console.error('❌ Tile load error #' + tileErrorCount + ':', error.tile.src);
      
      fetch(error.tile.src)
        .then(res => res.text())
        .then(text => {
          try {
            const errorObj = JSON.parse(text);
            console.error('Server error details:', errorObj);
          } catch(e) {
            console.error('Server response:', text.substring(0, 500));
          }
        })
        .catch(err => console.error('Fetch error:', err));
    }
    if (tileErrorCount === 10) {
      console.error('⚠️ Suppressing further tile error messages...');
    }
  });
  
  layer.on('tileloadstart', (e) => {
    if (tileLoadCount < 3) {
      console.log('📥 Tile request:', e.tile.src);
      tileLoadCount++;
    }
  });
  
  layer.on('tileload', (e) => {
    if (tileLoadCount <= 3) {
      console.log('✅ Tile loaded:', e.tile.naturalWidth, 'x', e.tile.naturalHeight);
    }
  });
}

/**
 * Handle TIF bounds and coordinate system issues
 * @param {Object} tif - TIF configuration object
 */
function handleTifBounds(tif) {
  const [minLng, minLat, maxLng, maxLat] = tif.bounds;
  const hasInvalidCoords = Math.abs(minLat) < 0.1 || Math.abs(maxLat) < 0.1;
  
  if (hasInvalidCoords) {
    console.warn('⚠️ COORDINATE SYSTEM ISSUE DETECTED!');
    console.warn('Latitude values near 0° (equator):', {minLat, maxLat});
    console.warn('EPSG:', tif.epsg);
    console.warn('💡 COG may have incorrect georeferencing');
  }
  
  projectBounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
  
  console.log('📍 Project bounds:', {
    southwest: [minLat, minLng],
    northeast: [maxLat, maxLng],
    epsg: tif.epsg,
    center: projectBounds.getCenter()
  });
  
  // Zoom to bounds on first layer load
  if (Object.keys(tifLayers).length === 1) {
    const map = getMap();
    if (map) {
      map.fitBounds(projectBounds, { padding: [50, 50] });
      console.log('🎯 Zoomed to layer bounds');
    }
  }
}

/**
 * Remove a TIF layer from the map
 * @param {string} tifId - TIF layer ID
 */
function removeTifLayer(tifId) {
  if (tifLayers[tifId]) {
    const map = getMap();
    if (map) {
      map.removeLayer(tifLayers[tifId]);
    }
    
    if (tifLayers[tifId] === demLayer) {
      demLayer = null;
      const demControls = document.getElementById('demGlobalControls');
      if (demControls) {
        demControls.style.display = 'none';
      }
    }
    
    delete tifLayers[tifId];
    console.log('Removed TIF layer:', tifId);
  }
}

/**
 * Load a shapefile layer onto the map
 * @param {Object} shapefile - Shapefile configuration object
 * @param {string} safeId - Safe HTML ID for the shapefile
 */
async function loadShapefileLayer(shapefile, safeId) {
  console.log('Loading shapefile:', shapefile.name);
  
  // Check if already loaded to prevent duplicates
  if (shapefileLayers[shapefile.name]) {
    console.log('Shapefile already loaded:', shapefile.name);
    return;
  }
  
  const shapefilePath = shapefile.shapefile_path || shapefile.path;
  
  if (!shapefilePath) {
    console.error('No shapefile path found for:', shapefile.name);
    alert(`Missing path for shapefile: ${shapefile.name}`);
    const checkbox = document.querySelector(`[data-shapefile-name="${shapefile.name}"]`);
    if (checkbox) checkbox.checked = false;
    return;
  }
  
  console.log('📂 Shapefile path:', shapefilePath);
  
  try {
    const fetchUrl = `${window.location.origin}/api/file-projects/shapefile?path=${encodeURIComponent(shapefilePath)}`;
    console.log('🌐 Fetching shapefile from:', fetchUrl);
    
    const response = await fetch(fetchUrl);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Shapefile load failed (${response.status}):`, errorText);
      alert(`Failed to load shapefile: ${shapefile.name}\nError: ${errorText}`);
      const checkbox = document.querySelector(`[data-shapefile-name="${shapefile.name}"]`);
      if (checkbox) checkbox.checked = false;
      return;
    }
    
    const geojson = await response.json();
    console.log('📊 GeoJSON features:', geojson.features?.length || 0);
    
    if (!geojson.features || geojson.features.length === 0) {
      console.warn('⚠️ Shapefile has no features');
      alert(`Shapefile "${shapefile.name}" is empty (no features)`);
      const checkbox = document.querySelector(`[data-shapefile-name="${shapefile.name}"]`);
      if (checkbox) checkbox.checked = false;
      return;
    }
    
    // Create layer with shapefilePane to stay below annotations
    const layer = L.geoJSON(geojson, {
      pane: 'shapefilePane',
      style: {
        color: '#ff7800',
        weight: 2,
        opacity: 0.8,
        fillOpacity: 0.15
      }
    });
    
    shapefileLayers[shapefile.name] = {
      layer: layer,
      visible: true,
      opacity: 80
    };
    
    const map = getMap();
    if (map) {
      layer.addTo(map);
      
      const bounds = layer.getBounds();
      console.log('✅ Loaded shapefile:', shapefile.name);
      console.log('📏 Shapefile bounds:', bounds);
      
      // Check if shapefile is visible in current view
      const mapBounds = map.getBounds();
      const shapefileVisible = mapBounds.intersects(bounds);
      console.log('👁️ Shapefile visible in current view:', shapefileVisible);
      
      if (!shapefileVisible) {
        console.warn('⚠️ Shapefile is outside current map view!');
        if (confirm(`Shapefile "${shapefile.name}" loaded but is outside the current view.\n\nZoom to shapefile location?`)) {
          map.fitBounds(bounds, { padding: [50, 50] });
        }
      }
    }
  } catch (error) {
    console.error('Error loading shapefile:', error);
    alert(`Error loading shapefile: ${shapefile.name}`);
    const checkbox = document.querySelector(`[data-shapefile-name="${shapefile.name}"]`);
    if (checkbox) checkbox.checked = false;
  }
}

/**
 * Remove a shapefile layer from the map
 * @param {string} shapefileName - Shapefile name
 */
function removeShapefileLayer(shapefileName) {
  if (shapefileLayers[shapefileName]) {
    const map = getMap();
    if (map) {
      map.removeLayer(shapefileLayers[shapefileName].layer);
    }
    delete shapefileLayers[shapefileName];
    console.log('Removed shapefile:', shapefileName);
  }
}

/**
 * Toggle shapefile layer visibility
 * @param {string} shapefileName - Shapefile name
 * @param {boolean} visible - Whether to show the layer
 */
function toggleShapefileVisibility(shapefileName, visible) {
  const shapefileData = shapefileLayers[shapefileName];
  if (!shapefileData) return;
  
  const map = getMap();
  if (!map) return;
  
  if (visible) {
    shapefileData.layer.addTo(map);
    shapefileData.visible = true;
  } else {
    map.removeLayer(shapefileData.layer);
    shapefileData.visible = false;
  }
}

/**
 * Set shapefile layer opacity
 * @param {string} shapefileName - Shapefile name
 * @param {number} opacity - Opacity value (0-100)
 */
/**
 * Set shapefile layer opacity
 * @param {string} shapefileName - Name of the shapefile
 * @param {number} value - Opacity value (0-100)
 * @param {string} safeId - Safe ID for DOM elements
 */
function setShapefileOpacity(shapefileName, value, safeId) {
  // Update display value
  if (safeId) {
    const displayElement = document.getElementById(`shapefile_${safeId}_opacityValue`);
    if (displayElement) {
      displayElement.textContent = value;
    }
  }
  
  // Update layer opacity
  const shapefileData = shapefileLayers[shapefileName];
  if (shapefileData && shapefileData.layer) {
    // Store the opacity value
    shapefileData.opacity = parseInt(value);
    
    // Update both stroke and fill opacity proportionally
    const opacityRatio = value / 100;
    shapefileData.layer.setStyle({
      opacity: opacityRatio * 0.8,  // Stroke opacity (80% of slider value)
      fillOpacity: opacityRatio * 0.15  // Fill opacity (15% of slider value)
    });
    
    console.log(`Updated ${shapefileName} opacity to ${value}%`);
  }
}

/**
 * Toggle TIF layer visibility
 * @param {string} tifId - TIF layer ID
 * @param {boolean} visible - Whether to show the layer
 */
function toggleTifVisibility(tifId, visible) {
  const layer = tifLayers[tifId];
  if (!layer) return;
  
  const map = getMap();
  if (!map) return;
  
  if (visible) {
    layer.addTo(map);
  } else {
    map.removeLayer(layer);
  }
}

/**
 * Set TIF layer opacity
 * @param {string} tifId - TIF layer ID
 * @param {number} opacity - Opacity value (0-100)
 */
function setTifOpacity(tifId, opacity) {
  const layer = tifLayers[tifId];
  if (layer) {
    layer.setOpacity(opacity / 100);
  }
}

/**
 * Get all loaded TIF layers
 * @returns {Object} TIF layers object
 */
function getTifLayers() {
  return tifLayers;
}

/**
 * Get all loaded shapefile layers
 * @returns {Object} Shapefile layers object
 */
function getShapefileLayers() {
  return shapefileLayers;
}

/**
 * Get current COG layer
 * @returns {Object|null} Current COG configuration
 */
function getCurrentCOG() {
  return currentCOG;
}

/**
 * Get project bounds
 * @returns {L.LatLngBounds|null} Project bounds
 */
function getProjectBounds() {
  return projectBounds;
}

/**
 * Clear all layers from the map
 */
function clearAllLayers() {
  Object.keys(tifLayers).forEach(tifId => removeTifLayer(tifId));
  Object.keys(shapefileLayers).forEach(name => removeShapefileLayer(name));
}

/**
 * Build layer controls HTML dynamically
 * @param {Array} tifFiles - Array of TIF file objects from project
 */
function buildLayerControls(tifFiles) {
  const mapFileSection = document.getElementById('mapFileSection');
  if (!mapFileSection) {
    console.error('mapFileSection not found');
    return;
  }
  
  console.log('🎨 Building layer controls for', tifFiles.length, 'layers');
  
  // Clear existing content
  mapFileSection.innerHTML = `
    <div class="layer-subsection-title">🗺️ Map Files</div>
    <button onclick="zoomToSite()" style="width: 100%; margin-bottom: 10px; padding: 8px; background: linear-gradient(135deg, #06b6d4, #0891b2); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">📍 Zoom to Site</button>
  `;
  
  // Find first non-DEM TIF to auto-load
  let autoLoadTif = tifFiles.find(tif => {
    const isDEM = tif.type === 'DEM' || tif.name.toLowerCase().includes('dem');
    return !isDEM;
  });
  
  if (!autoLoadTif && tifFiles.length > 0) {
    autoLoadTif = tifFiles[0];
  }
  
  // Add each TIF file as a layer control
  tifFiles.forEach(tif => {
    const layerDiv = document.createElement('div');
    layerDiv.className = 'layer-item';
    const shouldAutoLoad = tif === autoLoadTif;
    const isDEM = tif.type === 'DEM' || tif.name.toLowerCase().includes('dem');
    const safeId = `tif_${tif.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    if (isDEM) {
      // DEM with collapsible controls
      layerDiv.innerHTML = `
        <div class="layer-header tif-header-${safeId}" style="cursor: pointer;">
          <div class="layer-name" style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
            <label onclick="event.stopPropagation()" style="display: flex; align-items: center; gap: 8px; flex: 1;">
              <input type="checkbox" class="tif-layer-checkbox" data-tif-id="${tif.id}" ${shouldAutoLoad ? 'checked' : ''}>
              <span>${tif.name}</span>
            </label>
            <span class="layer-collapse-icon" id="${safeId}_detailsIcon">▶</span>
          </div>
        </div>
        <div class="layer-details collapsed" id="${safeId}_details">
          <div class="opacity-control">
            <label>Opacity: <span id="${safeId}_opacityValue">70</span>%</label>
            <input type="range" class="opacity-slider" id="${safeId}_opacity" min="0" max="100" value="70" ${shouldAutoLoad ? '' : 'disabled'}>
          </div>
          <div class="opacity-control" style="margin-top: 8px;">
            <label>Colormap:</label>
            <select id="${safeId}_colormap" class="dem-colormap-select" ${shouldAutoLoad ? '' : 'disabled'} style="width: 100%; padding: 6px; border-radius: 4px; border: 1px solid #ddd; margin-top: 4px;">
              <option value="viridis" selected>Viridis</option>
              <option value="terrain">Terrain (Land)</option>
              <option value="ocean">Ocean (Bathymetry)</option>
              <option value="deep">Deep Ocean</option>
              <option value="plasma">Plasma</option>
              <option value="inferno">Inferno</option>
              <option value="cividis">Cividis</option>
              <option value="gray">Grayscale</option>
              <option value="rainbow">Rainbow</option>
              <option value="turbo">Turbo</option>
            </select>
            <p style="font-size: 10px; color: #999; margin: 4px 0 0 0;">💡 Use Ocean/Deep for underwater DEMs</p>
          </div>
        </div>
      `;
      
      // Add header click listener
      const header = layerDiv.querySelector(`.tif-header-${safeId}`);
      header.addEventListener('click', () => {
        toggleLayerDetails(`${safeId}_details`);
      });
    } else {
      // Regular TIF (orthomosaic)
      layerDiv.innerHTML = `
        <label>
          <input type="checkbox" class="tif-layer-checkbox" data-tif-id="${tif.id}" ${shouldAutoLoad ? 'checked' : ''}>
          <span>${tif.name}</span>
        </label>
      `;
    }
    
    mapFileSection.appendChild(layerDiv);
    
    // Add event listeners
    const checkbox = layerDiv.querySelector('.tif-layer-checkbox');
    const opacitySlider = layerDiv.querySelector(`#${safeId}_opacity`);
    const colormapSelect = layerDiv.querySelector(`#${safeId}_colormap`);
    
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        loadTifLayer(tif);
        if (isDEM && opacitySlider) opacitySlider.disabled = false;
        if (isDEM && colormapSelect) colormapSelect.disabled = false;
      } else {
        removeTifLayer(tif.id);
        if (isDEM && opacitySlider) opacitySlider.disabled = true;
        if (isDEM && colormapSelect) colormapSelect.disabled = true;
      }
    });
    
    // Opacity slider listener
    if (isDEM && opacitySlider) {
      opacitySlider.addEventListener('input', (e) => {
        const value = e.target.value;
        document.getElementById(`${safeId}_opacityValue`).textContent = value;
        setTifOpacity(tif.id, value, safeId);
      });
    }
    
    // Colormap change listener
    if (isDEM && colormapSelect) {
      colormapSelect.addEventListener('change', () => {
        // Reload the TIF with new colormap
        if (tifLayers[tif.id]) {
          removeTifLayer(tif.id);
          loadTifLayer(tif);
        }
      });
    }
    
    // Auto-load the first layer
    if (shouldAutoLoad) {
      loadTifLayer(tif);
    }
  });
  
  // Ensure shapefile container exists
  let shapefileContainer = document.getElementById('shapefileLayersContainer');
  if (!shapefileContainer) {
    shapefileContainer = document.createElement('div');
    shapefileContainer.id = 'shapefileLayersContainer';
    mapFileSection.appendChild(shapefileContainer);
  }
}

/**
 * Build shapefile controls HTML dynamically
 * @param {Array} shapefiles - Array of shapefile objects from project
 */
function buildShapefileControls(shapefiles) {
  const shapefileContainer = document.getElementById('shapefileLayersContainer');
  if (!shapefileContainer || !shapefiles || shapefiles.length === 0) {
    console.log('No shapefile container or no shapefiles to display');
    return;
  }
  
  console.log('🎨 Building shapefile controls for', shapefiles.length, 'shapefiles');
  
  shapefileContainer.innerHTML = '';
  
  for (const shapefile of shapefiles) {
    // Add to UI (unchecked by default - user can enable if needed)
    const layerDiv = document.createElement('div');
    layerDiv.className = 'layer-item';
    
    // Sanitize shapefile name for use in IDs
    const safeId = shapefile.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    // Use shapefile_path property (from project creator)
    const shapefilePath = shapefile.shapefile_path || shapefile.path;
    
    layerDiv.innerHTML = `
      <div class="layer-header shapefile-header-${safeId}" style="cursor: pointer;">
        <div class="layer-name" style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
          <label onclick="event.stopPropagation()" style="display: flex; align-items: center; gap: 8px; flex: 1;">
            <input type="checkbox" class="shapefile-checkbox" data-shapefile-name="${shapefile.name}" data-shapefile-path="${shapefilePath}" data-shapefile-id="${safeId}" checked>
            <span>${shapefile.name}</span>
          </label>
          <span class="layer-collapse-icon" id="shapefile_${safeId}_detailsIcon">▶</span>
        </div>
      </div>
      <div class="layer-details collapsed" id="shapefile_${safeId}_details">
        <div class="opacity-control">
          <label>Opacity: <span id="shapefile_${safeId}_opacityValue">80</span>%</label>
          <input type="range" class="opacity-slider shapefile-opacity-slider" id="shapefile_${safeId}_opacity" min="0" max="100" value="80" data-shapefile-name="${shapefile.name}" data-safe-id="${safeId}">
        </div>
      </div>
    `;
    shapefileContainer.appendChild(layerDiv);
    
    // Add header click listener for collapse/expand
    const header = layerDiv.querySelector(`.shapefile-header-${safeId}`);
    header.addEventListener('click', () => {
      toggleLayerDetails(`shapefile_${safeId}_details`);
    });
    
    // Add change listeners
    const checkbox = layerDiv.querySelector('.shapefile-checkbox');
    const opacitySlider = layerDiv.querySelector(`#shapefile_${safeId}_opacity`);
    
    // Opacity slider listener
    opacitySlider.addEventListener('input', (e) => {
      const value = e.target.value;
      setShapefileOpacity(shapefile.name, value, safeId);
    });
    
    // Checkbox listener
    checkbox.addEventListener('change', async (e) => {
      if (e.target.checked) {
        await loadShapefileLayer(shapefile, safeId);
        if (opacitySlider) opacitySlider.disabled = false;
      } else {
        removeShapefileLayer(shapefile.name);
        if (opacitySlider) opacitySlider.disabled = true;
      }
    });
    
    // Auto-load the shapefile
    loadShapefileLayer(shapefile, safeId);
  }
}

/**
 * Zoom to site bounds
 */
function zoomToSite() {
  if (currentProject && projectBounds) {
    map.fitBounds(projectBounds, { padding: [50, 50] });
    showStatus('✅ Zoomed to project extent', 'success');
  } else if (Object.keys(shapefileLayers).length > 0) {
    // Try to zoom to shapefile bounds
    const allBounds = [];
    Object.values(shapefileLayers).forEach(layerData => {
      if (layerData && layerData.layer) {
        const bounds = layerData.layer.getBounds();
        if (bounds.isValid()) {
          allBounds.push(bounds);
        }
      }
    });
    
    if (allBounds.length > 0) {
      const combinedBounds = allBounds[0];
      allBounds.slice(1).forEach(b => combinedBounds.extend(b));
      map.fitBounds(combinedBounds, { padding: [50, 50] });
      showStatus('✅ Zoomed to shapefile extent', 'success');
    }
  } else {
    showStatus('❌ No bounds available to zoom to', 'error');
  }
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    loadTifLayer,
    removeTifLayer,
    loadShapefileLayer,
    removeShapefileLayer,
    toggleShapefileVisibility,
    setShapefileOpacity,
    toggleTifVisibility,
    setTifOpacity,
    getTifLayers,
    getShapefileLayers,
    getCurrentCOG,
    getProjectBounds,
    clearAllLayers,
    buildLayerControls,
    buildShapefileControls,
    zoomToSite
  };
}

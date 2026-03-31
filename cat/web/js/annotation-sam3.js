/* ================================================
   CAT - Coral Annotation Tool
   SAM3 AI Segmentation (Point, Box, Smart Grid)
   ================================================ */

// Note: Global variables (magicWandActive, sam3Mode, sam3ModelSize, sam3ConfidenceThreshold)
// are declared in annotation-main.js
// Local variable for this module
let magicWandButton = null;

/**
 * Initialize SAM3 magic wand tool
 */
async function initSAM3MagicWand() {
  // Check if SAM3 is available
  try {
    const serverUrl = window.location.origin;
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
  
  // Add magic wand button to draw toolbar
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
  magicWandBtn.title = 'SAM3 AI Segmentation (F)';
  magicWandBtn.setAttribute('role', 'button');
  magicWandBtn.textContent = 'S';
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

/**
 * Toggle magic wand mode
 */
function toggleMagicWand() {
  magicWandActive = !magicWandActive;
  
  const sam3Panel = document.getElementById('sam3Panel');
  const map = getMap();
  
  if (magicWandActive) {
    // Activate magic wand mode
    if (magicWandButton) magicWandButton.classList.add('active');
    if (map) map.getContainer().style.cursor = 'crosshair';
    if (sam3Panel) sam3Panel.classList.add('active');
    showStatus('🪄 SAM3 Panel opened - Select mode and settings', 'info');
  } else {
    // Deactivate magic wand mode
    if (magicWandButton) magicWandButton.classList.remove('active');
    if (map) map.getContainer().style.cursor = '';
    if (sam3Panel) sam3Panel.classList.remove('active');
    showStatus('SAM3 Panel closed', 'info');
  }
}

/**
 * Close SAM3 panel
 */
function closeSAM3Panel() {
  magicWandActive = false;
  if (magicWandButton) magicWandButton.classList.remove('active');
  
  const map = getMap();
  if (map) map.getContainer().style.cursor = '';
  
  const sam3Panel = document.getElementById('sam3Panel');
  if (sam3Panel) sam3Panel.classList.remove('active');
  
  showStatus('SAM3 Panel closed', 'info');
}

/**
 * Set SAM3 mode (point, box, or grid)
 * @param {string} mode - Mode to set
 */
function setSAM3Mode(mode) {
  sam3Mode = mode;
  
  // Update UI buttons
  const pointBtn = document.getElementById('sam3PointMode');
  const boxBtn = document.getElementById('sam3BoxMode');
  const gridBtn = document.getElementById('sam3GridMode');
  
  if (pointBtn) pointBtn.classList.toggle('active', mode === 'point');
  if (boxBtn) boxBtn.classList.toggle('active', mode === 'box');
  if (gridBtn) gridBtn.classList.toggle('active', mode === 'grid');
  
  console.log(`🎯 SAM3 mode changed to: ${mode}`);
  
  if (mode === 'point') {
    showStatus('✅ Point Mode: Click directly on any coral to auto-segment it', 'info');
  } else if (mode === 'box' || mode === 'grid') {
    const modeLabel = mode === 'grid' ? 'Smart Grid' : 'Box';
    showStatus(`✅ ${modeLabel} Mode: Draw a rectangle (tool auto-activated)`, 'info');
    
    // Auto-activate rectangle drawing tool
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

/**
 * Update confidence threshold display
 */
function updateConfidenceDisplay() {
  const slider = document.getElementById('sam3Confidence');
  const display = document.getElementById('confidenceValue');
  
  if (slider && display) {
    const value = slider.value;
    display.textContent = value + '%';
    sam3ConfidenceThreshold = value / 100;
  }
}

/**
 * Clear temporary SAM3 segments
 */
function clearSAM3TempSegments() {
  const drawnItems = getDrawnItems();
  const projectAnnotations = getProjectAnnotations();
  let removedCount = 0;
  
  drawnItems.eachLayer(function(layer) {
    const layerId = layer._leaflet_id;
    const isSaved = projectAnnotations.some(ann => ann.leaflet_id === layerId);
    
    // Remove unsaved SAM3 segments (purple color)
    if (!isSaved && (layer.options.color === '#8b5cf6' || layer.options.fillColor === '#8b5cf6')) {
      drawnItems.removeLayer(layer);
      removedCount++;
    }
  });
  
  // Clear current annotation if it's SAM3 temp
  const currentAnnotation = getCurrentAnnotation();
  if (currentAnnotation && (currentAnnotation.createdBy === 'SAM3' || currentAnnotation.createdBy === 'SAM3-box')) {
    setCurrentAnnotation(null);
  }
  
  if (removedCount > 0) {
    showStatus(`🗑️ Cleared ${removedCount} temporary SAM3 segment(s)`, 'success');
    console.log(`Cleared ${removedCount} SAM3 temp segments`);
  } else {
    showStatus('No temporary segments to clear', 'info');
  }
}

/**
 * Setup SAM3 event handlers
 * @param {L.Map} map - Leaflet map instance
 */
function setupSAM3Handlers(map) {
  if (!map) {
    console.error('Cannot setup SAM3 handlers: map not provided');
    return;
  }
  
  // Handle map clicks for point mode
  map.on('click', handleSAM3PointClick);
  
  // Keyboard shortcut: F key
  document.addEventListener('keydown', handleSAM3Keyboard);
  
  // Model size selector
  const modelSizeSelect = document.getElementById('sam3ModelSize');
  if (modelSizeSelect) {
    modelSizeSelect.addEventListener('change', function() {
      sam3ModelSize = this.value;
      showStatus(`Model size changed to ${this.value}`, 'info');
    });
  }
  
  console.log('✅ SAM3 event handlers registered');
}

/**
 * Handle SAM3 keyboard shortcuts
 * @param {KeyboardEvent} e - Keyboard event
 */
function handleSAM3Keyboard(e) {
  if (e.key === 'f' || e.key === 'F') {
    // Don't trigger if typing in input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      return;
    }
    e.preventDefault();
    toggleMagicWand();
  }
}

/**
 * Handle map click for SAM3 point mode
 * @param {L.MouseEvent} e - Leaflet mouse event
 */
async function handleSAM3PointClick(e) {
  if (!magicWandActive) return;
  if (sam3Mode !== 'point') return;
  
  const currentCOG = getCurrentCOG();
  if (!currentCOG) {
    showStatus('Please load an orthomosaic first', 'error');
    return;
  }
  
  try {
    showLoading(true);
    showStatus('Loading SAM3 model...', 'info');
    
    const map = getMap();
    const serverUrl = window.location.origin;
    
    // Load SAM3 model
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
    
    // Get map bounds and size
    const bounds = map.getBounds();
    const mapSize = map.getSize();
    const boundsNorth = bounds.getNorth();
    const boundsSouth = bounds.getSouth();
    const boundsEast = bounds.getEast();
    const boundsWest = bounds.getWest();
    
    // Capture map image
    const mapContainer = map.getContainer();
    const mapCanvas = await html2canvas(mapContainer, {
      useCORS: true,
      allowTaint: true,
      logging: false,
      width: mapSize.x,
      height: mapSize.y
    });
    
    const imageData = mapCanvas.toDataURL('image/png');
    
    // Calculate click position in image coordinates
    const containerPoint = map.latLngToContainerPoint(latlng);
    const click_x = Math.round(containerPoint.x);
    const click_y = Math.round(containerPoint.y);
    
    console.log(`🎯 Click at pixel (${click_x}, ${click_y})`);
    
    // Call SAM3 API
    const response = await fetch(`${serverUrl}/api/sam/click-segment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      const canvasWidth = mapCanvas.width;
      const canvasHeight = mapCanvas.height;
      const geoCoords = [];
      
      // SAM3 returns flat array: [x1, y1, x2, y2, ...]
      if (typeof data.polygon[0] === 'number') {
        for (let i = 0; i < data.polygon.length; i += 2) {
          const px = data.polygon[i];
          const py = data.polygon[i + 1];
          
          if (px === undefined || py === undefined || isNaN(px) || isNaN(py)) {
            console.error(`Invalid pixel coordinates at index ${i}`);
            continue;
          }
          
          const lng = boundsWest + (px / canvasWidth) * (boundsEast - boundsWest);
          const lat = boundsNorth - (py / canvasHeight) * (boundsNorth - boundsSouth);
          geoCoords.push([lat, lng]);
        }
      }
      
      if (geoCoords.length === 0) {
        throw new Error('No valid coordinates generated');
      }
      
      // Create polygon
      const polygon = L.polygon(geoCoords, {
        color: '#8b5cf6',
        weight: 3,
        fillOpacity: 0.4,
        fillColor: '#8b5cf6',
        pane: 'annotationsPane'
      });
      
      const drawnItems = getDrawnItems();
      drawnItems.addLayer(polygon);
      polygon.addTo(map);
      map.fitBounds(polygon.getBounds(), { 
        padding: [50, 50],
        maxZoom: map.getZoom()
      });
      
      // Store as current annotation
      setCurrentAnnotation({
        layer: polygon,
        type: 'polygon',
        geometry: getFullPrecisionGeometry(polygon),
        createdBy: 'SAM3',
        confidence: data.confidence
      });
      
      console.log(`✅ SAM3 polygon added with ${geoCoords.length} points`);
      showStatus(`✅ SAM3 segmented! ${(data.confidence * 100).toFixed(1)}% confidence - Fill in details`, 'success');
      
      // Auto-focus species field
      setTimeout(() => {
        const speciesField = document.getElementById('spcode');
        if (speciesField) speciesField.focus();
      }, 150);
      
    } else {
      showStatus('No segment detected', 'warning');
    }
    
  } catch (error) {
    console.error('SAM3 error:', error);
    showStatus(`SAM3 error: ${error.message}`, 'error');
  } finally {
    showLoading(false);
  }
}

/**
 * Handle SAM3 box segmentation (called from drawing module)
 * @param {L.Layer} layer - Rectangle layer
 * @returns {Promise<boolean>} True if successful
 */
async function handleSAM3Box(layer) {
  console.log('📦 SAM3 box segmentation triggered');
  
  try {
    showLoading(true);
    showStatus('Running SAM3 box segmentation...', 'info');
    
    const map = getMap();
    const serverUrl = window.location.origin;
    
    // Load model
    const loadResponse = await fetch(`${serverUrl}/api/sam/load-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_size: sam3ModelSize })
    });
    
    if (!loadResponse.ok) {
      throw new Error('Failed to load SAM3 model');
    }
    
    // Get rectangle bounds
    const bounds = layer.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    
    // Get map info
    const mapBounds = map.getBounds();
    const mapSize = map.getSize();
    
    // Capture map
    const mapContainer = map.getContainer();
    const mapCanvas = await html2canvas(mapContainer, {
      useCORS: true,
      allowTaint: true,
      logging: false,
      width: mapSize.x,
      height: mapSize.y
    });
    
    const imageData = mapCanvas.toDataURL('image/png');
    
    // Convert bounds to pixel coordinates
    const swPoint = map.latLngToContainerPoint(sw);
    const nePoint = map.latLngToContainerPoint(ne);
    
    const box_x1 = Math.min(swPoint.x, nePoint.x);
    const box_y1 = Math.min(swPoint.y, nePoint.y);
    const box_x2 = Math.max(swPoint.x, nePoint.x);
    const box_y2 = Math.max(swPoint.y, nePoint.y);
    
    console.log(`📦 SAM3 box: [${box_x1}, ${box_y1}, ${box_x2}, ${box_y2}]`);
    
    // Call SAM3 box API
    const response = await fetch(`${serverUrl}/api/sam/box-segment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_data: imageData,
        box_x1: box_x1,
        box_y1: box_y1,
        box_x2: box_x2,
        box_y2: box_y2,
        return_polygon: true,
        confidence_threshold: sam3ConfidenceThreshold
      })
    });
    
    if (!response.ok) {
      throw new Error(`SAM3 box API error: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.success && data.polygon) {
      // Convert pixel polygon to geographic coordinates
      const boundsNorth = mapBounds.getNorth();
      const boundsSouth = mapBounds.getSouth();
      const boundsEast = mapBounds.getEast();
      const boundsWest = mapBounds.getWest();
      const canvasWidth = mapCanvas.width;
      const canvasHeight = mapCanvas.height;
      
      const geoCoords = [];
      
      for (let i = 0; i < data.polygon.length; i += 2) {
        const px = data.polygon[i];
        const py = data.polygon[i + 1];
        const lng = boundsWest + (px / canvasWidth) * (boundsEast - boundsWest);
        const lat = boundsNorth - (py / canvasHeight) * (boundsNorth - boundsSouth);
        geoCoords.push([lat, lng]);
      }
      
      // Remove the rectangle box
      const drawnItems = getDrawnItems();
      drawnItems.removeLayer(layer);
      
      // Create refined polygon
      const refinedPolygon = L.polygon(geoCoords, {
        color: '#8b5cf6',
        weight: 3,
        fillOpacity: 0.4,
        fillColor: '#8b5cf6',
        pane: 'annotationsPane'
      });
      
      drawnItems.addLayer(refinedPolygon);
      refinedPolygon.addTo(map);
      map.fitBounds(refinedPolygon.getBounds(), { 
        padding: [50, 50],
        maxZoom: map.getZoom()
      });
      
      // Store as current annotation
      setCurrentAnnotation({
        type: 'polygon',
        layer: refinedPolygon,
        geometry: getFullPrecisionGeometry(refinedPolygon),
        createdBy: 'SAM3-box',
        confidence: data.confidence
      });
      
      console.log(`✅ SAM3 box polygon added with ${geoCoords.length} points`);
      showStatus(`✅ SAM3 refined! ${(data.confidence * 100).toFixed(1)}% confidence - Fill in details`, 'success');
      showLoading(false);
      
      // Auto-focus species field
      setTimeout(() => {
        const speciesField = document.getElementById('spcode');
        if (speciesField) speciesField.focus();
      }, 150);
      
      return true;
    } else {
      showStatus('SAM3 box segmentation failed', 'warning');
      showLoading(false);
      return false;
    }
    
  } catch (error) {
    console.error('SAM3 box error:', error);
    showStatus(`SAM3 error: ${error.message}`, 'error');
    showLoading(false);
    return false;
  }
}

/**
 * Run SAM3 Smart Grid segmentation
 * @param {L.Layer} layer - Rectangle layer defining grid area
 */
async function runSAM3SmartGrid(layer) {
  try {
    showLoading(true);
    showStatus('🎯 Smart Grid: Analyzing area...', 'info');
    
    const map = getMap();
    const serverUrl = window.location.origin;
    
    // Load SAM3 model
    const loadResponse = await fetch(`${serverUrl}/api/sam/load-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_size: sam3ModelSize })
    });
    
    if (!loadResponse.ok) {
      throw new Error('Failed to load SAM3 model');
    }
    
    // Get rectangle bounds
    const bounds = layer.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    
    // Get map info
    const mapBounds = map.getBounds();
    const mapSize = map.getSize();
    
    // Capture map once
    showStatus('📸 Capturing map...', 'info');
    const mapContainer = map.getContainer();
    const mapCanvas = await html2canvas(mapContainer, {
      useCORS: true,
      allowTaint: true,
      logging: false,
      width: mapSize.x,
      height: mapSize.y
    });
    
    const imageData = mapCanvas.toDataURL('image/png');
    
    // Convert to pixel coordinates
    const swPoint = map.latLngToContainerPoint(sw);
    const nePoint = map.latLngToContainerPoint(ne);
    
    const boxX1 = Math.min(swPoint.x, nePoint.x);
    const boxY1 = Math.min(swPoint.y, nePoint.y);
    const boxX2 = Math.max(swPoint.x, nePoint.x);
    const boxY2 = Math.max(swPoint.y, nePoint.y);
    
    const boxWidth = boxX2 - boxX1;
    const boxHeight = boxY2 - boxY1;
    const boxArea = boxWidth * boxHeight;
    
    // Determine grid density
    const densitySetting = document.getElementById('sam3GridDensity')?.value || 'auto';
    let gridSize;
    
    if (densitySetting === 'auto') {
      if (boxArea < 40000) gridSize = 3;
      else if (boxArea < 100000) gridSize = 5;
      else if (boxArea < 200000) gridSize = 7;
      else gridSize = 10;
      console.log(`📐 Auto-selected ${gridSize}x${gridSize} grid`);
    } else {
      gridSize = parseInt(densitySetting);
    }
    
    // Generate grid points
    const samplePoints = [];
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const px = boxX1 + (boxWidth / (gridSize + 1)) * (col + 1);
        const py = boxY1 + (boxHeight / (gridSize + 1)) * (row + 1);
        samplePoints.push({ x: Math.round(px), y: Math.round(py) });
      }
    }
    
    console.log(`🎯 Processing ${samplePoints.length} sample points...`);
    showStatus(`🎯 Processing ${samplePoints.length} points...`, 'info');
    
    // Create progress markers
    const progressMarkers = L.layerGroup().addTo(map);
    
    // Process in batches
    const allPolygons = [];
    const batchSize = 5;
    
    for (let i = 0; i < samplePoints.length; i += batchSize) {
      const batch = samplePoints.slice(i, Math.min(i + batchSize, samplePoints.length));
      showStatus(`🎯 Points ${i + 1}-${Math.min(i + batchSize, samplePoints.length)}/${samplePoints.length}...`, 'info');
      
      const batchPromises = batch.map(async (point) => {
        try {
          const response = await fetch(`${serverUrl}/api/sam/click-segment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image_data: imageData,
              click_x: point.x,
              click_y: point.y,
              return_polygon: true,
              confidence_threshold: sam3ConfidenceThreshold
            })
          });
          
          const dotLatLng = map.containerPointToLatLng([point.x, point.y]);
          
          if (response.ok) {
            const data = await response.json();
            
            if (data.success && data.polygon && data.confidence >= 0.70) {
              L.circleMarker(dotLatLng, { radius: 4, color: 'green', fillOpacity: 0.8 }).addTo(progressMarkers);
              return {
                polygon: data.polygon,
                confidence: data.confidence,
                success: true
              };
            }
          }
          
          L.circleMarker(dotLatLng, { radius: 3, color: 'red', fillOpacity: 0.7 }).addTo(progressMarkers);
        } catch (err) {
          console.warn('Point failed:', err);
        }
        return null;
      });
      
      const results = await Promise.all(batchPromises);
      results.forEach(r => { if (r && r.success) allPolygons.push(r); });
    }
    
    console.log(`✅ ${allPolygons.length} segments detected`);
    
    if (allPolygons.length === 0) {
      showStatus('⚠️ No corals found in area', 'warning');
      showLoading(false);
      const drawnItems = getDrawnItems();
      drawnItems.removeLayer(layer);
      setTimeout(() => progressMarkers.remove(), 3000);
      return;
    }
    
    // Remove duplicates
    showStatus('🔄 Removing duplicates...', 'info');
    const uniquePolygons = removeDuplicatePolygonsAdvanced(allPolygons);
    console.log(`🎯 ${uniquePolygons.length} unique corals after deduplication`);
    
    // Remove rectangle and progress markers
    const drawnItems = getDrawnItems();
    drawnItems.removeLayer(layer);
    setTimeout(() => progressMarkers.remove(), 2000);
    
    // Create polygons on map
    const boundsNorth = mapBounds.getNorth();
    const boundsSouth = mapBounds.getSouth();
    const boundsEast = mapBounds.getEast();
    const boundsWest = mapBounds.getWest();
    const canvasWidth = mapCanvas.width;
    const canvasHeight = mapCanvas.height;
    
    const createdPolygons = [];
    
    for (let idx = 0; idx < uniquePolygons.length; idx++) {
      const polyData = uniquePolygons[idx];
      const geoCoords = [];
      
      for (let i = 0; i < polyData.polygon.length; i += 2) {
        const px = polyData.polygon[i];
        const py = polyData.polygon[i + 1];
        const lng = boundsWest + (px / canvasWidth) * (boundsEast - boundsWest);
        const lat = boundsNorth - (py / canvasHeight) * (boundsNorth - boundsSouth);
        geoCoords.push([lat, lng]);
      }
      
      // Color by confidence
      let color = polyData.confidence >= 0.90 ? '#10b981' : 
                  polyData.confidence >= 0.80 ? '#8b5cf6' : '#f59e0b';
      
      const polygon = L.polygon(geoCoords, {
        color: color,
        weight: 3,
        fillOpacity: 0.4,
        fillColor: color,
        pane: 'annotationsPane'
      });
      
      polygon.bindTooltip(`#${idx + 1} - ${(polyData.confidence * 100).toFixed(1)}%`, {
        permanent: false,
        direction: 'top'
      });
      
      drawnItems.addLayer(polygon);
      polygon.addTo(map);
      
      createdPolygons.push({
        polygon: polyData.polygon,
        confidence: polyData.confidence,
        geoCoords: geoCoords
      });
    }
    
    window.lastGridResults = createdPolygons;
    
    showStatus(`✅ Found ${uniquePolygons.length} unique corals! (Green=High, Purple=Med, Orange=Lower)`, 'success');
    showLoading(false);
    
  } catch (error) {
    console.error('Smart Grid error:', error);
    showStatus(`Smart Grid error: ${error.message}`, 'error');
    showLoading(false);
    const drawnItems = getDrawnItems();
    drawnItems.removeLayer(layer);
  }
}

/**
 * Remove duplicate polygons using IoU
 * @param {Array} polygons - Array of polygon data
 * @returns {Array} Unique polygons
 */
function removeDuplicatePolygonsAdvanced(polygons) {
  if (polygons.length === 0) return [];
  
  polygons.sort((a, b) => b.confidence - a.confidence);
  
  const unique = [polygons[0]];
  
  for (let i = 1; i < polygons.length; i++) {
    const poly1 = polygons[i];
    let isDuplicate = false;
    
    for (const existing of unique) {
      const iou = calculatePolygonIoU(poly1.polygon, existing.polygon);
      
      if (iou > 0.5) {
        isDuplicate = true;
        break;
      }
    }
    
    if (!isDuplicate) {
      unique.push(polygons[i]);
    }
  }
  
  return unique;
}

/**
 * Calculate Intersection over Union for polygons
 * @param {Array} poly1 - First polygon (flat array)
 * @param {Array} poly2 - Second polygon (flat array)
 * @returns {number} IoU value
 */
function calculatePolygonIoU(poly1, poly2) {
  const center1 = getPolygonCenter(poly1);
  const center2 = getPolygonCenter(poly2);
  const distance = Math.sqrt(Math.pow(center1.x - center2.x, 2) + Math.pow(center1.y - center2.y, 2));
  
  if (distance > 100) return 0;
  
  const bbox1 = getPolygonBBox(poly1);
  const bbox2 = getPolygonBBox(poly2);
  
  const overlapX = Math.max(0, Math.min(bbox1.maxX, bbox2.maxX) - Math.max(bbox1.minX, bbox2.minX));
  const overlapY = Math.max(0, Math.min(bbox1.maxY, bbox2.maxY) - Math.max(bbox1.minY, bbox2.minY));
  const overlapArea = overlapX * overlapY;
  
  if (overlapArea === 0) return 0;
  
  const area1 = calculatePolygonArea(poly1);
  const area2 = calculatePolygonArea(poly2);
  const unionArea = area1 + area2 - overlapArea;
  
  return overlapArea / unionArea;
}

/**
 * Get polygon bounding box
 */
function getPolygonBBox(flatPolygon) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (let i = 0; i < flatPolygon.length; i += 2) {
    minX = Math.min(minX, flatPolygon[i]);
    maxX = Math.max(maxX, flatPolygon[i]);
    minY = Math.min(minY, flatPolygon[i + 1]);
    maxY = Math.max(maxY, flatPolygon[i + 1]);
  }
  
  return { minX, minY, maxX, maxY };
}

/**
 * Get polygon center
 */
function getPolygonCenter(flatPolygon) {
  let sumX = 0, sumY = 0, count = 0;
  for (let i = 0; i < flatPolygon.length; i += 2) {
    sumX += flatPolygon[i];
    sumY += flatPolygon[i + 1];
    count++;
  }
  return { x: sumX / count, y: sumY / count };
}

/**
 * Calculate polygon area using Shoelace formula
 */
function calculatePolygonArea(flatPolygon) {
  let area = 0;
  const n = flatPolygon.length / 2;
  
  for (let i = 0; i < n; i++) {
    const x1 = flatPolygon[i * 2];
    const y1 = flatPolygon[i * 2 + 1];
    const x2 = flatPolygon[((i + 1) % n) * 2];
    const y2 = flatPolygon[((i + 1) % n) * 2 + 1];
    area += (x1 * y2) - (x2 * y1);
  }
  
  return Math.abs(area) / 2;
}

// Make functions globally accessible
window.initSAM3MagicWand = initSAM3MagicWand;
window.toggleMagicWand = toggleMagicWand;
window.closeSAM3Panel = closeSAM3Panel;
window.setSAM3Mode = setSAM3Mode;
window.updateConfidenceDisplay = updateConfidenceDisplay;
window.clearSAM3TempSegments = clearSAM3TempSegments;
window.runSAM3SmartGrid = runSAM3SmartGrid;
window.handleSAM3Box = handleSAM3Box;

// Export functions
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initSAM3MagicWand,
    setupSAM3Handlers,
    toggleMagicWand,
    setSAM3Mode,
    handleSAM3Box,
    runSAM3SmartGrid,
    clearSAM3TempSegments
  };
}

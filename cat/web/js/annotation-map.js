/* ================================================
   CAT - Coral Annotation Tool
   Map Initialization & Configuration
   ================================================ */

// Note: Global variables (map, drawnItems, drawControl) are declared in annotation-main.js

/**
 * Initialize the Leaflet map with custom configuration
 * @returns {L.Map} Initialized Leaflet map instance
 */
function initializeMap() {
  console.log('🗺️ Initializing map...');
  
  // Create map centered at origin
  map = L.map('map', {
    center: [0, 0],
    zoom: 2,
    zoomControl: false,  // We'll add it to the right side
    maxZoom: 2000
  });
  
  // Add zoom control to top-right (grouped with drawing tools)
  L.control.zoom({
    position: 'topright'
  }).addTo(map);
  
  // Add scale control (shows map scale)
  L.control.scale({
    imperial: true,
    metric: true
  }).addTo(map);
  
  // Create custom panes for proper layer z-index ordering
  createMapPanes();
  
  // Create feature group for annotations
  drawnItems = new L.FeatureGroup([], { pane: 'annotationsPane' });
  map.addLayer(drawnItems);
  
  // Add drawing controls
  setupDrawControls();
  
  // Override distance display for better precision
  overrideDistanceDisplay();
  
  console.log('✅ Map initialized');
  
  return map;
}

/**
 * Create custom Leaflet panes for proper z-index layering
 * Default Leaflet z-index structure:
 * - tiles: 200
 * - overlays: 400
 * - shadows: 500
 * - markers: 600
 * - tooltips: 650
 * - popups: 700
 * 
 * Our custom ordering: COG tiles (150) < DEM (300) < shapefile (450) < annotations (650)
 * This ensures annotations are always clickable on top
 */
function createMapPanes() {
  if (!map) return;
  
  // COG/TIF tiles - bottom layer
  if (!map.getPane('cogPane')) {
    map.createPane('cogPane');
    map.getPane('cogPane').style.zIndex = 150;
    console.log('Created cogPane with z-index 150 (bottom)');
  }
  
  // DEM layer
  if (!map.getPane('demPane')) {
    map.createPane('demPane');
    map.getPane('demPane').style.zIndex = 300;
    console.log('Created demPane with z-index 300 (DEM layer)');
  }
  
  // Shapefile layer - middle
  if (!map.getPane('shapefilePane')) {
    map.createPane('shapefilePane');
    map.getPane('shapefilePane').style.zIndex = 450;
    map.getPane('shapefilePane').style.pointerEvents = 'none'; // Allow clicks to pass through
    console.log('Created shapefilePane with z-index 450 (middle, non-interactive)');
  }
  
  // Annotations - top layer (always clickable)
  if (!map.getPane('annotationsPane')) {
    map.createPane('annotationsPane');
    map.getPane('annotationsPane').style.zIndex = 650;
    map.getPane('annotationsPane').style.pointerEvents = 'auto'; // Ensure annotations are clickable
    console.log('Created annotationsPane with z-index 650 (ON TOP, interactive)');
  }
}

/**
 * Setup Leaflet Draw controls for annotation drawing
 */
function setupDrawControls() {
  if (!map || !drawnItems) return;
  
  drawControl = new L.Control.Draw({
    position: 'topright',
    draw: {
      polyline: {
        shapeOptions: {
          color: '#f357a1',
          weight: 7,
          pane: 'annotationsPane'
        },
        maxPoints: 2,  // Straight line only (2 points)
        showLength: true,
        metric: true
      },
      polygon: {
        allowIntersection: false,
        shapeOptions: {
          color: '#667eea',
          weight: 7,
          fillOpacity: 0.3,
          pane: 'annotationsPane'
        }
      },
      rectangle: {
        shapeOptions: {
          color: '#f59e0b',
          weight: 7,
          fillOpacity: 0.3,
          pane: 'annotationsPane'
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
  console.log('✅ Draw controls added');
}

/**
 * Update visual feedback for active drawing tool
 * @param {string} activeButtonClass - CSS class of active button
 */
function updateDrawingToolVisualFeedback(activeButtonClass) {
  // Remove active class from all drawing buttons
  const allButtons = document.querySelectorAll(
    '.leaflet-draw-draw-polyline, .leaflet-draw-draw-polygon, .leaflet-draw-draw-rectangle'
  );
  allButtons.forEach(btn => btn.classList.remove('drawing-tool-active'));
  
  // Add active class to the current tool
  if (activeButtonClass) {
    const activeButton = document.querySelector(activeButtonClass);
    if (activeButton) {
      activeButton.classList.add('drawing-tool-active');
    }
  }
}

/**
 * Override Leaflet Draw's distance display for better precision
 * Shows 3 decimal places for sub-meter measurements
 */
function overrideDistanceDisplay() {
  if (L.GeometryUtil && L.GeometryUtil.readableDistance) {
    L.GeometryUtil.readableDistance = function(distance, isMetric, useFeet, isNauticalMile, precision) {
      let distanceStr;
      
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
    console.log('✅ Distance display precision updated');
  }
}

/**
 * Get current map bounds
 * @returns {L.LatLngBounds|null} Current map bounds
 */
function getMapBounds() {
  return map ? map.getBounds() : null;
}

/**
 * Get current map center
 * @returns {L.LatLng|null} Current map center
 */
function getMapCenter() {
  return map ? map.getCenter() : null;
}

/**
 * Get current map zoom level
 * @returns {number|null} Current zoom level
 */
function getMapZoom() {
  return map ? map.getZoom() : null;
}

/**
 * Fit map to bounds
 * @param {L.LatLngBounds} bounds - Bounds to fit
 * @param {Object} options - Leaflet fitBounds options
 */
function fitMapToBounds(bounds, options = {}) {
  if (map && bounds) {
    map.fitBounds(bounds, options);
  }
}

/**
 * Set map view to specific location
 * @param {Array} center - [lat, lng]
 * @param {number} zoom - Zoom level
 */
function setMapView(center, zoom) {
  if (map) {
    map.setView(center, zoom);
  }
}

/**
 * Add layer to map
 * @param {L.Layer} layer - Layer to add
 */
function addLayerToMap(layer) {
  if (map && layer) {
    layer.addTo(map);
  }
}

/**
 * Remove layer from map
 * @param {L.Layer} layer - Layer to remove
 */
function removeLayerFromMap(layer) {
  if (map && layer) {
    map.removeLayer(layer);
  }
}

/**
 * Get the map instance
 * @returns {L.Map|null} Map instance
 */
function getMap() {
  return map;
}

/**
 * Get the drawn items feature group
 * @returns {L.FeatureGroup|null} Drawn items group
 */
function getDrawnItems() {
  return drawnItems;
}

/**
 * Get the draw control
 * @returns {L.Control.Draw|null} Draw control instance
 */
function getDrawControl() {
  return drawControl;
}

/**
 * Check if map is initialized
 * @returns {boolean} True if map exists
 */
function isMapInitialized() {
  return map !== null;
}

/**
 * Invalidate map size (call after container resize)
 */
function invalidateMapSize() {
  if (map) {
    map.invalidateSize();
  }
}

/**
 * Add coordinate display on mouse move
 */
function enableCoordinateDisplay() {
  if (!map) return;
  
  const coordDiv = document.createElement('div');
  coordDiv.id = 'coordinateDisplay';
  coordDiv.style.cssText = `
    position: absolute;
    bottom: 30px;
    right: 10px;
    background: rgba(255, 255, 255, 0.9);
    padding: 5px 10px;
    border-radius: 4px;
    font-size: 11px;
    z-index: 1000;
    display: none;
  `;
  document.body.appendChild(coordDiv);
  
  map.on('mousemove', function(e) {
    coordDiv.style.display = 'block';
    coordDiv.textContent = `Lat: ${e.latlng.lat.toFixed(6)}, Lng: ${e.latlng.lng.toFixed(6)}`;
  });
  
  map.on('mouseout', function() {
    coordDiv.style.display = 'none';
  });
}

// Export functions for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initializeMap,
    createMapPanes,
    setupDrawControls,
    updateDrawingToolVisualFeedback,
    getMapBounds,
    getMapCenter,
    getMapZoom,
    fitMapToBounds,
    setMapView,
    addLayerToMap,
    removeLayerFromMap,
    getMap,
    getDrawnItems,
    getDrawControl,
    isMapInitialized,
    invalidateMapSize,
    enableCoordinateDisplay
  };
}

/* ================================================
   CAT - Coral Annotation Tool
   Utility Functions
   ================================================ */

/**
 * Display status message to user
 * @param {string} message - Message to display
 * @param {string} type - Message type: 'success', 'error', or 'info'
 */
function showStatus(message, type) {
  // Delegate to global toast system if available
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

/**
 * Show/hide loading overlay
 * @param {boolean} show - Whether to show the loading overlay
 */
function showLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.toggle('active', show);
  }
}

/**
 * Format seconds into HH:MM:SS format
 * @param {number} seconds - Total seconds
 * @returns {string} Formatted time string
 */
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * Format total time with units
 * @param {number} seconds - Total seconds
 * @returns {string} Formatted time with units
 */
function formatTotalTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

/**
 * Extract full-precision geometry from Leaflet layer
 * IMPORTANT: Leaflet's toGeoJSON() truncates coordinates to 6 decimal places by default,
 * which causes ~1 meter precision loss. This function extracts coordinates directly
 * from the layer's internal LatLng objects to preserve full floating-point precision.
 * 
 * @param {L.Layer} layer - Leaflet layer object
 * @returns {Object} GeoJSON geometry object with full precision coordinates
 */
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

/**
 * Mark form field as auto-filled with visual indicator
 * @param {HTMLElement} field - Input field element
 */
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

/**
 * Calculate area of a polygon in square meters
 * @param {Array} coordinates - Array of [lng, lat] coordinates
 * @returns {number} Area in square meters
 */
function calculatePolygonArea(coordinates) {
  if (!coordinates || !coordinates[0] || coordinates[0].length < 3) {
    return 0;
  }
  
  // Use Leaflet's built-in geodesic area calculation
  const latlngs = coordinates[0].map(coord => L.latLng(coord[1], coord[0]));
  return L.GeometryUtil.geodesicArea(latlngs);
}

/**
 * Generate a unique ID for annotations
 * @returns {string} Unique ID
 */
function generateUniqueId() {
  return 'ann_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

/**
 * Validate annotation data
 * @param {Object} data - Annotation data object
 * @returns {Object} Validation result with {valid: boolean, errors: Array}
 */
function validateAnnotationData(data) {
  const errors = [];
  
  if (!data.species_code) {
    errors.push('Species code is required');
  }
  
  if (!data.geometry || !data.geometry.coordinates) {
    errors.push('Geometry is required');
  }
  
  if (!data.shape || !['Line', 'Polygon'].includes(data.shape)) {
    errors.push('Invalid shape type');
  }
  
  return {
    valid: errors.length === 0,
    errors: errors
  };
}

/**
 * Deep clone an object
 * @param {Object} obj - Object to clone
 * @returns {Object} Cloned object
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Debounce function to limit rate of function calls
 * @param {Function} func - Function to debounce
 * @param {number} wait - Milliseconds to wait
 * @returns {Function} Debounced function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Format number with commas
 * @param {number} num - Number to format
 * @returns {string} Formatted number string
 */
function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Download data as JSON file
 * @param {Object} data - Data to download
 * @param {string} filename - Name of file to download
 */
function downloadJSON(data, filename) {
  const dataStr = JSON.stringify(data, null, 2);
  const dataBlob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(dataBlob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Convert hex color to RGBA
 * @param {string} hex - Hex color string
 * @param {number} alpha - Alpha value (0-1)
 * @returns {string} RGBA color string
 */
function hexToRGBA(hex, alpha = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Toggle panel collapse/expand
 * @param {string} panelId - ID of panel to toggle
 */
function togglePanel(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  
  const header = panel.querySelector('.panel-header');
  const content = panel.querySelector('.panel-content');
  
  if (header) header.classList.toggle('collapsed');
  if (content) content.classList.toggle('collapsed');
  panel.classList.toggle('collapsed');
}

/**
 * Toggle section collapse/expand (within a panel)
 * @param {string} sectionId - ID of section to toggle
 */
function toggleSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (section) {
    section.classList.toggle('collapsed');
  }
}

/**
 * Toggle individual layer details collapse/expand
 * @param {string} detailsId - ID of layer details to toggle
 */
function toggleLayerDetails(detailsId) {
  const details = document.getElementById(detailsId);
  const icon = document.getElementById(detailsId + 'Icon');
  
  if (!details) return;
  
  details.classList.toggle('collapsed');
  
  // Rotate icon
  if (icon) {
    if (details.classList.contains('collapsed')) {
      icon.textContent = '▶';
    } else {
      icon.textContent = '▼';
    }
  }
}

/**
 * Toggle annotation section collapse/expand
 * @param {string} sectionId - ID of annotation section to toggle
 */
function toggleAnnotationSection(sectionId) {
  const content = document.getElementById(sectionId + 'Content');
  const icon = document.getElementById(sectionId + 'Icon');
  
  if (!content) return;
  
  content.classList.toggle('collapsed');
  
  // Rotate icon
  if (icon) {
    if (content.classList.contains('collapsed')) {
      icon.textContent = '▶';
    } else {
      icon.textContent = '▼';
    }
  }
}

/**
 * Toggle annotations layer visibility
 */
function toggleAnnotationsLayer() {
  const checkbox = document.getElementById('toggleAnnotations');
  if (!checkbox || !drawnItems) return;
  
  if (checkbox.checked) {
    if (!map.hasLayer(drawnItems)) {
      map.addLayer(drawnItems);
    }
  } else {
    if (map.hasLayer(drawnItems)) {
      map.removeLayer(drawnItems);
    }
  }
}

/**
 * Set annotations opacity
 * @param {number} value - Opacity value (0-100)
 */
function setAnnotationsOpacity(value) {
  const valueDisplay = document.getElementById('annotationsOpacityValue');
  if (valueDisplay) {
    valueDisplay.textContent = value;
  }
  
  if (drawnItems) {
    const opacity = value / 100;
    drawnItems.eachLayer(layer => {
      if (layer.setStyle) {
        layer.setStyle({ opacity: opacity, fillOpacity: opacity * 0.3 });
      }
    });
  }
}

/**
 * Set annotation line width
 * @param {number} value - Line width in pixels
 */
function setLineWidth(value) {
  const valueDisplay = document.getElementById('lineWidthValue');
  if (valueDisplay) {
    valueDisplay.textContent = value;
  }
  
  if (drawnItems) {
    drawnItems.eachLayer(layer => {
      if (layer.setStyle) {
        layer.setStyle({ weight: parseInt(value) });
      }
    });
  }
}

/**
 * Toggle annotation labels visibility
 * @param {boolean} show - Whether to show labels
 */
function toggleAnnotationLabels(show) {
  if (!drawnItems) return;
  
  drawnItems.eachLayer(layer => {
    if (layer.getTooltip()) {
      if (show) {
        layer.openTooltip();
      } else {
        layer.closeTooltip();
      }
    }
  });
}

/**
 * Load selected COG from dropdown
 */
function loadSelectedCOG() {
  const select = document.getElementById('cogSelect');
  if (!select) return;
  
  const selectedValue = select.value;
  if (selectedValue && typeof loadTifLayer === 'function') {
    // This will be handled by the layers module
    console.log('Loading selected COG:', selectedValue);
  }
}

/**
 * Clear annotation form
 */
function clearForm() {
  const formFields = [
    'analyst', 'obs_year', 'mission_id', 'site', 'transect', 'segment',
    'seglength', 'segwidth', 'spcode', 'morph_code', 'no_colony',
    'juvenile', 'remnant', 'ex_bound', 'olddead',
    'rdcause1', 'rd_1', 'rdcause2', 'rd_2', 'rdcause3', 'rd_3',
    'con_1', 'extent_1', 'sev_1', 'con_2', 'extent_2', 'sev_2',
    'con_3', 'extent_3', 'sev_3'
  ];
  
  formFields.forEach(fieldId => {
    const field = document.getElementById(fieldId);
    if (field) {
      if (field.tagName === 'SELECT') {
        field.selectedIndex = 0;
      } else {
        field.value = '';
      }
    }
  });
  
  showStatus('Form cleared', 'info');
}

/**
 * Refresh annotations display
 */
async function refreshAnnotations() {
  try {
    if (typeof isOracleProjectMode === 'function' && isOracleProjectMode() && typeof refreshAnnotationsFromDb === 'function') {
      await refreshAnnotationsFromDb();
      showStatus('✅ Annotations refreshed from DB', 'success');
      return;
    }

    if (typeof updateAnnotationTable === 'function') {
      updateAnnotationTable();
      showStatus('✅ Annotations refreshed', 'success');
    }
  } catch (error) {
    console.error('Error refreshing annotations:', error);
    showStatus(`❌ Refresh failed: ${error.message}`, 'error');
  }
}

/**
 * Clear all annotations with confirmation
 */
async function clearAllAnnotations() {
  if (!await catConfirm('Are you sure you want to delete ALL annotations? This cannot be undone!', { danger: true, ok: 'Delete All' })) {
    return;
  }

  if (typeof isOracleProjectMode === 'function' && isOracleProjectMode()) {
    try {
      const project = typeof getCurrentProject === 'function' ? getCurrentProject() : null;
      const projectId = project?.project_id;
      if (!projectId) {
        throw new Error('Missing project_id for DB clear operation');
      }

      const response = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations/bulk-replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations: [] })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Failed to clear DB annotations');
      }
    } catch (error) {
      console.error('Error clearing DB annotations:', error);
      showStatus(`❌ Clear failed: ${error.message}`, 'error');
      return;
    }
  }
  
  if (drawnItems) {
    drawnItems.clearLayers();
  }
  
  if (typeof annotations !== 'undefined') {
    annotations = [];
  }
  
  if (typeof projectAnnotations !== 'undefined') {
    projectAnnotations = [];
  }
  
  if (typeof updateAnnotationTable === 'function') {
    updateAnnotationTable();
  }
  
  showStatus('✅ All annotations cleared', 'success');
}

/**
 * Export annotations to shapefile
 */
async function exportShapefile() {
  // Collect all annotations from drawnItems
  const drawnItems = getDrawnItems();
  const currentProject = getCurrentProject();
  const serverUrl = window.location.origin;
  
  if (!drawnItems) {
    showStatus('❌ No map layers found', 'error');
    return;
  }
  
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

/**
 * Show annotation popup on map click
 * @param {Object} layer - Leaflet layer
 * @param {Object} latlng - Click location
 */
function showAnnotationPopup(layer, latlng) {
  if (!layer.annotationData) return;
  
  const data = layer.annotationData;
  const projectAnnotations = getProjectAnnotations();
  
  // Find the annotation index using _displayIndex (more reliable than object reference)
  let annotationIndex = -1;
  if (data._displayIndex) {
    annotationIndex = data._displayIndex - 1; // Convert from 1-based to 0-based
  } else {
    // Fallback to object reference for new annotations
    for (let i = 0; i < projectAnnotations.length; i++) {
      if (projectAnnotations[i] === data) {
        annotationIndex = i;
        break;
      }
    }
  }
  
  // Build popup content with all available fields
  let popupContent = '<div style="min-width: 250px;">';
  popupContent += '<h4 style="margin: 0 0 8px 0; padding-bottom: 5px; border-bottom: 2px solid #3388ff;">Annotation Details</h4>';
  
  // Show key fields first
  const keyFields = ['spcode', 'species_code', 'SPCODE', 'SPECIES_CODE', 'species'];
  const idFields = ['colony_id', 'COLONY_ID', 'id', 'ID'];
  const sizeFields = ['size_cm', 'SIZE_CM', 'diameter', 'DIAMETER'];
  
  // Species
  const speciesValue = keyFields.map(f => data[f]).find(v => v);
  if (speciesValue) {
    popupContent += `<div style="margin: 4px 0;"><strong>Species:</strong> ${speciesValue}</div>`;
  }
  
  // ID - use display index as fallback for consistency
  const idValue = idFields.map(f => data[f]).find(v => v) || data._displayIndex || layer._leaflet_id;
  popupContent += `<div style="margin: 4px 0;"><strong>ID:</strong> ${idValue}</div>`;
  
  // Size
  const sizeValue = sizeFields.map(f => data[f]).find(v => v);
  if (sizeValue) {
    popupContent += `<div style="margin: 4px 0;"><strong>Size:</strong> ${sizeValue} cm</div>`;
  }
  
  // Add other fields (excluding geometry and already shown fields)
  const excludeFields = ['geometry', ...keyFields, ...idFields, ...sizeFields];
  const otherFields = Object.keys(data).filter(key => 
    !excludeFields.includes(key) && 
    data[key] !== null && 
    data[key] !== undefined &&
    data[key] !== ''
  );
  
  if (otherFields.length > 0) {
    popupContent += '<div style="margin-top: 8px; padding-top: 5px; border-top: 1px solid #ddd;">';
    otherFields.forEach(key => {
      const value = data[key];
      // Format the key (remove underscores, capitalize)
      const displayKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      popupContent += `<div style="margin: 2px 0; font-size: 0.9em;"><strong>${displayKey}:</strong> ${value}</div>`;
    });
    popupContent += '</div>';
  }
  
  // Add action buttons if we found the annotation index
  if (annotationIndex >= 0) {
    popupContent += `
      <div style="margin-top: 12px; padding-top: 8px; border-top: 2px solid #ddd; display: flex; gap: 6px; justify-content: center;">
        <button onclick="map.closePopup(); openEditModal(${annotationIndex})" 
                style="padding: 6px 12px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;"
                onmouseover="this.style.background='#1565c0'" 
                onmouseout="this.style.background='#1976d2'"
                title="Edit Fields">
          ✏️ Edit
        </button>
        <button onclick="map.closePopup(); enableGeometryEdit(${annotationIndex})" 
                style="padding: 6px 12px; background: #388e3c; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;"
                onmouseover="this.style.background='#2e7d32'" 
                onmouseout="this.style.background='#388e3c'"
                title="Edit Geometry">
          📐 Shape
        </button>
        <button onclick="catConfirm('Delete this annotation?',{danger:true,ok:'Delete'}).then(ok=>{if(ok){map.closePopup();deleteAnnotation(${annotationIndex})}})" 
                style="padding: 6px 12px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;"
                onmouseover="this.style.background='#c62828'" 
                onmouseout="this.style.background='#d32f2f'"
                title="Delete">
          🗑️ Delete
        </button>
      </div>
    `;
  }
  
  popupContent += '</div>';
  
  // Create and show popup
  L.popup({
    maxWidth: 300,
    closeButton: true
  })
    .setLatLng(latlng)
    .setContent(popupContent)
    .openOn(map);
}

// Make function globally accessible
window.showAnnotationPopup = showAnnotationPopup;

/**
 * Toggle annotation labels on/off
 * @param {boolean} enabled - Whether to show labels
 */
function toggleAnnotationLabels(enabled) {
  labelsVisible = enabled;
  
  if (enabled) {
    showAllAnnotationLabels();
  } else {
    hideAllAnnotationLabels();
  }
}

/**
 * Show labels for all annotations
 */
function showAllAnnotationLabels() {
  const drawnItems = getDrawnItems();
  if (!drawnItems) return;
  
  drawnItems.eachLayer(function(layer) {
    if (layer.annotationData) {
      addLabelToAnnotation(layer);
    }
  });
}

/**
 * Hide all annotation labels
 */
function hideAllAnnotationLabels() {
  annotationLabels.forEach((labelMarker, annotationId) => {
    if (map.hasLayer(labelMarker)) {
      map.removeLayer(labelMarker);
    }
  });
  annotationLabels.clear();
}

/**
 * Add label to a specific annotation
 * @param {Object} layer - Leaflet layer
 */
function addLabelToAnnotation(layer) {
  if (!layer.annotationData) return;
  
  const annotationId = layer._leaflet_id;
  
  // Try multiple field name variations for species code
  const spcode = layer.annotationData.spcode || 
               layer.annotationData.species_code || 
               layer.annotationData.species || 
               layer.annotationData.SPCODE ||
               layer.annotationData.SPECIES_CODE ||
               'Unknown';
               
  // Try multiple field name variations for colony ID
  // NOTE: no_colony is a boolean field (-1/0), NOT an ID — do not include it here
  const colonyId = layer.annotationData.colony_id || 
                 layer.annotationData.COLONY_ID ||
                 layer.annotationData.id ||
                 layer.annotationData.ID ||
                 layer.annotationData._displayIndex ||
                 (typeof annotations !== 'undefined' && annotations ? annotations.indexOf(layer.annotationData) + 1 || annotationId : annotationId);
  
  // Calculate center point
  let center;
  if (layer.getBounds) {
    center = layer.getBounds().getCenter();
  } else if (layer.getLatLng) {
    center = layer.getLatLng();
  } else {
    return;
  }
  
  // Create label with species code and ID
  const labelText = `${spcode} #${colonyId}`;
  
  // Remove existing label if present
  if (annotationLabels.has(annotationId)) {
    const oldLabel = annotationLabels.get(annotationId);
    if (map.hasLayer(oldLabel)) {
      map.removeLayer(oldLabel);
    }
  }
  
  // Color label background by species
  const _lblColor = (typeof catSpeciesColor === 'function') ? catSpeciesColor(spcode) : '#667eea';

  // Create new label marker
  const labelMarker = L.marker(center, {
    icon: L.divIcon({
      className: 'annotation-label',
      html: `<div style="
        background: ${_lblColor};
        color: #fff;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 11px;
        font-weight: bold;
        white-space: nowrap;
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        pointer-events: none;
        text-shadow: 0 1px 2px rgba(0,0,0,0.4);
      ">${labelText}</div>`,
      iconSize: null,
      iconAnchor: [0, 0]
    }),
    interactive: false,
    pane: 'annotationsPane'
  });
  
  labelMarker.addTo(map);
  annotationLabels.set(annotationId, labelMarker);
}

/**
 * Update label for a specific annotation
 * @param {number} annotationId - Annotation ID
 */
function updateAnnotationLabel(annotationId) {
  if (!labelsVisible) return;
  
  const drawnItems = getDrawnItems();
  if (!drawnItems) return;
  
  drawnItems.eachLayer(function(layer) {
    if (layer._leaflet_id === annotationId || 
        (layer.annotationData && layer.annotationData.id === annotationId)) {
      addLabelToAnnotation(layer);
    }
  });
}

// Make functions globally accessible
window.toggleAnnotationLabels = toggleAnnotationLabels;
window.showAllAnnotationLabels = showAllAnnotationLabels;
window.hideAllAnnotationLabels = hideAllAnnotationLabels;
window.addLabelToAnnotation = addLabelToAnnotation;
window.updateAnnotationLabel = updateAnnotationLabel;

// Export functions for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    showStatus,
    showLoading,
    formatTime,
    formatTotalTime,
    getFullPrecisionGeometry,
    markFieldAsAutofilled,
    calculatePolygonArea,
    generateUniqueId,
    validateAnnotationData,
    deepClone,
    debounce,
    formatNumber,
    downloadJSON,
    hexToRGBA
  };
}

/* ================================================
   CAT - Coral Annotation Tool
   Drawing Event Handlers
   ================================================ */

// Note: Global variables (currentAnnotation, lastDrawingTool) are declared in annotation-main.js

/**
 * Setup all drawing event handlers
 * @param {L.Map} map - Leaflet map instance
 */
function setupDrawingHandlers(map) {
  if (!map) {
    console.error('Cannot setup drawing handlers: map not provided');
    return;
  }
  
  // Handle draw created
  map.on(L.Draw.Event.CREATED, handleDrawCreated);
  
  // Handle draw edited
  map.on(L.Draw.Event.EDITED, handleDrawEdited);
  
  // Handle draw deleted
  map.on(L.Draw.Event.DELETED, handleDrawDeleted);
  
  // Escape key: discard in-progress unsaved annotation and clear form (Fix 2c)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!currentAnnotation || !currentAnnotation.layer || currentAnnotation.layer.annotationData) return;
    // Only act if no modal or dropdown is open
    if (document.getElementById('editModal')?.classList.contains('active')) return;
    if (document.querySelector('.species-autocomplete-dropdown[style*="block"]')) return;
    drawnItems.removeLayer(currentAnnotation.layer);
    currentAnnotation = null;
    if (typeof clearAnnotationForm === 'function') clearAnnotationForm();
    if (typeof showStatus === 'function') showStatus('Annotation discarded', 'info');
  });

  console.log('✅ Drawing event handlers registered');
}

/**
 * Handle draw created event
 * @param {Object} event - Leaflet draw event
 */
async function handleDrawCreated(event) {
  const layer = event.layer;
  const type = event.layerType;
  const drawnItems = getDrawnItems();
  
  console.log(`🎨 Draw event: type=${type}`);
  
  // Set layer to use annotations pane for proper z-index
  if (layer.options) {
    layer.options.pane = 'annotationsPane';
  }
  
  // Check for SAM3 modes (if magic wand active)
  const isSAM3Active = window.magicWandActive || false;
  const sam3Mode = window.sam3Mode || 'point';
  const currentCOG = getCurrentCOG();
  
  // Handle SAM3 Smart Grid mode
  if (type === 'rectangle' && isSAM3Active && sam3Mode === 'grid' && currentCOG) {
    console.log('🎯 SAM3 Smart Grid triggered');
    if (typeof window.runSAM3SmartGrid === 'function') {
      await window.runSAM3SmartGrid(layer);
    } else {
      console.error('SAM3 Smart Grid function not available');
    }
    return;
  }
  
  // Handle SAM3 Box mode
  if (type === 'rectangle' && isSAM3Active && sam3Mode === 'box' && currentCOG) {
    console.log('📦 SAM3 Box segmentation triggered');
    const success = await handleSAM3BoxSegmentation(layer);
    if (success) return; // SAM3 handled it
    // Otherwise fall through to normal drawing
  }
  
  // Normal drawing flow
  handleNormalDrawing(layer, type, drawnItems);
}

/**
 * Handle normal (non-SAM3) drawing
 * @param {L.Layer} layer - Leaflet layer
 * @param {string} type - Layer type
 * @param {L.FeatureGroup} drawnItems - Feature group containing drawings
 */
function handleNormalDrawing(layer, type, drawnItems) {
  // Guard: if there's an in-progress unsaved annotation with form data, confirm before discarding (Fix 2c)
  if (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData) {
    const formHasContent = ['spcode', 'morph_code', 'transect', 'segment'].some(id => {
      const el = document.getElementById(id);
      return el && el.value && el.value.trim() !== '' && el.value !== '-';
    });

    if (formHasContent) {
      const discard = confirm('You have an annotation in progress with unsaved data.\n\nDiscard it and start a new one?');
      if (!discard) {
        // User chose to keep working — remove the just-drawn layer and abort
        drawnItems.removeLayer(layer);
        return;
      }
    }

    // Discard the previous unsaved shape
    console.log('🧹 Removing previous unsaved annotation');
    drawnItems.removeLayer(currentAnnotation.layer);
  }

  drawnItems.addLayer(layer);
  
  // Store current drawing with full precision geometry
  currentAnnotation = {
    type: type,
    layer: layer,
    geometry: getFullPrecisionGeometry(layer),
    replacedUnsaved: (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData)
  };
  
  // Auto-start/resume timer
  autoStartTimer();
  
  // Calculate shape measurements
  calculateShapeMeasurements(layer, type);
  
  // Show status message
  if (currentAnnotation.replacedUnsaved) {
    showStatus('⚠️ Previous unsaved annotation was replaced! Fill out the form and click Save.', 'warning');
  } else {
    showStatus('Draw created! Fill out the form and click Save.', 'info');
  }
  
  // Auto-focus on species field
  autoFocusSpeciesField();
  
  // Log debug info
  logDrawingDebugInfo(layer, type);
}

/**
 * Handle SAM3 box segmentation
 * @param {L.Layer} layer - Rectangle layer
 * @returns {Promise<boolean>} True if successful
 */
async function handleSAM3BoxSegmentation(layer) {
  // This is a placeholder - actual SAM3 implementation is in annotation-sam3.js
  if (typeof window.handleSAM3Box === 'function') {
    return await window.handleSAM3Box(layer);
  }
  return false;
}

/**
 * Auto-start or resume timer on drawing
 */
function autoStartTimer() {
  const timerState = getTimerState();
  
  if (!timerState.isRunning) {
    console.log('🎬 First annotation drawn - starting timer');
    startTimer();
  } else if (timerState.isPaused) {
    console.log('▶️ Annotation drawn - resuming timer');
    startTimer();
  }
}

/**
 * Calculate shape measurements and update form fields
 * @param {L.Layer} layer - Leaflet layer
 * @param {string} type - Layer type
 */
function calculateShapeMeasurements(layer, type) {
  const segLengthField = document.getElementById('seglength');
  const segWidthField = document.getElementById('segwidth');
  
  if (type === 'polyline') {
    const coords = layer.getLatLngs();
    let length = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      length += coords[i].distanceTo(coords[i + 1]);
    }
    if (segLengthField) {
      segLengthField.value = length.toFixed(3);
    }
  } else if (type === 'rectangle' || type === 'polygon') {
    const bounds = layer.getBounds();
    const width = bounds.getNorthEast().distanceTo(bounds.getNorthWest());
    const height = bounds.getNorthEast().distanceTo(bounds.getSouthEast());
    
    if (segLengthField) {
      segLengthField.value = Math.max(width, height).toFixed(3);
    }
    if (segWidthField) {
      segWidthField.value = Math.min(width, height).toFixed(3);
    }
  }
}

/**
 * Auto-focus on species field after drawing
 */
function autoFocusSpeciesField() {
  const speciesField = document.getElementById('spcode');
  if (speciesField) {
    setTimeout(() => {
      speciesField.focus();
      console.log('✅ Auto-focused on species field');
    }, 100);
  }
}

/**
 * Log drawing debug information
 * @param {L.Layer} layer - Leaflet layer
 * @param {string} type - Layer type
 */
function logDrawingDebugInfo(layer, type) {
  const bounds = layer.getBounds ? layer.getBounds() : null;
  const center = bounds ? bounds.getCenter() : (layer.getLatLng ? layer.getLatLng() : null);
  
  console.log('🖊️ Drew annotation:', {
    type: type,
    geometry: currentAnnotation.geometry,
    coordinates: currentAnnotation.geometry.coordinates,
    visualCenter: center,
    visualBounds: bounds,
    layerType: layer.constructor.name
  });
}

/**
 * Handle draw edited event
 * @param {Object} event - Leaflet draw event
 */
function handleDrawEdited(event) {
  const layers = event.layers;
  
  layers.eachLayer(function (layer) {
    // Update geometry with full precision
    if (layer.annotationData) {
      const updatedGeometry = getFullPrecisionGeometry(layer);
      layer.annotationData.geometry = updatedGeometry;
      
      // Mark as having unsaved changes
      markUnsavedChanges();
      
      console.log('✏️ Annotation edited:', layer.annotationData);
      showStatus('Annotation geometry updated. Save to persist changes.', 'info');
    }
  });
}

/**
 * Handle draw deleted event
 * @param {Object} event - Leaflet draw event
 */
function handleDrawDeleted(event) {
  const layers = event.layers;
  const projectAnnotations = getProjectAnnotations();
  
  layers.eachLayer(function (layer) {
    if (layer.annotationData) {
      // Find annotation index
      const index = projectAnnotations.findIndex(ann => 
        ann._displayIndex === layer.annotationData._displayIndex
      );
      
      if (index !== -1) {
        removeAnnotationFromProject(index);
        console.log('🗑️ Annotation deleted:', layer.annotationData);
      }
      
      // Update annotation table if exists
      if (typeof window.updateAnnotationTable === 'function') {
        window.updateAnnotationTable();
      }
    }
  });
  
  markUnsavedChanges();
  showStatus('Annotation(s) deleted', 'info');
}

/**
 * Clear current unsaved annotation
 */
function clearCurrentAnnotation() {
  const drawnItems = getDrawnItems();
  
  if (currentAnnotation && currentAnnotation.layer && !currentAnnotation.layer.annotationData) {
    console.log('🧹 Clearing unsaved annotation');
    drawnItems.removeLayer(currentAnnotation.layer);
    currentAnnotation = null;
  }
}

/**
 * Get current annotation
 * @returns {Object|null} Current annotation object
 */
function getCurrentAnnotation() {
  return currentAnnotation;
}

/**
 * Set current annotation (used after saving)
 * @param {Object|null} annotation - Annotation object or null
 */
function setCurrentAnnotation(annotation) {
  currentAnnotation = annotation;
}

/**
 * Get last drawing tool used
 * @returns {string|null} Last tool type
 */
function getLastDrawingTool() {
  return lastDrawingTool;
}

/**
 * Set last drawing tool
 * @param {string} tool - Tool type
 */
function setLastDrawingTool(tool) {
  lastDrawingTool = tool;
  console.log('🔧 Last drawing tool set to:', tool);
}

/**
 * Update drawing tool visual feedback
 * @param {string} tool - Active tool ('polyline', 'polygon', 'rectangle', etc.)
 */
function updateDrawingToolVisualFeedback(tool) {
  // Update cursor or other visual feedback
  const mapContainer = document.getElementById('map');
  if (!mapContainer) return;
  
  // Remove all tool classes
  mapContainer.classList.remove('tool-polyline', 'tool-polygon', 'tool-rectangle');
  
  // Add current tool class
  if (tool) {
    mapContainer.classList.add(`tool-${tool}`);
    console.log('🎨 Visual feedback for tool:', tool);
  }
}

/**
 * Enable last used drawing tool
 */
function enableLastDrawingTool() {
  if (lastDrawingTool) {
    console.log('🔄 Re-enabling last drawing tool:', lastDrawingTool);
    
    const map = getMap();
    if (!map) return;
    
    // Trigger appropriate drawing tool
    // This would integrate with Leaflet Draw controls
    updateDrawingToolVisualFeedback(lastDrawingTool);
  }
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    setupDrawingHandlers,
    handleDrawCreated,
    handleDrawEdited,
    handleDrawDeleted,
    clearCurrentAnnotation,
    getCurrentAnnotation,
    setCurrentAnnotation,
    getLastDrawingTool,
    setLastDrawingTool,
    updateDrawingToolVisualFeedback,
    enableLastDrawingTool
  };
}

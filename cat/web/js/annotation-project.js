/* ================================================
   CAT - Coral Annotation Tool
   Project Management (Load, Save, Export)
   ================================================ */

// Note: Global variables (currentProject, projectAnnotations, hasUnsavedChanges, lastSaveTime) 
// are declared in annotation-main.js

function isOracleProjectMode() {
  return typeof getStorageBackend === 'function' && getStorageBackend() === 'oracle' && !!currentProject?.project_id;
}

function getDbAnnotationId(annotation) {
  return annotation?._dbAnnotationId || annotation?.annotation_id || annotation?.id || null;
}

function normalizeAnnotationForDb(annotation) {
  const ann = annotation || {};
  const rawGeometry = ann.geometry || ann.feature?.geometry || ann.feature || null;
  const feature = rawGeometry && rawGeometry.type === 'Feature'
    ? rawGeometry
    : {
        type: 'Feature',
        geometry: rawGeometry,
        properties: {}
      };

  const properties = ann.properties
    ? { ...ann.properties }
    : Object.fromEntries(Object.entries(ann).filter(([k]) => !['geometry', 'feature', '_displayIndex', 'id', '_dbAnnotationId', '_localId', '_syncStatus', '_dbAnnotationVersion'].includes(k)));

  return {
    feature,
    properties,
    created_by: (properties.ANALYST || properties.analyst || document.getElementById('analyst')?.value || null)
  };
}

function normalizeDbAnnotationResponse(annotationRow) {
  const feature = annotationRow?.feature;
  const properties = annotationRow?.properties || {};
  const geometry = feature?.geometry || annotationRow?.geometry || null;

  return {
    ...properties,
    properties,
    geometry,
    id: annotationRow?.annotation_id,
    _dbAnnotationId: annotationRow?.annotation_id,
    _dbAnnotationVersion: annotationRow?.version ?? 1,
    _syncStatus: 'synced' // loaded from DB — already in sync
  };
}

function transformDbSnapshotToProject(snapshot) {
  const project = snapshot.project || {};
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];

  const tifFiles = assets.map((asset) => ({
    id: asset.asset_id,
    name: asset.asset_name,
    type: asset.asset_type || 'COG',
    cog_path: asset.cog_url,
    source_epsg: asset.source_epsg,
    target_epsg: asset.target_epsg,
    bounds: asset.bounds
  }));

  return {
    ...project,
    project_id: project.project_id,
    project_name: project.project_name,
    site: project.site,
    cruise: project.cruise,
    year: project.year,
    metadata: project.metadata || {},
    tif_files: tifFiles,
    shapefiles: []
  };
}

/**
 * Load project from pre-processed data (localStorage or API response)
 * @param {Object} result - Pre-processed project data with project and annotations
 */
async function loadProjectData(result) {
  try {
    showProjectLoadingProgress('initializing');
    
    currentProject = result.project;
    projectAnnotations = result.annotations || [];
    
    // Update UI
    updateProjectUI();
    
    // Initialize form with project data
    initializeAnnotationForm();
    
    // Load layers
    await loadProjectLayers();
    
    // Load shapefiles
    if (currentProject.shapefiles && currentProject.shapefiles.length > 0) {
      await loadProjectShapefiles();
    }
    
    // Load existing annotations
    loadProjectAnnotations();
    
    // Start timer
    startTimer();
    
    // Show completion
    showProjectLoadingProgress('complete');
    
    console.log('✅ Project loaded:', currentProject.project_name);
    showStatus(`✅ Project "${currentProject.project_name}" loaded successfully`, 'success');
    
  } catch (error) {
    console.error('Error loading project:', error);
    hideLoadingOverlay();
    showStatus(`❌ Error loading project: ${error.message}`, 'error');
  }
}

/**
 * Load project from Oracle DB snapshot endpoint
 * @param {number|string} projectId - DB project id
 */
async function loadProjectFromDatabase(projectId) {
  const numericId = Number(projectId);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    throw new Error('Invalid database project_id');
  }

  showProjectLoadingProgress('initializing');

  // Phase 1: Fast load — project metadata, layers, assets (no annotations yet)
  const response = await fetch(`${window.location.origin}/api/db/projects/${numericId}/snapshot?include_annotations=false`);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.detail || `Failed to load DB project ${numericId}`);
  }

  const snapshot = await response.json();
  const annotationCount = snapshot.counts?.annotations ?? 0;

  const transformed = {
    project: transformDbSnapshotToProject(snapshot),
    annotations: []
  };

  await loadProjectData(transformed);

  // Phase 2: Load annotations separately with a progress indicator
  if (annotationCount > 0) {
    showProjectLoadingProgress('annotations', annotationCount);
    try {
      const annResp = await fetch(`${window.location.origin}/api/db/projects/${numericId}/annotations`);
      if (annResp.ok) {
        const annData = await annResp.json();
        projectAnnotations = (annData.annotations || []).map(normalizeDbAnnotationResponse);
        loadProjectAnnotations();
      }
    } catch (annErr) {
      console.warn('Failed to load annotations from DB:', annErr);
      showStatus('⚠️ Project loaded but annotations could not be fetched', 'error');
    }
    hideLoadingOverlay();
  }

  // Initialize overlay layer controls for DB mode
  if (typeof initializeOverlayControls === 'function') {
    initializeOverlayControls(numericId);
  }

  // Start DB session (best-effort)
  try {
    const analyst = document.getElementById('analyst')?.value || 'unknown';
    const sessionResp = await fetch(`${window.location.origin}/api/db/projects/${numericId}/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: analyst })
    });
    if (sessionResp.ok) {
      const sessionData = await sessionResp.json();
      const sessionId = sessionData.session?.session_id || null;
      if (typeof setCurrentDbSessionId === 'function') {
        setCurrentDbSessionId(sessionId);
      }
      // Heartbeat every 5 minutes to keep session alive
      if (sessionId) {
        _startSessionHeartbeat(numericId, sessionId);
      }
    }
  } catch (sessionErr) {
    console.warn('Could not start DB annotation session:', sessionErr);
  }
}

let _sessionHeartbeatIntervalId = null;

function _startSessionHeartbeat(projectId, sessionId) {
  if (_sessionHeartbeatIntervalId) clearInterval(_sessionHeartbeatIntervalId);
  _sessionHeartbeatIntervalId = setInterval(async () => {
    try {
      await fetch(`${window.location.origin}/api/db/projects/${projectId}/sessions/${sessionId}/heartbeat`, {
        method: 'POST'
      });
    } catch (err) {
      console.warn('Session heartbeat failed:', err);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

async function syncAnnotationToDb(annotation, assetId = null) {
  if (!isOracleProjectMode()) return annotation;

  const projectId = currentProject.project_id;
  const annotationId = getDbAnnotationId(annotation);
  const payload = normalizeAnnotationForDb(annotation);

  if (assetId) {
    payload.asset_id = assetId;
  }

  if (annotationId) {
    const putBody = {
      feature: payload.feature,
      properties: payload.properties,
      created_by: payload.created_by
    };
    if (annotation._dbAnnotationVersion != null) {
      putBody.version = annotation._dbAnnotationVersion;
    }

    const putResp = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations/${annotationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody)
    });

    if (putResp.status === 409) {
      const conflictData = await putResp.json().catch(() => ({}));
      const serverVersion = conflictData.current_annotation?.version ?? '?';
      // Return a conflict sentinel — callers should check _syncStatus
      const current = conflictData.current_annotation
        ? normalizeDbAnnotationResponse(conflictData.current_annotation)
        : null;
      const err = new Error(`Annotation #${annotationId} was modified by someone else (server version ${serverVersion}). Refresh to get the latest.`);
      err.isConflict = true;
      err.serverAnnotation = current;
      throw err;
    }

    if (!putResp.ok) {
      const errorData = await putResp.json().catch(() => ({}));
      throw new Error(errorData.detail || `Failed to update DB annotation #${annotationId}`);
    }

    const result = await putResp.json();
    return normalizeDbAnnotationResponse(result.annotation);
  }

  const postResp = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!postResp.ok) {
    const errorData = await postResp.json().catch(() => ({}));
    throw new Error(errorData.detail || 'Failed to create DB annotation');
  }

  const result = await postResp.json();
  return normalizeDbAnnotationResponse(result.annotation);
}

async function deleteAnnotationFromDb(annotation) {
  if (!isOracleProjectMode()) return;

  const annotationId = getDbAnnotationId(annotation);
  if (!annotationId) return;

  const projectId = currentProject.project_id;
  const response = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations/${annotationId}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to delete DB annotation #${annotationId}`);
  }
}

async function restoreAnnotationInDb(annotationId) {
  if (!isOracleProjectMode()) return;

  const projectId = currentProject.project_id;
  const response = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations/${annotationId}/restore`, {
    method: 'POST'
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to restore DB annotation #${annotationId}`);
  }

  const result = await response.json();
  return normalizeDbAnnotationResponse(result.annotation);
}

async function refreshAnnotationsFromDb() {
  if (!isOracleProjectMode()) return;

  const projectId = currentProject.project_id;
  const response = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations`);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || 'Failed to refresh annotations from DB');
  }

  const data = await response.json();
  projectAnnotations = (data.annotations || []).map(normalizeDbAnnotationResponse);
  loadProjectAnnotations();
}

/**
 * Load project from JSON file
 * @param {File} file - Project JSON file
 */
async function loadProjectFromFile(file) {
  try {
    const text = await file.text();
    const projectData = JSON.parse(text);
    
    // Upload to backend for processing
    const formData = new FormData();
    formData.append('file', file);
    
    // Show loading overlay
    showProjectLoadingProgress('parsing');
    
    const response = await fetch(`${window.location.origin}/api/file-projects/upload-project`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to load project');
    }
    
    const result = await response.json();
    
    // Use the common loading function
    await loadProjectData(result);
    
  } catch (error) {
    console.error('Error loading project:', error);
    hideLoadingOverlay();
    showStatus(`❌ Error loading project: ${error.message}`, 'error');
  }
}

/**
 * Show project loading progress
 * @param {string} stage - Loading stage: 'parsing', 'processing', 'initializing', 'complete'
 */
function showProjectLoadingProgress(stage, count) {
  const overlay = document.getElementById('loadingOverlay');
  const loadingSpinner = overlay?.querySelector('.loading-spinner p');

  if (!overlay) return;

  overlay.classList.add('active');

  const messages = {
    parsing: 'Parsing project file...',
    processing: 'Creating COG files (one-time process)...',
    initializing: 'Loading map layers...',
    annotations: count ? `Loading ${count} annotation${count !== 1 ? 's' : ''}…` : 'Loading annotations…',
    complete: 'Project loaded successfully!'
  };

  if (loadingSpinner) {
    loadingSpinner.textContent = messages[stage] || 'Loading...';
  }

  if (stage === 'complete') {
    setTimeout(() => {
      overlay.classList.remove('active');
    }, 1200);
  }
}

/**
 * Hide loading overlay
 */
function hideLoadingOverlay() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.remove('active');
  }
}

/**
 * Update UI after project load
 */
function updateProjectUI() {
  // Hide upload panel, show map controls
  const uploadPanel = document.getElementById('uploadPanel');
  const mapLayersPanel = document.getElementById('mapLayersPanel');
  const annotationPanel = document.getElementById('annotationFormPanel');
  
  if (uploadPanel) uploadPanel.style.display = 'none';
  if (mapLayersPanel) mapLayersPanel.style.display = 'block';
  if (annotationPanel) annotationPanel.style.display = 'block';
  
  // Update site badge
  const siteBadge = document.getElementById('mapLayersSiteBadge');
  if (siteBadge && currentProject) {
    siteBadge.textContent = currentProject.site || currentProject.project_name;
  }
}

/**
 * Initialize annotation form with project metadata
 */
function initializeAnnotationForm() {
  if (!currentProject) return;
  
  const fields = {
    analyst: currentProject.metadata?.observer,
    site: currentProject.site,
    obs_year: currentProject.year,
    mission_id: currentProject.cruise
  };
  
  Object.entries(fields).forEach(([fieldId, value]) => {
    const field = document.getElementById(fieldId);
    if (field && value) {
      field.value = value;
    }
  });
  
  console.log('✅ Annotation form initialized with project data');
}

/**
 * Load project layers (COG/TIF files)
 */
async function loadProjectLayers() {
  if (!currentProject || !currentProject.tif_files) return;
  
  console.log('📥 Loading project layers...');
  
  // Build the layer controls UI
  buildLayerControls(currentProject.tif_files);
  
  console.log('✅ Project layers loaded');
}

/**
 * Load project shapefiles
 */
async function loadProjectShapefiles() {
  if (!currentProject || !currentProject.shapefiles) return;
  
  console.log('📥 Loading project shapefiles...');
  
  // Build the shapefile controls UI (this will auto-load them)
  buildShapefileControls(currentProject.shapefiles);
  
  console.log('✅ Project shapefiles loaded');
}

/**
 * Load existing project annotations
 */
function loadProjectAnnotations() {
  const drawnItems = getDrawnItems();
  if (!drawnItems) return;
  
  // Clear existing annotations
  drawnItems.clearLayers();
  
  if (!projectAnnotations || projectAnnotations.length === 0) {
    console.log('No existing annotations to load');
    return;
  }
  
  console.log(`📥 Loading ${projectAnnotations.length} project annotations...`);
  
  projectAnnotations.forEach((ann, idx) => {
    // Normalize annotation format first so style can use spcode etc.
    let normalizedAnn = {...ann};
    if (ann.properties && typeof ann.properties === 'object') {
      normalizedAnn = {
        ...ann.properties,
        geometry: ann.geometry,
        properties: ann.properties,
        id: ann.id,
        _dbAnnotationId: ann._dbAnnotationId || ann.id
      };
    }
    normalizedAnn._displayIndex = idx + 1;
    // Mark annotations with a DB ID as already synced to prevent needless re-sync
    if (normalizedAnn._dbAnnotationId) {
      normalizedAnn._syncStatus = 'synced';
    }

    const layerStyle = typeof getAnnotationLayerStyle === 'function'
      ? getAnnotationLayerStyle(normalizedAnn)
      : { color: '#3388ff', weight: 7, opacity: 0.8, fillOpacity: 0.3 };

    const layer = L.geoJSON(ann.geometry, {
      pane: 'annotationsPane',
      style: layerStyle
    }).getLayers()[0];

    layer.annotationData = normalizedAnn;
    
    // Add click handler
    layer.on('click', function(e) {
      showAnnotationPopup(layer, e.latlng);
    });
    
    drawnItems.addLayer(layer);
  });
  
  console.log('✅ Loaded', projectAnnotations.length, 'annotations');
  
  // Update the annotation table after loading
  updateAnnotationTable();
  
  // Add labels to all annotations if enabled
  if (labelsVisible) {
    showAllAnnotationLabels();
  }
}

/**
 * Export project data to JSON file
 */
async function exportProjectData() {
  if (!currentProject) {
    showStatus('No project loaded', 'error');
    return;
  }
  
  try {
    if (isOracleProjectMode()) {
      const projectId = currentProject.project_id;
      const drawnItems = getDrawnItems();
      const annotationsToSave = [];

      if (drawnItems) {
        drawnItems.eachLayer((layer) => {
          if (layer.annotationData) {
            annotationsToSave.push(layer.annotationData);
          }
        });
      }

      const payload = {
        annotations: annotationsToSave.map(normalizeAnnotationForDb)
      };

      const response = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations/bulk-replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Failed to save annotations to database');
      }

      projectAnnotations = annotationsToSave;

      // Best-effort session update
      try {
        const sessionId = typeof getCurrentDbSessionId === 'function' ? getCurrentDbSessionId() : null;
        if (sessionId) {
          const timerState = typeof getTimerState === 'function' ? getTimerState() : null;
          await fetch(`${window.location.origin}/api/db/projects/${projectId}/sessions/${sessionId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              total_seconds: timerState?.totalSessionSeconds || 0,
              annotation_count: timerState?.annotationCount || annotationsToSave.length,
              is_active: true
            })
          });
        }
      } catch (sessionErr) {
        console.warn('Session update skipped:', sessionErr);
      }

      hasUnsavedChanges = false;
      lastSaveTime = new Date();
      showStatus(`✅ Saved ${annotationsToSave.length} annotations to Oracle project #${projectId}`, 'success');
      return;
    }

    // Update project with current annotations
    const exportData = {
      ...currentProject,
      annotations: projectAnnotations,
      exported_at: new Date().toISOString(),
      annotation_count: projectAnnotations.length
    };
    
    // Create filename with full timestamp (YYYY-MM-DD_HH-MM-SS)
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/T/, '_')           // Replace T with _
      .replace(/:/g, '-')          // Replace : with -
      .replace(/\..+/, '');        // Remove milliseconds and timezone
    const siteName = currentProject.site || 'project';
    const filename = `${siteName}_${timestamp}_annotations.json`;
    
    // Download JSON
    downloadJSON(exportData, filename);
    
    hasUnsavedChanges = false;
    lastSaveTime = new Date();
    
    showStatus(`✅ Project saved as ${filename}`, 'success');
    console.log('✅ Project exported:', filename);
    
  } catch (error) {
    console.error('Error exporting project:', error);
    showStatus(`❌ Error saving project: ${error.message}`, 'error');
  }
}

/**
 * Add annotation to project
 * @param {Object} annotationData - Annotation data object
 */
function addAnnotationToProject(annotationData) {
  projectAnnotations.push(annotationData);
  hasUnsavedChanges = true;
  console.log('Added annotation to project. Total:', projectAnnotations.length);
}

/**
 * Update annotation in project
 * @param {number} index - Annotation index
 * @param {Object} annotationData - Updated annotation data
 */
function updateAnnotationInProject(index, annotationData) {
  if (index >= 0 && index < projectAnnotations.length) {
    projectAnnotations[index] = annotationData;
    hasUnsavedChanges = true;
    console.log('Updated annotation at index:', index);
  }
}

/**
 * Remove annotation from project
 * @param {number} index - Annotation index
 */
function removeAnnotationFromProject(index) {
  if (index >= 0 && index < projectAnnotations.length) {
    projectAnnotations.splice(index, 1);
    hasUnsavedChanges = true;
    console.log('Removed annotation. Remaining:', projectAnnotations.length);
  }
}

/**
 * Get current project
 * @returns {Object|null} Current project data
 */
function getCurrentProject() {
  return currentProject;
}

/**
 * Get project annotations
 * @returns {Array} Project annotations array
 */
function getProjectAnnotations() {
  return projectAnnotations;
}

/**
 * Check if project has unsaved changes
 * @returns {boolean} True if there are unsaved changes
 */
function hasUnsaved() {
  return hasUnsavedChanges;
}

/**
 * Mark project as having unsaved changes
 */
function markUnsavedChanges() {
  hasUnsavedChanges = true;
  updateSaveIndicator();
}

/**
 * Update save indicator in UI
 */
function updateSaveIndicator() {
  const indicator = document.getElementById('saveIndicator');
  if (indicator) {
    if (hasUnsavedChanges) {
      indicator.textContent = '● Unsaved changes';
      indicator.style.color = '#ffc107';
    } else if (lastSaveTime) {
      indicator.textContent = `✓ Saved ${formatTimeSince(lastSaveTime)}`;
      indicator.style.color = '#28a745';
    }
  }
}

/**
 * Format time since last save
 * @param {Date} date - Last save date
 * @returns {string} Formatted string
 */
function formatTimeSince(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Zoom to site bounds
 */
function zoomToSite() {
  const bounds = getProjectBounds();
  const map = getMap();
  
  if (bounds && map) {
    map.fitBounds(bounds, { padding: [50, 50] });
    showStatus('Zoomed to site', 'info');
  } else {
    showStatus('No site bounds available', 'error');
  }
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    loadProjectFromFile,
    loadProjectFromDatabase,
    syncAnnotationToDb,
    deleteAnnotationFromDb,
    refreshAnnotationsFromDb,
    exportProjectData,
    initializeAnnotationForm,
    loadProjectLayers,
    loadProjectShapefiles,
    loadProjectAnnotations,
    addAnnotationToProject,
    updateAnnotationInProject,
    removeAnnotationFromProject,
    getCurrentProject,
    getProjectAnnotations,
    hasUnsaved,
    markUnsavedChanges,
    zoomToSite
  };
}

if (typeof window !== 'undefined') {
  window.isOracleProjectMode = isOracleProjectMode;
  window.syncAnnotationToDb = syncAnnotationToDb;
  window.deleteAnnotationFromDb = deleteAnnotationFromDb;
  window.restoreAnnotationInDb = restoreAnnotationInDb;
  window.refreshAnnotationsFromDb = refreshAnnotationsFromDb;
}

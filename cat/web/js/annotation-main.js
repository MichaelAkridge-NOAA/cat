/* ================================================
   CAT - Coral Annotation Tool
   Main Application Entry Point
   ================================================ */

// ===== GLOBAL CONFIGURATION =====
const serverUrl = window.location.origin;

// ===== GLOBAL STATE VARIABLES =====
let map = null;
let drawnItems = null;
let drawControl = null;
let currentProject = null;
let projectAnnotations = [];
let annotations = [];
let currentAnnotation = null;
let hasUnsavedChanges = false;
let lastSaveTime = null;
let lastDrawingTool = null;
let storageBackend = 'file';
let dbApiAvailable = false;
let currentDbSessionId = null;

// Layer management
let cogLayers = {};
let shapefileLayers = {};
let tifLayers = {};
let currentCOG = null;

// SAM3/Magic Wand state
let magicWandActive = false;
let sam3Mode = 'point';
let sam3ModelSize = 'large';

// Annotation labels
let annotationLabels = new Map();
let labelsVisible = true;

// Editing state
let currentEditingLayer = null;
let sam3ConfidenceThreshold = 0.5;

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', async function() {
  console.log('🚀 Initializing CAT Annotation Tool...');

  await initializeStorageBackend();
  
  // Initialize map first (this sets the global 'map' variable)
  map = initializeMap();
  
  // Now setup handlers that need the map instance
  if (map) {
    // Setup drawing event handlers
    setupDrawingHandlers(map);
    
    // Setup SAM3 handlers (disabled for now)
    // setupSAM3Handlers(map);
    
    // Initialize SAM3 magic wand tool (disabled for now)
    // setTimeout(() => initSAM3MagicWand(), 100);
  } else {
    console.error('Failed to initialize map!');
  }
  
  // Setup form handlers (doesn't require map)
  setupFormHandlers();
  
  // Set up global event listeners
  setupEventListeners();
  
  // Initialize annotation form
  initializeAnnotationForm();
  
  // Check for project file in URL or prompt user
  promptProjectLoad();
  
  console.log('✅ CAT Annotation Tool initialized');
});

/**
 * Setup global event listeners
 */
function setupEventListeners() {
  // File upload handler for header button
  const projectFileInput = document.getElementById('projectFileInput');
  if (projectFileInput) {
    projectFileInput.addEventListener('change', handleProjectFileUpload);
  }
  
  // File upload handler for panel
  const panelProjectFileInput = document.getElementById('panelProjectFileInput');
  if (panelProjectFileInput) {
    panelProjectFileInput.addEventListener('change', handleProjectFileUpload);
  }
  
  // Setup drag and drop zone
  const dropZone = document.getElementById('dropZone');
  const panelInput = document.getElementById('panelProjectFileInput');
  
  if (dropZone && panelInput) {
    console.log('✅ Setting up drag and drop for project upload');
    
    // Click to browse
    dropZone.addEventListener('click', () => {
      panelInput.click();
    });
    
    // Prevent default drag behaviors on document
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });
    
    // Drag enter and over
    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => {
        dropZone.style.background = 'rgba(102, 126, 234, 0.15)';
        dropZone.style.borderColor = '#5568d3';
      }, false);
    });
    
    // Drag leave
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.background = 'rgba(102, 126, 234, 0.05)';
      dropZone.style.borderColor = '#667eea';
    }, false);
    
    // Drop
    dropZone.addEventListener('drop', (e) => {
      dropZone.style.background = 'rgba(102, 126, 234, 0.05)';
      dropZone.style.borderColor = '#667eea';
      
      const files = e.dataTransfer.files;
      console.log('📁 Files dropped:', files.length);
      
      if (files.length > 0) {
        const file = files[0];
        console.log('📄 File:', file.name, file.type);
        
        if (file.name.endsWith('.json')) {
          // Directly call the handler with the file
          const event = { target: { files: [file] } };
          handleProjectFileUpload(event);
        } else {
          alert('Please drop a JSON file');
        }
      }
    }, false);
  } else {
    console.warn('⚠️ Drop zone or panel input not found');
  }
  
  // Export button
  const exportBtn = document.getElementById('exportProject');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportProjectData);
  }
  
  // Timer badge click
  const timerBadge = document.getElementById('annotationTimer');
  if (timerBadge) {
    timerBadge.addEventListener('click', toggleTimer);
  }
  
  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboardShortcuts);
  
  // Warn before leaving with unsaved changes
  window.addEventListener('beforeunload', (e) => {
    // Save timer state to localStorage
    const timerState = getTimerState();
    if (timerState && timerState.sessionId) {
      localStorage.setItem('cat_timer_state', JSON.stringify({
        sessionId: timerState.sessionId,
        elapsedSeconds: timerState.elapsedSeconds,
        annotationCount: timerState.annotationCount,
        timestamp: Date.now()
      }));
    }
    
    // Show warning if project is loaded and there are unsaved changes
    if (currentProject && hasUnsavedChanges) {
      // Set returnValue to trigger browser warning
      e.preventDefault();
      e.returnValue = ''; // Chrome requires returnValue to be set
      
      // Modern browsers will show their own message, but we can provide a custom one
      const message = '⚠️ You have unsaved annotations!\n\nDid you save your project? Click "Save Project" to preserve your work.';
      return message; // Some browsers may display this
    }

    // Best-effort DB session close
    if (storageBackend === 'oracle' && currentProject?.project_id && currentDbSessionId) {
      try {
        const url = `${window.location.origin}/api/db/projects/${currentProject.project_id}/sessions/${currentDbSessionId}/end`;
        navigator.sendBeacon(url, new Blob([JSON.stringify({})], { type: 'application/json' }));
      } catch (sessionErr) {
        console.warn('Could not close DB session on unload:', sessionErr);
      }
    }
  });
}

/**
 * Initialize storage backend mode from server config
 */
async function initializeStorageBackend() {
  try {
    const response = await fetch(`${window.location.origin}/api/config`);
    if (!response.ok) return;
    const config = await response.json();
    storageBackend = config?.storage_backend || 'file';
    dbApiAvailable = !!config?.db_api_available;
    console.log(`🧭 Storage backend: ${storageBackend} (db_api_available=${dbApiAvailable})`);
  } catch (error) {
    console.warn('Could not determine storage backend, defaulting to file mode:', error);
  }
}

/**
 * Handle keyboard shortcuts
 */
function handleKeyboardShortcuts(e) {
  // Note: F key for Magic Wand is handled by SAM3 module
  
  // Escape - Cancel current operation
  if (e.key === 'Escape') {
    cancelCurrentOperation();
  }
  
  // Ctrl+Z / Cmd+Z — undo (5d)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
    // Only fire when no text input is focused
    const tag = document.activeElement?.tagName;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
      e.preventDefault();
      if (typeof undoLastAction === 'function') undoLastAction();
      return;
    }
  }

  // Ctrl+Y / Ctrl+Shift+Z / Cmd+Shift+Z — redo (5d)
  if (((e.ctrlKey || e.metaKey) && e.key === 'y') ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')) {
    const tag = document.activeElement?.tagName;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
      e.preventDefault();
      if (typeof redoLastAction === 'function') redoLastAction();
      return;
    }
  }

  // Ctrl+S or Cmd+S — context-aware save (Fix 3b)
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (document.getElementById('editModal')?.classList.contains('active')) {
      // Edit modal open → save the modal edit
      if (typeof saveEditedAnnotation === 'function') saveEditedAnnotation();
    } else if (getCurrentAnnotation()) {
      // Annotation in progress → save it
      saveAnnotation();
    } else {
      // Nothing active → manual project sync
      if (typeof runAutoSave === 'function') {
        markUnsavedChanges();
        runAutoSave();
      }
    }
  }
}

/**
 * Toggle timer pause/resume
 */
function toggleTimer() {
  if (timerState.isPaused) {
    startTimer();
  } else {
    pauseTimer();
  }
}

/**
 * Toggle Magic Wand mode
 */
function toggleMagicWand() {
  magicWandActive = !magicWandActive;
  const wandBtn = document.getElementById('magicWandBtn');
  
  if (wandBtn) {
    wandBtn.classList.toggle('active', magicWandActive);
  }
  
  if (magicWandActive) {
    showStatus('🪄 Magic Wand activated - Click points or draw rectangles', 'info');
  } else {
    showStatus('Magic Wand deactivated', 'info');
  }
}

/**
 * Cancel current operation
 */
function cancelCurrentOperation() {
  // Clear current annotation
  if (currentAnnotation && currentAnnotation.layer) {
    drawnItems.removeLayer(currentAnnotation.layer);
    currentAnnotation = null;
  }
  
  // Hide annotation form
  const formPanel = document.getElementById('annotationFormPanel');
  if (formPanel) {
    formPanel.style.display = 'none';
  }
  
  showStatus('Operation cancelled', 'info');
}

/**
 * Prompt user to load a project
 */
function promptProjectLoad() {
  // Check localStorage first (from project creator)
  const storedProject = localStorage.getItem('annotationProject');
  if (storedProject) {
    try {
      console.log('📦 Loading project from localStorage...');
      // Convert JSON string to File object for API processing (same as original)
      const projectBlob = new Blob([storedProject], { type: 'application/json' });
      const projectFile = new File([projectBlob], 'project.json', { type: 'application/json' });
      loadProjectFromFile(projectFile);
      localStorage.removeItem('annotationProject'); // Clean up after loading
      return;
    } catch (error) {
      console.error('Error loading project from localStorage:', error);
    }
  }
  
  // Check if project file is in URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  const dbProjectId = urlParams.get('project_id') || urlParams.get('db_project_id');
  const projectPath = urlParams.get('project');

  if (storageBackend === 'oracle' && dbProjectId && typeof loadProjectFromDatabase === 'function') {
    loadProjectFromDatabase(dbProjectId)
      .catch((error) => {
        console.error('Error loading DB project:', error);
        showStatus(`❌ Error loading DB project: ${error.message}`, 'error');
      });
    return;
  }
  
  if (projectPath) {
    // Try to load project from path
    loadProjectFromPath(projectPath);
  } else {
    // Show helpful message instead of auto-opening file dialog (blocked by browsers)
    showStatus('📂 Click "Load Project" to begin annotating', 'info');
  }
}

/**
 * Handle project file upload
 */
async function handleProjectFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  showLoading(true);
  try {
    await loadProjectFromFile(file);
    showStatus(`✅ Project "${file.name}" loaded successfully`, 'success');
  } catch (error) {
    console.error('Error loading project:', error);
    showStatus(`❌ Error loading project: ${error.message}`, 'error');
  } finally {
    showLoading(false);
  }
}

/**
 * Save current project
 */
async function saveProject() {
  if (!currentProject) {
    showStatus('No project loaded', 'error');
    return;
  }
  
  try {
    await exportProjectData();
    hasUnsavedChanges = false;
    lastSaveTime = new Date();
    showStatus('✅ Project saved successfully', 'success');
  } catch (error) {
    console.error('Error saving project:', error);
    showStatus(`❌ Error saving project: ${error.message}`, 'error');
  }
}

/**
 * Mark project as having unsaved changes
 */
function markUnsavedChanges() {
  hasUnsavedChanges = true;
  const saveIndicator = document.getElementById('saveIndicator');
  if (saveIndicator) {
    saveIndicator.textContent = '● Unsaved changes';
    saveIndicator.style.color = '#ffc107';
  }
}

/**
 * Check if project has unsaved changes
 * @returns {boolean}
 */
function hasUnsaved() {
  return hasUnsavedChanges;
}

// ===== MODULE EXPORTS =====
if (typeof window !== 'undefined') {
  window.CATApp = {
    map,
    drawnItems,
    currentProject,
    annotations,
    markUnsavedChanges,
    hasUnsaved,
    saveProject
  };
  
  // Export global state variables for cross-module access
  window.labelsVisible = labelsVisible;
  window.annotationLabels = annotationLabels;
  window.currentEditingLayer = currentEditingLayer;
  window.getStorageBackend = () => storageBackend;
  window.isDbApiAvailable = () => dbApiAvailable;
  window.getCurrentDbSessionId = () => currentDbSessionId;
  window.setCurrentDbSessionId = (sessionId) => { currentDbSessionId = sessionId; };
}

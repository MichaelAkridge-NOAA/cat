/**
 * Overlay Layer Management for CAT
 * Handles shapefile upload, rendering, and editing of transects/segments
 */

// Store overlay layers
let overlayLayers = {};
let currentProjectId = null;

// The single active edit session — always the set of currently-selected
// features (see _selectedFeatures below). There used to be three separate
// mechanisms here (single-feature popup-unlock, a whole-layer Ctrl+drag
// checkbox, and this one) that had to be kept behaviorally consistent by
// hand; they're unified into one, since "move a whole layer" is just
// "select every feature in that layer" (see the layer panel's "Select all"
// button) and "unlock one feature via its popup" is just "select it".
// Shape: { items: [{layerId, featureId, layer}, ...], snapshots, dirty }
let _overlayEditSession = null;

// The one selection mechanism for every move/rotate scope — a single
// feature (popup "Select to edit"), several features spanning any number
// of layers (shift-click / the per-layer Features checklist), or a whole
// layer (its "Select all" button, which just adds every one of its
// features here). Selecting a locked feature auto-unlocks it. Session-only,
// cleared on Save/Cancel and on layer teardown/reload.
// Map<"layerId:featureId", {layerId, featureId, layer}>
let _selectedFeatures = new Map();

function _featureSelKey(layer) {
  return `${layer._overlayLayerId}:${layer._overlayFeatureId}`;
}

// ============================================================================
// USER STYLE PREFERENCES — per-viewer color/border/centroid overrides for
// Segment and Transect overlay features (Preferences → Overlay layers).
// Deliberately client-side only: these change how overlays LOOK in this
// signed-in user's browser, not what's stored on the project, so two
// collaborators can each view the same shapefile in their own preferred
// colors without fighting over one shared style. A colorOverride of ''
// (the default) means "keep whatever this project's layer already uses" —
// leaving these unset must not change anything for someone who hasn't
// touched the preferences page.
// ============================================================================
let _overlayStylePrefsPromise = null;

function _getOverlayStylePrefs() {
  if (_overlayStylePrefsPromise) return _overlayStylePrefsPromise;
  _overlayStylePrefsPromise = (async () => {
    if (!window.CatAuth || typeof CatAuth.fetchCurrentUser !== 'function') return {};
    try {
      const data = await CatAuth.fetchCurrentUser();
      return (data && data.preferences && data.preferences.overlay_style) || {};
    } catch (e) {
      return {}; // not signed in, or auth disabled (file mode) — no overrides
    }
  })();
  return _overlayStylePrefsPromise;
}

// Selection highlight is a CSS class that recolours the stroke — NOT a
// `filter: drop-shadow(...)`. A double drop-shadow on a live SVG <path> is
// re-rasterized on every paint, and a dragged feature repaints every frame
// (the ghost-drag CSS transform), so moving a selected segment quickly — or
// selecting a dozen of them — could hang and then crash the tab.
(function injectSelectionHighlightStyle() {
  if (document.getElementById('catSelHighlightStyle')) return;
  const s = document.createElement('style');
  s.id = 'catSelHighlightStyle';
  s.textContent =
    'path.cat-feature-selected { stroke: #ffeb3b !important; stroke-opacity: 1 !important; }' +
    'path.cat-annotation-selected { stroke: #3b82f6 !important; stroke-opacity: 1 !important; }' +
    'img.cat-feature-selected { outline: 2px solid #ffeb3b; outline-offset: 1px; border-radius: 50%; }' +
    'img.cat-annotation-selected { outline: 2px solid #3b82f6; outline-offset: 1px; border-radius: 50%; }';
  document.head.appendChild(s);
})();

function _setFeatureSelectedStyle(layer, selected) {
  const el = layer._path || layer._icon;
  // DOM-level, not layer.setStyle — same reasoning as the contributor-
  // visibility toggle and map selection highlight elsewhere: setStyle here
  // would fight the opacity/line-width sliders, which unconditionally
  // restyle every layer.
  if (el) el.classList.toggle('cat-feature-selected', !!selected);
}

// Selecting a feature both unlocks it AND enrolls it in _overlayEditSession
// immediately, snapshotting its pristine geometry right then — this is what
// makes the edit bar appear the instant you select something (rather than
// only after a completed drag), and guarantees Save/Cancel always has a
// correct pre-edit snapshot no matter whether the user ends up
// dragging/rotating/vertex-editing/resizing it, or does nothing at all.
async function toggleFeatureSelection(layer) {
  // View-only project: selecting a feature unlocks it server-side, which a
  // viewer isn't allowed to do — don't even start an edit session.
  if (window.catReadOnly) return;
  const key = _featureSelKey(layer);
  const layerId = layer._overlayLayerId;
  const featureId = layer._overlayFeatureId;

  if (_selectedFeatures.has(key)) {
    // Deselecting mid-session discards any uncommitted change to just this
    // feature (revert to its snapshot) and relocks it — Save/Cancel on
    // whatever remains selected is unaffected.
    _selectedFeatures.delete(key);
    _setFeatureSelectedStyle(layer, false);
    // A live vertex-edit session holds handles bound to the pre-restore
    // latlngs array — disable it before swapping geometry out from under it,
    // same as cancelOverlayEdit does.
    if (layer.editing && layer.editing.enabled()) {
      layer.editing.disable();
      _removeStaleEditHandles(layer);
    }
    const snap = _overlayEditSession && _overlayEditSession.snapshots[featureId];
    if (snap) _restoreLayerFromGeoJSON(layer, snap);
    layer.setStyle({ color: overlayLayers[layerId]?.color, weight: overlayLayers[layerId]?.borderWidth || 2, dashArray: null });
    layer._catLocked = true;
    layer.setPopupContent(_overlayFeaturePopupHtml(layer.feature, layer, overlayLayers[layerId]?.color));
    fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}/features/${featureId}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_locked: 1 }) }
    ).catch(err => console.error('Error relocking deselected feature:', err));

    if (_overlayEditSession) {
      _overlayEditSession.items = _overlayEditSession.items.filter(it => it.layer !== layer);
      delete _overlayEditSession.snapshots[featureId];
      if (_overlayEditSession.items.length === 0) {
        _overlayEditSession = null;
        _closeOverlayEditBarDom();
      } else {
        _refreshOverlayEditBar();
      }
    }
    _refreshSelectionToolbar();
    if (typeof showStatus === 'function') {
      showStatus(_selectedFeatures.size > 0 ? `${_selectedFeatures.size} feature(s) selected` : 'Selection cleared', 'info');
    }
    return;
  }

  // Selecting a locked feature auto-unlocks it — a silent "drag did nothing
  // because it's still locked" is exactly the confusion this design is
  // meant to remove. Selecting IS unlocking; there's no separate step.
  if (layer._catLocked) {
    try {
      const resp = await fetch(
        `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}/features/${featureId}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_locked: 0 }) }
      );
      if (!resp.ok) throw new Error('Failed to unlock feature');
    } catch (error) {
      console.error('Error unlocking feature for selection:', error);
      if (typeof showStatus === 'function') showStatus(`❌ ${error.message}`, 'error');
      return;
    }
    layer._catLocked = false;
  }
  // Persistent dashed "armed" outline so a selected/unlocked feature is
  // visually distinguishable from a locked one.
  layer.setStyle({ dashArray: '3,3' });

  const entry = { layerId, featureId, layer };
  _selectedFeatures.set(key, entry);
  _setFeatureSelectedStyle(layer, true);

  if (!_overlayEditSession) _overlayEditSession = { items: [], snapshots: {}, dirty: false };
  _overlayEditSession.items.push(entry);
  _overlayEditSession.snapshots[featureId] = layer.toGeoJSON();
  const n = _overlayEditSession.items.length;
  _openOverlayEditBarDom(`✏️ Editing ${n} feature${n > 1 ? 's' : ''} — drag to move, Alt+drag to rotate — Save or Cancel`);

  _refreshSelectionToolbar();
  if (typeof showStatus === 'function') {
    showStatus(`${_selectedFeatures.size} feature(s) selected — drag any of them to move, Alt+drag to rotate`, 'info');
  }
}

function clearFeatureSelection() {
  _selectedFeatures.forEach(({ layer }) => _setFeatureSelectedStyle(layer, false));
  _selectedFeatures.clear();
  _refreshSelectionToolbar();
}

function _computeCentroidOfLayers(items) {
  const flat = [];
  (items || []).forEach(({ layer: l }) => {
    if (l.getLatLngs) {
      const nested = l.getLatLngs();
      const one = Array.isArray(nested[0]) ? nested.flat(Infinity) : nested;
      flat.push(...one);
    } else if (l.getLatLng) {
      flat.push(l.getLatLng());
    }
  });
  return _computeCentroid(flat);
}

// Selection status bar — shown above the layer list whenever 1+ features
// are selected, regardless of which layer(s) they belong to. No Move/Rotate
// buttons: a selected feature is just directly draggable (plain drag to
// move the whole selection, Alt+drag to rotate it around its shared
// centroid) — the same gesture as single-feature move/rotate always used,
// so there's exactly one motor pattern to learn regardless of how many
// features are selected or which layer(s) they came from. Reflects
// _selectedFeatures; also drives each layer's inline feature checkboxes
// back into sync via _refreshFeatureTableChecks.
function _refreshSelectionToolbar() {
  const listContainer = document.getElementById('overlayLayersList');
  if (!listContainer || !listContainer.parentElement) return;
  const count = _selectedFeatures.size;
  let bar = document.getElementById('overlaySelectionToolbar');
  if (count === 0) {
    if (bar) bar.remove();
    _refreshFeatureTableChecks();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'overlaySelectionToolbar';
    listContainer.parentElement.insertBefore(bar, listContainer);
  }
  bar.style.cssText = 'display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:8px; padding:8px 10px; border:1px solid var(--cat-border, #dfe1e2); border-radius:4px; background:#fff8e1;';
  bar.innerHTML = `
    <span style="font-size:11px; color:#333; font-weight:500;">${count} feature${count > 1 ? 's' : ''} selected</span>
    <span style="font-size:11px; color:#666;">— drag any of them to move together, Alt+drag to rotate</span>
    <button class="btn btn-secondary" style="font-size:11px;padding:3px 9px;" onclick="clearFeatureSelection()">✖ Clear</button>
  `;
  _refreshFeatureTableChecks();
}

function _refreshFeatureTableChecks() {
  document.querySelectorAll('.overlay-feature-row').forEach(row => {
    const key = row.getAttribute('data-feature-key');
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.checked = _selectedFeatures.has(key);
  });
}

// True if the active edit session touches this layer.
function _sessionTouchesLayer(layerId) {
  if (!_overlayEditSession) return false;
  return _overlayEditSession.items.some(it => it.layerId === layerId);
}

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
// Bumped on every load so an older, still-awaiting load can tell it has been
// superseded (initial load + saveLayerManagement can overlap) and stop adding
// layers to a map that was already reset under it.
let _overlayLoadSeq = 0;

async function loadExistingOverlays(projectId) {
  const loadSeq = ++_overlayLoadSeq;
  // Discard (no save) any in-progress unlock/edit session — this is a
  // wholesale teardown of every overlayLayers entry (called on project load
  // and after saveLayerManagement()), so a session left pointing at a
  // detached layer would let its edit bar's Save/Cancel act on nothing.
  if (_overlayEditSession) {
    _overlayEditSession = null;
    _closeOverlayEditBarDom();
  }
  // All feature objects below are about to be torn down and rebuilt — a
  // stale layer reference in the selection would break drag-to-move silently.
  _selectedFeatures.clear();
  const staleToolbar = document.getElementById('overlaySelectionToolbar');
  if (staleToolbar) staleToolbar.remove();

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

    if (!response.ok) {
      if (typeof showStatus === 'function') showStatus(`⚠️ Could not load overlay layers (HTTP ${response.status})`, 'warning');
      return;
    }

    const data = await response.json();

    // Filter to only active layers and sort by display_order
    const activeLayers = (data.layers || [])
      .filter(layer => layer.is_active)
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    
    if (activeLayers.length > 0) {
      console.log(`📂 Loading ${activeLayers.length} active overlay layers...`);
      
      for (const layer of activeLayers) {
        if (loadSeq !== _overlayLoadSeq) return; // a newer load took over
        const style = layer.style || {};
        await loadOverlayLayer(layer.layer_id, layer.layer_name, style.color || '#00ff00', layer.layer_type || null, !!layer.is_locked, style.weight || null, loadSeq);
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
async function loadOverlayLayer(layerId, layerName, layerColor = '#00ff00', layerType = null, layerLocked = true, savedWeight = null, loadSeq = null) {
  try {
    const response = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}/features`
    );

    if (!response.ok) {
      throw new Error('Failed to load layer features');
    }

    const data = await response.json();
    console.log(`🗺️ Rendering ${data.features.length} features for layer: ${layerName}`);

    // Apply this viewer's personal color/border/centroid preferences for
    // Segment/Transect overlays (Preferences → Overlay layers). An empty
    // colorOverride means "no change" — layerColor stays whatever the
    // project's layer record already says.
    const stylePrefs = await _getOverlayStylePrefs();
    const typePrefs = (layerType === 'segment' || layerType === 'transect') ? (stylePrefs[layerType] || {}) : {};
    // Keep the project's own saved color: layerColor below may be this
    // viewer's personal override, which must never be written back to the
    // shared project style (setOverlayBorderWidth used to do exactly that).
    const projectColor = layerColor;
    if (typePrefs.colorOverride) layerColor = typePrefs.colorOverride;
    // A per-layer saved weight (set via the Map Layers sidebar's own line-width
    // control, persisted in style_json) wins over the type-wide preference
    // default — it's a more specific, more recent choice about this exact layer.
    const borderWidth = savedWeight || typePrefs.borderWidth || 2;
    const fillOpacity = typePrefs.borderOnly ? 0 : 0.2;
    const showCentroids = !!stylePrefs.showCentroids;

    // Create Leaflet layer group
    const layerGroup = L.featureGroup();

    // Add each feature
    data.features.forEach(featureData => {
      const feature = featureData.feature;

      const geoJsonLayer = L.geoJSON(feature, {
        pane: 'shapefilePane',
        style: {
          color: layerColor,
          weight: borderWidth,
          opacity: 0.8,
          fillOpacity: fillOpacity,
          interactive: true
          // NOTE: a `clickTolerance` option used to be set here to widen the
          // hit area of thin lines. Leaflet has no such *path* option (hit
          // tolerance exists only as a renderer option, and only for canvas),
          // so it never did anything. A real fix would need a transparent
          // wider hit-stroke; the ghost-drag code keys on each layer's own
          // SVG <path>, so that is left as a separate change.
        },
        onEachFeature: (feature, layer) => {
          // Store the feature_id and layer_id on the Leaflet layer
          layer._overlayFeatureId = featureData.feature_id;
          layer._overlayLayerId = layerId;
          // Always start LOCKED on load, regardless of what the DB row says.
          // is_locked:0 in the DB means "someone had an edit session open,"
          // not "safe to drag in a fresh tab" — a session that ends any way
          // other than Save/Cancel (reload, tab close, crash, project
          // switch) would otherwise leave the row unlocked forever and this
          // fresh load would treat that as an invitation to drag it with no
          // session/snapshot/edit-bar backing it. Unlock is always initiated
          // fresh, in-tab, via the popup button below.
          layer._catLocked = true;
          // Best-effort heal: if the row was left unlocked by an abandoned
          // session, quietly relock it in the DB so the next load (in any
          // tab) doesn't see it as unlocked either. Not awaited — this must
          // never block or fail feature rendering.
          if (featureData.is_locked === 0) {
            fetch(
              `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}/features/${featureData.feature_id}`,
              { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_locked: 1 }) }
            ).catch(() => {});
          }

          // Popup shows properties plus a lock badge/Unlock button (or an
          // editing hint while a session is active). Bound unconditionally —
          // even a feature with no properties still needs the unlock entry
          // point. Refreshed on every popupopen so it reflects current state.
          layer.bindPopup('');
          layer.on('popupopen', () => {
            layer.setPopupContent(_overlayFeaturePopupHtml(feature, layer, layerColor));
          });
          layer.setPopupContent(_overlayFeaturePopupHtml(feature, layer, layerColor));

          // Shift+click: toggle this feature into/out of the cross-layer
          // multi-select used for "move this segment + its overlapping
          // transect line together" (see _selectedFeatures below). Runs
          // after bindPopup's own click listener already opened the popup
          // for this same click — close it right back since a shift-click
          // means "select", not "show details", and both happen inside the
          // same synchronous event so there's no visible flicker.
          layer.on('click', (e) => {
            if (e.originalEvent && e.originalEvent.shiftKey) {
              layer.closePopup();
              toggleFeatureSelection(layer);
            }
          });

          // Double-click toggles vertex-edit mode (Leaflet.Draw adds .editing
          // to layers) for both segments and transects. A resize (width)
          // popup is available separately via the popup's 📏 Resize button
          // for segments — it doesn't replace vertex editing, it's an
          // additional quick path for the common "just make it wider/
          // narrower" case. The vertex-count guard below is a real safety
          // backstop: Leaflet.Draw's own vertex-edit overlay redraws the
          // whole path on every mousemove, entirely outside our ghost-drag
          // system, so a feature with an unusually large number of vertices
          // (a densely-buffered upload, say) could still be slow to edit
          // directly — the threshold is generous since ordinary segments
          // (simple 4-corner rectangles) and transects (2-point lines) are
          // nowhere near it.
          layer.on('dblclick', (e) => {
            L.DomEvent.stop(e);
            if (layer._catLocked) {
              if (typeof showStatus === 'function') {
                showStatus('🔒 Feature is locked — select it first (shift-click, or its checkbox) to edit', 'warning');
              }
              return;
            }
            const vertexCount = layer.getLatLngs ? JSON.stringify(layer.getLatLngs()).match(/lat/g)?.length || 0 : 0;
            if (vertexCount > 60) {
              if (typeof showStatus === 'function') {
                const hint = (feature && feature.properties && 'Width_m' in feature.properties)
                  ? ' — use the popup\'s 📏 Resize instead' : '';
                showStatus(`⚠️ Too many vertices (${vertexCount}) to edit directly here${hint}`, 'warning');
              }
              return;
            }
            if (layer.editing && layer.editing.enabled()) {
              layer.editing.disable();
              _removeStaleEditHandles(layer);
              _closeResizePopupDom();
              _hideLiveSize();
              // Still selected/mid-session — keep the dashed "armed" outline,
              // don't clear it (that only happens for real on Save/Cancel).
              layer.setStyle({ color: layerColor, dashArray: '3,3' });
              if (layer._catExitEdit) {
                document.removeEventListener('keydown', layer._catExitEdit, true);
                layer._catExitEdit = null;
              }
            } else if (layer.editing) {
              layer.editing.enable();
              layer.setStyle({ color: '#ff9800', dashArray: '6,4' });
              // Show current width/length as editable numbers right alongside
              // hand-dragging — answers "what size is this, right now" without
              // a separate click, and typing an exact number is often faster
              // than eyeballing a vertex drag anyway. Segments only (needs
              // Width_m); a plain transect line has neither.
              if (feature && feature.properties && 'Width_m' in feature.properties) {
                _openResizePopup(layer, feature, layerColor);
              }
              // Live size readout (updates on every vertex drag via the
              // 'editdrag' handler below) — for any feature type.
              _updateLiveSize(layer);
              // Leaflet's synthetic 'dblclick' event never reaches a vector layer
              // while leaflet-draw's vertex-editing overlay is active on it, so
              // this handler's own disable-branch above can't fire from a literal
              // second double-click — editing auto-finishes as soon as a vertex
              // drag ends (see the 'edit' handler below), with no further click
              // needed. It no longer auto-saves — that only happens when the
              // user clicks Save on the edit bar.
              showStatus('✏️ Editing vertices — drag a handle to move it, then Save/Cancel on the edit bar; press Escape to finish', 'info');

              // Escape exits edit mode even if no vertex was dragged (Leaflet suppresses
              // dblclick on the layer while its editing overlay is active, so the dblclick
              // disable-branch above can't fire on its own).
              var _exitEdit = function(ev) {
                if (ev.key !== 'Escape') return;
                if (layer.editing && layer.editing.enabled()) {
                  layer.editing.disable();
                  _removeStaleEditHandles(layer);
                  _closeResizePopupDom();
                  _hideLiveSize();
                  layer.setStyle({ color: layerColor, dashArray: '3,3' });
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

          // Plain drag / Alt+drag — only active while this feature is
          // selected, gated inside enableLayerTranslateDrag() itself.
          enableLayerTranslateDrag(layer, layerGroup, layerId, layerColor);

          if (showCentroids) _addCentroidMarker(layer, layerGroup, layerColor);

          // Vertex-drag finished. This used to auto-save immediately; now it
          // only marks the active edit session dirty — persistence happens
          // when the user clicks Save on the edit bar, so Cancel has real
          // meaning.
          // Fires continuously while a vertex handle is being dragged.
          layer.on('editdrag', () => _updateLiveSize(layer));

          layer.on('edit', () => {
            layer.editing.disable();
            _removeStaleEditHandles(layer);
            // A hand-dragged vertex changes the shape, so bring its stored
            // Width_m / Length_m / Area_m2 in line with the new geometry (they
            // used to keep their pre-edit values). Save then persists them.
            _closeResizePopupDom();
            _refreshSizePropsFromGeometry(layer);
            layer.setStyle({ color: layerColor, dashArray: '3,3' });
            // Leave the final size on screen (with the type-in boxes reopened
            // for segments, now showing the measured values) until Save/Cancel.
            if (feature && feature.properties && 'Width_m' in feature.properties) {
              _openResizePopup(layer, layer.feature, layerColor);
            }
            _updateLiveSize(layer);
            _updateCentroidMarkerPosition(layer);
            if (layer._catExitEdit) {
              document.removeEventListener('keydown', layer._catExitEdit, true);
              layer._catExitEdit = null;
            }
            if (_overlayEditSession) {
              _overlayEditSession.dirty = true;
              _refreshOverlayEditBar();
            }
            if (typeof showStatus === 'function') {
              showStatus('✏️ Vertices updated — Save or Cancel in the edit bar', 'info');
            }
          });
        }
      });

      geoJsonLayer.addTo(layerGroup);
    });

    layerGroup.addTo(map);

    // Store layer reference
    // A newer loadExistingOverlays() reset the map while this one was awaiting
    // (features fetch / style prefs): registering now would orphan this group
    // and duplicate the row, so drop it instead.
    if (loadSeq !== null && loadSeq !== _overlayLoadSeq) {
      try { map.removeLayer(layerGroup); } catch (e) { /* not on map yet */ }
      return;
    }

    overlayLayers[layerId] = {
      name: layerName,
      layerGroup: layerGroup,
      visible: true,
      opacity: 80,
      color: layerColor,
      projectColor: projectColor,
      borderWidth: borderWidth,
      layerType: layerType,
      featureCount: data.features.length
    };

    // Add to layer list UI with feature count & color
    addOverlayLayerToUI(layerId, layerName, data.features.length, layerColor, layerType, layerLocked, borderWidth);

  } catch (error) {
    console.error(`Error loading overlay layer ${layerId}:`, error);
    showStatus(`❌ Failed to load layer: ${layerName}`, 'error');
  }
}

/**
 * Add overlay layer to UI list
 */
function addOverlayLayerToUI(layerId, layerName, featureCount = 0, color = '#00ff00', layerType = null, layerLocked = true, borderWidth = 2) {
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
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:8px;">
          <label style="font-size:11px; color:#666; display:flex; align-items:center; gap:4px;">
            Color:
            <input type="color" value="${color}" id="${safeId}_color"
                   onchange="changeOverlayColor(${layerId}, this.value)"
                   style="width:26px;height:20px;border:1px solid #ccc;padding:0;cursor:pointer;background:transparent;border-radius:3px;">
          </label>
          <label style="font-size:11px; color:#666; display:flex; align-items:center; gap:3px; cursor:pointer;">
            <input type="checkbox" id="${safeId}_borderOnly" onchange="toggleOverlayBorderOnly(${layerId})"> Border only
          </label>
          <label style="font-size:11px; color:#666; display:flex; align-items:center; gap:4px;" title="Line/border thickness for this layer">
            Width:
            <input type="range" id="${safeId}_borderWidth" min="1" max="10" step="1" value="${borderWidth}"
                   oninput="setOverlayBorderWidth(${layerId}, this.value)" style="width:60px;">
            <span id="${safeId}_borderWidthValue" style="min-width:14px;display:inline-block;">${borderWidth}</span>
          </label>
          <button class="btn btn-secondary" onclick="zoomToOverlayLayer(${layerId})"
                  style="font-size:11px;padding:3px 9px;" title="Zoom to layer extent">
            🔍 Zoom
          </button>
        </div>
        <div style="margin-bottom:10px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; padding:3px 0;">
            <div onclick="_toggleFeatureListVisibility('${safeId}_featuresList')"
                 style="cursor:pointer; font-size:11px; color:#495057; font-weight:500; display:flex; align-items:center; gap:4px; flex:1;"
                 title="Select individual segments/transects to move or rotate together">
              <span id="${safeId}_featuresListIcon">▶</span> Features (${featureCount})
            </div>
            <button class="btn btn-secondary" onclick="selectAllFeaturesInLayer(${layerId})"
                    style="font-size:10px;padding:2px 7px;" title="Select every feature in this layer, so dragging any one of them moves the whole layer together">
              ☑️ Select all
            </button>
          </div>
          <div id="${safeId}_featuresList" style="display:none; max-height:180px; overflow-y:auto;
               border:1px solid var(--cat-border, #dfe1e2); border-radius:4px; padding:4px; background:#fff;">
            ${_buildFeatureTableRows(layerId)}
          </div>
        </div>
        <div class="opacity-control">
          <label>Opacity: <span id="${safeId}_opacityValue">80</span>%</label>
          <input type="range" class="opacity-slider" id="${safeId}_opacity"
                 min="0" max="100" value="80"
                 oninput="setOverlayOpacity(${layerId}, this.value)">
        </div>
        <button class="btn btn-danger" onclick="removeOverlayLayer(${layerId})"
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

// Per-layer scrollable checklist of individual features (segments/transects),
// the discoverable alternative to shift-clicking tiny map shapes. Checking a
// row calls the same toggleFeatureSelection() shift-click already uses, so
// map highlight and the selection toolbar stay in sync either way.
function _buildFeatureTableRows(layerId) {
  const layerData = overlayLayers[layerId];
  if (!layerData || !layerData.layerGroup) return '';
  const rows = [];
  layerData.layerGroup.eachLayer(geoJsonGroup => {
    const push = (sub) => {
      if (sub._overlayFeatureId == null) return;
      const props = (sub.feature && sub.feature.properties) || {};
      const label = props.Trans_ID ?? props.Seg_ID ?? props.name ?? props.Name ?? props.id ?? `#${sub._overlayFeatureId}`;
      const key = _featureSelKey(sub);
      const checked = _selectedFeatures.has(key) ? 'checked' : '';
      rows.push(`
        <label class="overlay-feature-row" data-feature-key="${key}"
               style="display:flex; align-items:center; gap:6px; font-size:11px; color:#444; padding:2px 4px; cursor:pointer; border-radius:3px;">
          <input type="checkbox" ${checked} onchange="_onFeatureRowToggle(${layerId}, ${sub._overlayFeatureId}, this.checked)">
          <span onclick="_panToOverlayFeature(${layerId}, ${sub._overlayFeatureId}); event.stopPropagation();" style="flex:1;">${label}</span>
        </label>
      `);
    };
    if (geoJsonGroup.eachLayer) geoJsonGroup.eachLayer(push); else push(geoJsonGroup);
  });
  return rows.join('') || '<div style="font-size:11px;color:#999;padding:4px;">No features</div>';
}

function _onFeatureRowToggle(layerId, featureId, checked) {
  const layer = _findOverlayFeatureLayer(layerId, featureId);
  if (!layer) return;
  const isSelected = _selectedFeatures.has(_featureSelKey(layer));
  if (checked === isSelected) return;
  toggleFeatureSelection(layer);
}

function _panToOverlayFeature(layerId, featureId) {
  const layer = _findOverlayFeatureLayer(layerId, featureId);
  if (!layer) return;
  const bounds = layer.getBounds ? layer.getBounds() : null;
  if (bounds && bounds.isValid && bounds.isValid()) {
    map.panTo(bounds.getCenter());
  } else if (layer.getLatLng) {
    map.panTo(layer.getLatLng());
  }
}

function _toggleFeatureListVisibility(id) {
  const el = document.getElementById(id);
  const icon = document.getElementById(id + 'Icon');
  if (!el) return;
  const hidden = el.style.display === 'none';
  el.style.display = hidden ? 'block' : 'none';
  if (icon) icon.textContent = hidden ? '▼' : '▶';
}

/**
 * Select every feature in a layer — this is "move a whole layer together"
 * now: there's no separate layer-level lock/checkbox mechanism, it's just
 * every one of the layer's features added to the same selection used
 * everywhere else, auto-unlocking each as it goes.
 */
async function selectAllFeaturesInLayer(layerId) {
  const layerData = overlayLayers[layerId];
  if (!layerData || !layerData.layerGroup) return;
  const targets = [];
  layerData.layerGroup.eachLayer(geoJsonGroup => {
    const push = (sub) => { if (sub._overlayFeatureId != null) targets.push(sub); };
    if (geoJsonGroup.eachLayer) geoJsonGroup.eachLayer(push); else push(geoJsonGroup);
  });
  for (const layer of targets) {
    if (!_selectedFeatures.has(_featureSelKey(layer))) {
      await toggleFeatureSelection(layer);
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
    // Hiding a layer with an in-progress unlock/edit session would strand
    // the edit bar pointing at a detached layer. Cancel it properly — revert
    // geometry, relock the features on the server and clear the selection —
    // rather than just dropping the session, which used to leave those
    // features selected, unlocked and un-draggable. Its synchronous part
    // (restoring geometry) runs before the layer is detached below.
    if (_sessionTouchesLayer(layerId)) {
      cancelOverlayEdit();
      if (typeof showStatus === 'function') showStatus('↩️ Unsaved edits on the hidden layer were discarded', 'info');
    }
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
 * Set line/border width (weight) for an overlay layer's features.
 * Persisted per-layer in style_json, independent of the type-wide
 * Preferences → Overlay layers default — this is the live, in-place
 * control for "just this layer, right now."
 */
async function setOverlayBorderWidth(layerId, value) {
  const layerData = overlayLayers[layerId];
  if (!layerData) return;

  const weight = parseInt(value, 10) || 2;
  const valueEl = document.getElementById(`overlay_${layerId}_borderWidthValue`);
  if (valueEl) valueEl.textContent = weight;

  layerData.layerGroup.setStyle({ weight });
  layerData.borderWidth = weight;

  // View-only users get the live change but it stays in their browser.
  if (window.catReadOnly) return;
  try {
    const resp = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style_json: { color: layerData.projectColor || layerData.color, weight, opacity: 0.7 } })
      }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (e) {
    console.warn('Failed to save border width:', e);
    if (typeof showStatus === 'function') showStatus('⚠️ Line width changed on screen but could not be saved', 'warning');
  }
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

  // Discard (no save) any in-progress unlock/edit session on this layer —
  // it's about to be deleted.
  // Only drop this layer's items; features selected on other layers must stay
  // in the session (they remain unlocked and still need Save/Cancel).
  if (_overlayEditSession) {
    _overlayEditSession.items = _overlayEditSession.items.filter(it => it.layerId !== layerId);
    if (_overlayEditSession.items.length === 0) {
      _overlayEditSession = null;
      _closeOverlayEditBarDom();
    } else {
      _refreshOverlayEditBar();
    }
  }
  Array.from(_selectedFeatures.entries()).forEach(([key, it]) => {
    if (it.layerId === layerId) _selectedFeatures.delete(key);
  });
  _refreshSelectionToolbar();

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
async function saveFeatureGeometry(featureId, layerId, geoJSON, options = {}) {
  const { relock = false, silent = false } = options;
  try {
    const body = { feature: geoJSON };
    if (relock) body.is_locked = 1;

    const response = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}/features/${featureId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || 'Save failed');
    }

    console.log(`💾 Feature ${featureId} geometry saved`);
    if (!silent && typeof showStatus === 'function') showStatus('💾 Feature geometry saved', 'success');
  } catch (error) {
    console.error('Error saving feature geometry:', error);
    if (typeof showStatus === 'function') showStatus(`❌ Failed to save geometry: ${error.message}`, 'error');
    throw error;
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

  // View-only users get the live change but it stays in their browser.
  if (window.catReadOnly) return;
  // Persist to database (an explicit color pick becomes the project's color)
  try {
    const resp = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style_json: { color: newColor, weight: layerData.borderWidth || 2, opacity: 0.7 } })
      }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    layerData.projectColor = newColor;
  } catch (e) {
    console.warn('Failed to save color:', e);
    if (typeof showStatus === 'function') showStatus('⚠️ Color changed on screen but could not be saved', 'warning');
  }
}

// ============================================================================
// FEATURE TRANSFORM — Move/Rotate the current selection
// ============================================================================
// Controls:
//   Drag (no modifier) on any selected feature = move the whole selection
//   Alt+drag on any selected feature           = rotate it around the
//                                                 selection's shared centroid
//
// A feature is draggable exactly when it's selected (see toggleFeatureSelection
// / _selectedFeatures) — selecting it is the one deliberate "I mean to edit
// this" gesture (shift-click, the per-layer Features checklist, or a layer's
// "Select all" button), and it already auto-unlocks + opens the edit bar.
// A feature that isn't selected is left alone (no L.DomEvent.stop) so
// mousedown falls through to Leaflet's normal map-drag/pan handling. Nothing
// is committed until the cursor has moved past a small pixel threshold —
// that keeps single-click (popup) and double-click (vertex edit/resize)
// working for a feature that's merely clicked, not dragged.
// ============================================================================

let _transformState = null;

function enableLayerTranslateDrag(layer, layerGroup, layerId, layerColor) {
  layer.on('mousedown', function (e) {
    // While the annotation lasso tool is armed, overlay features have no
    // business competing for the mousedown that starts a lasso drag — even
    // a locked feature only avoids stopping propagation, it doesn't fully
    // get out of the way (a dblclick/mouseup listener could still react).
    // An unlocked (= selected) feature actively claims the event
    // (L.DomEvent.stop below), which is what breaks a lasso drag that
    // happens to start on top of it.
    if (window.v2Lasso && window.v2Lasso.active) return;

    // Left button only — a right/middle click must not start a drag.
    if (e.originalEvent && e.originalEvent.button !== 0) return;

    // A feature is draggable exactly when it's selected — selecting it is
    // the one deliberate "I mean to edit this" gesture (shift-click, the
    // per-layer Features checklist, or "Select all"), and it already
    // auto-unlocks. No extra step, no modifier key to discover: plain drag
    // moves the whole selection, Alt+drag rotates it around its shared
    // centroid. A feature that isn't selected just falls through to normal
    // map panning / its own click-for-popup.
    if (!_selectedFeatures.has(_featureSelKey(layer))) return;

    // Don't start a transform while this feature is mid vertex-edit —
    // fighting Leaflet.Draw's own handle state is what was crashing.
    if (layer.editing && layer.editing.enabled()) {
      if (typeof showStatus === 'function') {
        showStatus('⚠️ Press Escape to finish editing vertices before moving/rotating', 'warning');
      }
      return;
    }

    const alt = e.originalEvent.altKey;
    const mode = alt ? 'rotateSelection' : 'moveSelection';

    // Refuse to clobber a different in-progress session (shouldn't normally
    // happen since the session always mirrors the current selection, but a
    // stray leftover session from before a reload is possible).
    const selKeys = Array.from(_selectedFeatures.keys());
    const sameSelSession = _overlayEditSession && _overlayEditSession.items.length === selKeys.length &&
      selKeys.every(k => _overlayEditSession.items.some(it => `${it.layerId}:${it.featureId}` === k));
    if (_overlayEditSession && !sameSelSession) {
      if (typeof showStatus === 'function') {
        showStatus('⚠️ Finish the current edit (Save/Cancel) before moving the selection', 'warning');
      }
      return;
    }

    L.DomEvent.stop(e);

    const downPoint = map.mouseEventToContainerPoint(e.originalEvent);
    const DRAG_THRESHOLD_PX = 4;

    // mouseup is listened for on `document` (capture), not on the map: a
    // release outside the map container (easy with the docked sidebar) never
    // reaches a Leaflet 'mouseup' handler, which used to strand these
    // listeners and leave the feature following the cursor.
    function armedMove(moveEvt) {
      const p = map.mouseEventToContainerPoint(moveEvt.originalEvent);
      if (downPoint.distanceTo(p) < DRAG_THRESHOLD_PX) return;
      map.off('mousemove', armedMove);
      document.removeEventListener('mouseup', armedUp, true);
      _beginTransform(mode, layer, layerGroup, layerId, layerColor, e.latlng);
    }
    function armedUp() {
      map.off('mousemove', armedMove);
      document.removeEventListener('mouseup', armedUp, true);
      // Released without moving past the threshold — a plain click, not a
      // drag. Leave it alone; the layer's own click/dblclick handlers
      // (popup, vertex-edit toggle) already fire independently of this.
    }

    map.on('mousemove', armedMove);
    document.addEventListener('mouseup', armedUp, true);
  });
}

// ── Ghost-drag: CSS-transform preview instead of live geometry mutation ──
// rAF coalescing (below) caps how often we redraw, but a single redraw of a
// dense buffered polygon (or a whole multi-feature selection of them) can
// itself take too long even once per frame — the freeze report persisted after
// coalescing alone. Real fix: during the drag, never touch lat/lng geometry
// at all. Apply a CSS transform (translate/rotate) directly to the rendered
// SVG <path>/<icon> elements — that's a compositor-only operation, O(1)
// regardless of vertex count, no path recompute. Commit the real geometry
// with a single _offsetLayer/_rotateLayer call on mouseup, then clear the
// CSS transform so the freshly-committed real coordinates take over.
function _collectMoveTargets(items) {
  const targets = [];
  (items || []).forEach(it => { if (it.layer) targets.push(it.layer); });
  return targets;
}

function _setTargetsCssTransform(targets, transformCss, originPx) {
  targets.forEach(t => {
    const el = t._path || t._icon;
    if (!el) return;
    el.style.transformOrigin = originPx ? `${originPx.x}px ${originPx.y}px` : '';
    el.style.transform = transformCss;
  });
}

function _clearTargetsCssTransform(targets) {
  targets.forEach(t => {
    const el = t._path || t._icon;
    if (!el) return;
    el.style.transform = '';
    el.style.transformOrigin = '';
  });
}

function _beginTransform(mode, layer, layerGroup, layerId, layerColor, startLatLng) {
  // The session (and its pre-edit snapshots) already exists — it was
  // created/extended when each feature was selected (toggleFeatureSelection),
  // not here. This just previews the drag and, on release, commits it.
  const items = (_overlayEditSession && _overlayEditSession.items) || [];
  items.forEach(({ layer: l }) => l.setStyle({ color: '#ff5722', weight: 4, dashArray: '4,4' }));

  const centroid = mode === 'rotateSelection' ? _computeCentroidOfLayers(items) : null;

  const targets = _collectMoveTargets(items);
  const startLayerPoint = map.latLngToLayerPoint(startLatLng);
  const centroidLayerPoint = centroid ? map.latLngToLayerPoint(centroid) : null;

  _transformState = {
    mode: mode,
    items: items,
    startLatLng: startLatLng,
    lastLatLng: startLatLng, // always defined, even if mouseup fires before any mousemove
    centroid: centroid,
    startAngle: centroid ? Math.atan2(startLatLng.lng - centroid.lng, startLatLng.lat - centroid.lat) : 0,
    targets: targets,
    startLayerPoint: startLayerPoint,
    centroidLayerPoint: centroidLayerPoint,
    startAnglePx: centroidLayerPoint
      ? Math.atan2(startLayerPoint.y - centroidLayerPoint.y, startLayerPoint.x - centroidLayerPoint.x)
      : 0
  };

  // Remember whether panning was on, so ending the drag restores that rather
  // than blindly enabling it (another tool may have had it deliberately off).
  _transformState.draggingWasEnabled = map.dragging.enabled();
  map.dragging.disable();
  map.on('mousemove', _onTransformMove);
  // On document (capture) so releasing outside the map still ends the drag.
  document.addEventListener('mouseup', _onTransformEnd, true);

  const hint = mode === 'rotateSelection'
    ? '🔄 Rotating selected feature(s) around their shared center. Release to apply.'
    : '🔀 Moving selected feature(s) — release to drop.';
  if (typeof showStatus === 'function') showStatus(hint, 'info');
}

// Native 'mousemove' can fire far faster than the browser can afford to
// redo a full geometry redraw (projecting every vertex + rebuilding the SVG
// path) — for a buffered transect/segment polygon (dozens of vertices from
// shapely's round-join buffering) or a whole-layer Ctrl+drag (every
// sub-feature redrawn per event), a long/fast drag queues up events faster
// than they can be processed and the tab appears to freeze. Coalesce to at
// most one redraw per animation frame: cheap events (arriving faster than
// paint) just update the pending target; only the latest is ever applied.
let _transformRafId = null;
let _pendingTransformLatLng = null;

function _onTransformMove(e) {
  if (!_transformState) return;
  _pendingTransformLatLng = e.latlng;
  if (_transformRafId !== null) return; // a frame is already scheduled
  _transformRafId = requestAnimationFrame(() => {
    _transformRafId = null;
    const latlng = _pendingTransformLatLng;
    _pendingTransformLatLng = null;
    if (latlng) _applyTransformMove(latlng);
  });
}

function _applyTransformMove(latlng) {
  if (!_transformState) return;
  const { mode, targets, startLayerPoint, centroid, centroidLayerPoint, startAnglePx } = _transformState;
  const _t0 = performance.now();

  try {
    if (mode === 'moveSelection') {
      // Visual-only preview: CSS-translate the rendered elements instead of
      // touching real geometry. O(1) per frame regardless of vertex count —
      // this is what actually fixes the freeze (rAF coalescing alone only
      // capped event *rate*, not the cost of a single dense redraw).
      const curPoint = map.latLngToLayerPoint(latlng);
      const dx = curPoint.x - startLayerPoint.x;
      const dy = curPoint.y - startLayerPoint.y;
      _setTargetsCssTransform(targets, `translate(${dx}px, ${dy}px)`, null);

    } else if (mode === 'rotateSelection' && centroid) {
      const curPoint = map.latLngToLayerPoint(latlng);
      const curAnglePx = Math.atan2(curPoint.y - centroidLayerPoint.y, curPoint.x - centroidLayerPoint.x);
      const deltaDeg = (curAnglePx - startAnglePx) * 180 / Math.PI;
      _setTargetsCssTransform(targets, `rotate(${deltaDeg}deg)`, centroidLayerPoint);
    }
    _transformState.lastLatLng = latlng;
  } catch (err) {
    // Never leave the map stuck (dragging disabled, stale state) if a
    // mid-drag update throws — end the transform cleanly instead.
    console.error('Error during feature transform:', err);
    // If we are already inside _onTransformEnd (its final in-flight frame),
    // let it finish its own cleanup — re-entering nulled the state under it.
    if (_transformState && !_transformState.ending) _onTransformEnd();
    return;
  }

  // Diagnostic left over from the rAF-coalescing-only fix, kept as a
  // regression check: a CSS transform should never take >50ms regardless of
  // vertex count. If this ever fires now, the ghost-drag approach itself
  // has a problem, not just "too many vertices."
  const _ms = performance.now() - _t0;
  if (_ms > 50) {
    console.warn(`[overlay-transform] slow frame: ${_ms.toFixed(0)}ms mode=${mode}`);
  }
}

function _onTransformEnd() {
  if (!_transformState) return;
  const st = _transformState;
  st.ending = true; // stops _applyTransformMove's error path re-entering us
  const { mode, items, targets, startLatLng, centroid } = st;

  // Cleanup that must always happen, even if persistence below throws —
  // this is what previously could leave the map stuck with dragging
  // disabled ("crashed") if something in the save/style-reset step failed.
  map.off('mousemove', _onTransformMove);
  document.removeEventListener('mouseup', _onTransformEnd, true);
  if (st.draggingWasEnabled !== false) map.dragging.enable();
  if (_transformRafId !== null) {
    cancelAnimationFrame(_transformRafId);
    _transformRafId = null;
    // Don't drop the final in-flight movement — without this, releasing the
    // mouse between the last mousemove and the next paint would leave the
    // feature a frame short of where the user actually let go.
    if (_pendingTransformLatLng) _applyTransformMove(_pendingTransformLatLng);
  }
  _pendingTransformLatLng = null;

  try {
    // Commit the real geometry exactly once, using the final mouse
    // position — the drag itself only ever moved a CSS transform, never
    // real lat/lng. This single commit costs the same as one old-style
    // frame did, but it only happens once per drag instead of once per
    // mousemove/frame.
    if (mode === 'moveSelection') {
      const dLat = st.lastLatLng.lat - startLatLng.lat;
      const dLng = st.lastLatLng.lng - startLatLng.lng;
      if (dLat !== 0 || dLng !== 0) {
        targets.forEach(t => _offsetLayer(t, dLat, dLng));
      }
    } else if (mode === 'rotateSelection' && centroid) {
      // Use the same on-screen angle the drag preview showed. Web Mercator is
      // conformal, so a screen angle IS the true angle on the ground; the old
      // lat/lng-degree angle disagreed with the preview by cos(latitude).
      const { centroidLayerPoint, startAnglePx } = st;
      const endPoint = map.latLngToLayerPoint(st.lastLatLng);
      const finalAnglePx = Math.atan2(endPoint.y - centroidLayerPoint.y, endPoint.x - centroidLayerPoint.x);
      const totalAngle = finalAnglePx - startAnglePx; // clockwise on screen == clockwise bearing
      if (totalAngle !== 0) targets.forEach(t => _rotateLayer(t, centroid, totalAngle));
    }

    // Reset styles — keep the persistent dashed "armed" outline (each
    // selected feature stays mid-session until Save/Cancel), just restore
    // each feature's own color rather than the shared drag-preview orange.
    (items || []).forEach(({ layerId: id, layer: l }) => {
      const origColor = (overlayLayers[id] && overlayLayers[id].color) || '#00ff00';
      const origWeight = (overlayLayers[id] && overlayLayers[id].borderWidth) || 2;
      l.setStyle({ color: origColor, weight: origWeight, dashArray: '3,3' });
      _updateCentroidMarkerPosition(l);
    });

    // Nothing is auto-saved anymore — a drag/rotate just leaves the new
    // geometry live on the map and marks the active edit session dirty.
    // The user commits via Save (or discards via Cancel) on the edit bar.
    if (_overlayEditSession) {
      _overlayEditSession.dirty = true;
      _refreshOverlayEditBar();
    }
    const verb = mode === 'rotateSelection' ? 'rotated' : 'moved';
    if (typeof showStatus === 'function') showStatus(`🔀 ${(items || []).length} feature(s) ${verb} — Save or Cancel in the edit bar`, 'info');
  } catch (err) {
    console.error('Error finishing feature transform:', err);
    if (typeof showStatus === 'function') showStatus('❌ Error saving move/rotate — see console', 'error');
  } finally {
    // Always clear the preview transform, even if committing the real
    // geometry above threw — otherwise the path stays visually displaced
    // by the last CSS translate/rotate forever (setStyle never touches
    // style.transform), while any newly-created vertex handles are placed
    // at the real, un-displaced lat/lngs. That mismatch is what makes
    // vertices look like they're "in the wrong place" on a later edit.
    _clearTargetsCssTransform(targets);
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

// Leaflet.Draw's L.Edit.Poly caches its own `latlngs` reference at
// construction time (when the layer first gets a `.editing`), and only
// re-reads the layer's real _latlngs when it hears a 'revert-edited' event
// (see leaflet.draw.js's _updateLatLngs). Every setLatLngs() we do from
// outside the vertex-edit flow itself -- move, rotate, cancel/restore,
// resize -- swaps the layer's _latlngs array for a new one, which leaves
// that cached reference pointing at the OLD array. The next time the user
// double-clicks to vertex-edit, Leaflet.Draw builds its corner handles from
// the stale reference, so they appear at the pre-move position even though
// the shape itself is drawn in the right place. Firing this event after any
// setLatLngs resyncs the cache, exactly the way Leaflet.Draw's own revert
// flow does internally.
function _resyncEditingLatLngs(layer) {
  if (layer.editing) layer.fire('revert-edited', { layer: layer });
}

function _offsetLayer(layer, dLat, dLng) {
  if (layer.getLatLngs) {
    const shifted = _offsetLatLngs(layer.getLatLngs(), dLat, dLng);
    layer.setLatLngs(shifted);
    _resyncEditingLatLngs(layer);
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
  _resyncEditingLatLngs(layer);
}

function _rotateLatLngs(latlngs, center, angle) {
  if (Array.isArray(latlngs[0])) {
    return latlngs.map(ring => _rotateLatLngs(ring, center, angle));
  }
  // `angle` is clockwise (radians), matching the on-screen drag preview.
  // Rotate in metres, not degrees: a degree of longitude is only
  // cos(latitude) as long as a degree of latitude, so rotating the raw
  // (lat, lng) offsets sheared every shape (a few percent at Pacific sites)
  // and turned rectangles into parallelograms.
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const kx = Math.cos(center.lat * Math.PI / 180); // metres-per-degree ratio, lng vs lat
  return latlngs.map(ll => {
    const x = (ll.lng - center.lng) * kx; // east
    const y = ll.lat - center.lat;        // north
    const xr = x * cos + y * sin;
    const yr = -x * sin + y * cos;
    return L.latLng(center.lat + yr, center.lng + xr / kx);
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

// ── Centroid markers — Preferences → Overlay layers → "Show centroid
// markers". A small dot at each segment/transect feature's centroid,
// added to the same layerGroup as the feature itself so the layer's own
// visibility toggle and opacity slider affect it too. Kept off by
// default: it's a real feature (helps eyeball a segment's center without
// opening its popup for coordinates), not a debug aid, but not everyone
// wants an extra dot on every feature.
function _addCentroidMarker(layer, layerGroup, color) {
  if (!layer.getLatLngs) return; // points have no meaningful centroid distinct from themselves
  const centroid = _computeCentroid(layer.getLatLngs());
  if (!centroid) return;
  const marker = L.circleMarker(centroid, {
    pane: 'shapefilePane',
    radius: 4,
    color: '#fff',
    weight: 1,
    fillColor: color,
    fillOpacity: 1,
    interactive: false, // decoration only — must not steal clicks/lasso drags from the feature underneath
  });
  marker.addTo(layerGroup);
  layer._catCentroidMarker = marker;
}

// Reposition a feature's centroid dot after its geometry changes
// (vertex-edit, drag, rotate). A no-op if centroids are off (no marker
// was ever created) or the layer has no centroid of its own (a point).
function _updateCentroidMarkerPosition(layer) {
  if (!layer._catCentroidMarker || !layer.getLatLngs) return;
  const centroid = _computeCentroid(layer.getLatLngs());
  if (centroid) layer._catCentroidMarker.setLatLng(centroid);
}

// ============================================================================
// LOCK / EDIT-MODE — feature-level and layer-level
// ============================================================================
// Overlay features load LOCKED by default (DB column cat_overlay_features.
// is_locked, default 1). Nothing can drag/rotate/vertex-edit a feature until
// it's explicitly unlocked via its popup. Editing is a real session: unlock
// -> drag/rotate/vertex-edit freely -> Save (persists + relocks) or Cancel
// (restores original geometry + relocks). Only one session — feature or
// whole-layer bulk move — may be active at a time (_overlayEditSession).
//
// The layer-level lock (cat_overlay_layers.is_locked, default 0/unlocked)
// is a separate, persistent toggle that only gates the Ctrl+drag "move
// whole layer" transform; it is not itself a session.
// ============================================================================

function _overlayFeaturePopupHtml(feature, layer, layerColor) {
  const props = feature && feature.properties
    ? Object.entries(feature.properties)
        .filter(([k, v]) => v !== null && v !== '')
        .map(([k, v]) => `<b>${k}:</b> ${v}`)
        .join('<br>')
    : '';

  const isResizable = feature && feature.properties && 'Width_m' in feature.properties;
  const statusBlock = layer._catLocked
    ? `<div style="font-size:10px;color:#e67e22;margin-top:4px;">🔒 Locked</div>
       <button class="btn btn-sm" style="margin-top:4px;font-size:10px;padding:2px 8px;"
               onclick="selectOverlayFeatureById(${layer._overlayLayerId}, ${layer._overlayFeatureId})">
         🔓 Select to edit
       </button>`
    : `<div style="font-size:10px;color:#2e8b57;margin-top:4px;">✏️ Selected — drag to move, Alt+drag to rotate, dbl-click to edit vertices. Save/Cancel in the edit bar.</div>
       ${isResizable ? `<button class="btn btn-sm" style="margin-top:4px;font-size:10px;padding:2px 8px;"
               onclick="openOverlayResizeById(${layer._overlayLayerId}, ${layer._overlayFeatureId})">
         📏 Resize
       </button>` : ''}`;

  return (props ? props + '<br>' : '') +
    '<hr style="margin:4px 0">' + statusBlock;
}

function _findOverlayFeatureLayer(layerId, featureId) {
  const layerData = overlayLayers[layerId];
  if (!layerData) return null;
  let found = null;
  layerData.layerGroup.eachLayer(geoJsonGroup => {
    const check = (sub) => { if (sub._overlayFeatureId === featureId) found = sub; };
    if (geoJsonGroup.eachLayer) geoJsonGroup.eachLayer(check); else check(geoJsonGroup);
  });
  return found;
}

function selectOverlayFeatureById(layerId, featureId) {
  const layer = _findOverlayFeatureLayer(layerId, featureId);
  if (!layer) return;
  layer.closePopup();
  toggleFeatureSelection(layer);
}

function _overlayEditBarHtml(labelText) {
  return `
    <div id="overlayEditBar" style="position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
      z-index:9999; background:#232323; border:1px solid #444; border-radius:6px; padding:10px 14px;
      color:#eee; box-shadow:0 4px 16px rgba(0,0,0,0.4); font-size:12px; display:flex; align-items:center; gap:10px;">
      <span id="overlayEditBarLabel">${labelText}</span>
      <button class="btn btn-primary btn-sm" onclick="saveOverlayEdit()">💾 Save</button>
      <button class="btn btn-secondary btn-sm" onclick="cancelOverlayEdit()">✖ Cancel</button>
    </div>
  `;
}

function _openOverlayEditBarDom(labelText) {
  _closeOverlayEditBarDom();
  document.body.insertAdjacentHTML('beforeend', _overlayEditBarHtml(labelText));
}

function _closeOverlayEditBarDom() {
  const el = document.getElementById('overlayEditBar');
  if (el) el.remove();
  // The edit bar closing means Save/Cancel/teardown — the readout goes with it.
  _hideLiveSize();
  _closeResizePopupDom();
}

function _refreshOverlayEditBar() {
  if (!_overlayEditSession) return;
  const label = document.getElementById('overlayEditBarLabel');
  if (!label) return;
  const n = _overlayEditSession.items.length;
  label.textContent = `✏️ Editing ${n} feature${n > 1 ? 's' : ''} — geometry changed, click Save or Cancel`;
}

// ── Live size (width / length / area) ──────────────────────────────────────
// Measures a feature's current on-screen geometry in metres so the numbers can
// be shown while a vertex is being dragged, and written back into the
// feature's Width_m / Length_m / Area_m2 once the edit ends (they used to keep
// the values from before the edit, so a reshaped segment still claimed its old
// size).
function _firstLatLngPath(latlngs) {
  let ll = latlngs;
  while (Array.isArray(ll) && Array.isArray(ll[0])) ll = ll[0];
  return Array.isArray(ll) ? ll : null;
}

function _pathAreaM2(pts) {
  // Local equirectangular projection around the first point — plenty accurate
  // at segment scale (metres to a few hundred metres).
  const R = 6371008.8, rad = Math.PI / 180;
  const lat0 = pts[0].lat, lng0 = pts[0].lng, k = Math.cos(lat0 * rad);
  const xy = pts.map(p => [(p.lng - lng0) * rad * R * k, (p.lat - lat0) * rad * R]);
  let s = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function _overlaySizeMetrics(layer) {
  if (!layer || !layer.getLatLngs) return null;
  const pts = _firstLatLngPath(layer.getLatLngs());
  if (!pts || pts.length < 2) return null;
  const d = (a, b) => map.distance(a, b);
  const mid = (a, b) => L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);

  if (layer instanceof L.Polygon) {
    if (pts.length === 4) {
      // Segment rectangle, corner order as built server-side: the width edges
      // are c0-c3 and c1-c2; length runs between their midpoints.
      const [c0, c1, c2, c3] = pts;
      return {
        kind: 'rect',
        width: (d(c0, c3) + d(c1, c2)) / 2,
        length: d(mid(c0, c3), mid(c1, c2)),
        area: _pathAreaM2(pts)
      };
    }
    let perimeter = 0;
    for (let i = 0; i < pts.length; i++) perimeter += d(pts[i], pts[(i + 1) % pts.length]);
    return { kind: 'poly', perimeter, area: _pathAreaM2(pts) };
  }
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += d(pts[i - 1], pts[i]);
  return { kind: 'line', length };
}

function _formatOverlaySize(m) {
  if (!m) return '';
  const f = (n) => `${n.toFixed(2)} m`;
  if (m.kind === 'rect') return `Width ${f(m.width)} · Length ${f(m.length)} · Area ${m.area.toFixed(2)} m²`;
  if (m.kind === 'poly') return `Perimeter ${f(m.perimeter)} · Area ${m.area.toFixed(2)} m²`;
  return `Length ${f(m.length)}`;
}

function _updateLiveSize(layer) {
  const m = _overlaySizeMetrics(layer);
  if (!m) return;
  let el = document.getElementById('overlayLiveSize');
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="overlayLiveSize" role="status" style="position:fixed; bottom:122px; left:50%; transform:translateX(-50%);
        z-index:10000; background:#111; border:1px solid #ff9800; border-radius:16px; padding:5px 14px;
        color:#ffcc80; font-size:13px; font-weight:600; font-variant-numeric:tabular-nums;
        box-shadow:0 2px 10px rgba(0,0,0,0.4); pointer-events:none; white-space:nowrap;"></div>`);
    el = document.getElementById('overlayLiveSize');
  }
  el.textContent = `📐 ${_formatOverlaySize(m)}`;
  // Keep the type-in Width/Length boxes in step too (unless being typed in).
  if (m.kind === 'rect') {
    const w = document.getElementById('overlayResizeWidthInput');
    const l = document.getElementById('overlayResizeLengthInput');
    if (w && document.activeElement !== w) w.value = m.width.toFixed(2);
    if (l && document.activeElement !== l) l.value = m.length.toFixed(2);
  }
}

function _hideLiveSize() {
  const el = document.getElementById('overlayLiveSize');
  if (el) el.remove();
}

// Write the measured size back into the feature's own properties so the popup,
// the saved GeoJSON and later exports all agree with the reshaped geometry.
// Replaces the properties object rather than editing it in place: the pre-edit
// snapshot (used by Cancel) shares the old object and must keep the old values.
function _refreshSizePropsFromGeometry(layer) {
  const m = _overlaySizeMetrics(layer);
  if (!m || !layer.feature || !layer.feature.properties) return;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const p = { ...layer.feature.properties };
  if (m.kind === 'rect' && 'Width_m' in p) {
    p.Width_m = r3(m.width);
    if ('Length_m' in p) p.Length_m = r3(m.length);
    if ('Area_m2' in p) p.Area_m2 = r3(m.area);
  } else if (m.kind === 'line' && 'Length_m' in p) {
    p.Length_m = r3(m.length);
  } else {
    return;
  }
  layer.feature.properties = p;
  const layerId = layer._overlayLayerId;
  layer.setPopupContent(_overlayFeaturePopupHtml(layer.feature, layer, overlayLayers[layerId]?.color));
}

function _restoreLayerFromGeoJSON(layer, geojson) {
  const geom = geojson && geojson.geometry ? geojson.geometry : geojson;
  if (!geom) return;
  // Cancel / revert must also bring back the pre-edit size properties.
  if (geojson && geojson.properties && layer.feature) {
    layer.feature.properties = { ...geojson.properties };
  }
  const tempLayer = L.geoJSON(geom).getLayers()[0];
  if (!tempLayer) return;
  if (layer.setLatLngs && tempLayer.getLatLngs) {
    layer.setLatLngs(tempLayer.getLatLngs());
    _resyncEditingLatLngs(layer);
  } else if (layer.setLatLng && tempLayer.getLatLng) {
    layer.setLatLng(tempLayer.getLatLng());
  }
}

async function saveOverlayEdit() {
  if (!_overlayEditSession) return;
  const session = _overlayEditSession;

  try {
    // A dblclick during this session may have left vertex-edit handles live
    // (the 'edit' handler only auto-disables after an actual vertex drag) —
    // clear them before relocking, or a live handle could still mutate a
    // "locked" feature's geometry with no session to catch it.
    session.items.forEach(({ layer: l }) => {
      if (l.editing && l.editing.enabled()) {
        l.editing.disable();
        _removeStaleEditHandles(l);
      }
      if (l._catExitEdit) {
        document.removeEventListener('keydown', l._catExitEdit, true);
        l._catExitEdit = null;
      }
    });
    // allSettled, not all: with several features selected, one failed PUT
    // used to reject the batch after the others had already saved + relocked,
    // and the finally below then threw away the session — leaving the failed
    // features selected and unlocked with edited geometry, no snapshot and no
    // edit bar, so the user could neither retry Save nor Cancel.
    const results = await Promise.allSettled(session.items.map(({ layerId, featureId, layer: l }) =>
      saveFeatureGeometry(featureId, layerId, l.toGeoJSON(), { relock: true, silent: true }).then(() => {
        l._catLocked = true;
        l.setStyle({ dashArray: null });
        const layerColor = overlayLayers[layerId]?.color;
        l.setPopupContent(_overlayFeaturePopupHtml(l.feature, l, layerColor));
      })
    ));
    const failed = session.items.filter((_, i) => results[i].status === 'rejected');
    if (failed.length === 0) {
      clearFeatureSelection();
      _overlayEditSession = null;
      _closeOverlayEditBarDom();
      if (typeof showStatus === 'function') showStatus('✅ Changes saved', 'success');
    } else {
      // Drop only the features that did save; keep the failed ones selected,
      // unlocked and in the session (with their snapshots) so Save can be
      // retried or Cancel can revert them.
      session.items.forEach((it, i) => {
        if (results[i].status !== 'fulfilled') return;
        const sel = _selectedFeatures.get(`${it.layerId}:${it.featureId}`);
        if (sel) _setFeatureSelectedStyle(sel.layer, false);
        _selectedFeatures.delete(`${it.layerId}:${it.featureId}`);
        delete session.snapshots[it.featureId];
      });
      session.items = failed;
      _overlayEditSession = session;
      _refreshSelectionToolbar();
      _refreshOverlayEditBar();
      const firstErr = results.find(r => r.status === 'rejected').reason;
      console.error('Error saving overlay edit:', firstErr);
      if (typeof showStatus === 'function') {
        showStatus(`❌ ${failed.length} feature(s) failed to save (${(firstErr && firstErr.message) || 'error'}) — they are still selected; click Save to retry or Cancel to revert`, 'error');
      }
    }
  } catch (error) {
    // Unexpected error before/while dispatching saves: keep the session so the
    // user can still Save/Cancel instead of stranding unlocked features.
    console.error('Error saving overlay edit:', error);
    if (typeof showStatus === 'function') showStatus(`❌ Failed to save: ${error.message}`, 'error');
  }
}

async function cancelOverlayEdit() {
  if (!_overlayEditSession) return;
  const session = _overlayEditSession;

  try {
    await Promise.all(session.items.map(({ layerId, featureId, layer: l }) => {
      if (l.editing && l.editing.enabled()) {
        l.editing.disable();
        _removeStaleEditHandles(l);
      }
      if (l._catExitEdit) {
        document.removeEventListener('keydown', l._catExitEdit, true);
        l._catExitEdit = null;
      }
      const snap = session.snapshots[featureId];
      if (snap) _restoreLayerFromGeoJSON(l, snap);
      l.setStyle({ color: overlayLayers[layerId]?.color, weight: overlayLayers[layerId]?.borderWidth || 2, dashArray: null });
      l._catLocked = true;
      const layerColor = overlayLayers[layerId]?.color;
      l.setPopupContent(_overlayFeaturePopupHtml(l.feature, l, layerColor));
      return fetch(
        `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}/features/${featureId}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_locked: 1 }) }
      );
    }));
    clearFeatureSelection();
    if (typeof showStatus === 'function') showStatus('↩️ Edit cancelled', 'info');
  } catch (error) {
    console.error('Error cancelling overlay edit:', error);
    if (typeof showStatus === 'function') showStatus(`❌ Failed to cancel cleanly: ${error.message}`, 'error');
  } finally {
    _overlayEditSession = null;
    _closeOverlayEditBarDom();
  }
}

// ── Resize (segments) — a quick numeric alternative to hand-dragging
// vertices for the common "just make it wider/narrower" case. Doesn't
// replace vertex editing (double-click still works for reshaping); this is
// a small atomic popup (its own fetch, not part of the drag session) that
// recomputes the whole rectangle server-side, keeping the transect chord fixed.
function openOverlayResizeById(layerId, featureId) {
  const layer = _findOverlayFeatureLayer(layerId, featureId);
  if (!layer) return;
  _openResizePopup(layer, layer.feature, overlayLayers[layerId]?.color);
}

function _openResizePopup(layer, feature, layerColor) {
  const props = (feature && feature.properties) || {};
  if (!('Width_m' in props)) {
    if (typeof showStatus === 'function') {
      showStatus('📏 This segment has no stored width — resize only works for segments created by "Generate Transect"', 'warning');
    }
    return;
  }
  const hasLength = 'Length_m' in props;
  _closeResizePopupDom();
  document.body.insertAdjacentHTML('beforeend', `
    <div id="overlayResizePopup" style="position:fixed; bottom:70px; left:50%; transform:translateX(-50%);
      z-index:10000; background:#232323; border:1px solid #444; border-radius:6px; padding:10px 14px;
      color:#eee; box-shadow:0 4px 16px rgba(0,0,0,0.4); font-size:12px; display:flex; align-items:center; gap:8px;">
      <span>📏 Width (m):</span>
      <input type="number" id="overlayResizeWidthInput" value="${props.Width_m}" min="0.1" step="0.1"
             style="width:70px; font-size:12px; padding:2px 4px;">
      ${hasLength ? `
      <span>Length (m):</span>
      <input type="number" id="overlayResizeLengthInput" value="${props.Length_m}" min="0.1" step="0.1"
             style="width:70px; font-size:12px; padding:2px 4px;">
      ` : ''}
      <button class="btn btn-primary btn-sm" onclick="_applyOverlayResize(${layer._overlayLayerId}, ${layer._overlayFeatureId})">✅ Apply</button>
      <button class="btn btn-secondary btn-sm" onclick="_closeResizePopupDom()">✖ Cancel</button>
    </div>
  `);
  const input = document.getElementById('overlayResizeWidthInput');
  if (input) input.focus();
}

function _closeResizePopupDom() {
  const el = document.getElementById('overlayResizePopup');
  if (el) el.remove();
}

async function _applyOverlayResize(layerId, featureId) {
  const widthInput = document.getElementById('overlayResizeWidthInput');
  const lengthInput = document.getElementById('overlayResizeLengthInput');
  const widthM = widthInput ? parseFloat(widthInput.value) : NaN;
  if (!isFinite(widthM) || widthM <= 0) {
    if (typeof showStatus === 'function') showStatus('⚠️ Enter a width greater than 0', 'warning');
    return;
  }
  let lengthM = null;
  if (lengthInput) {
    lengthM = parseFloat(lengthInput.value);
    if (!isFinite(lengthM) || lengthM <= 0) {
      if (typeof showStatus === 'function') showStatus('⚠️ Enter a length greater than 0', 'warning');
      return;
    }
  }
  const layer = _findOverlayFeatureLayer(layerId, featureId);
  if (!layer) { _closeResizePopupDom(); return; }
  try {
    const body = { width_m: widthM };
    if (lengthM !== null) body.length_m = lengthM;
    const resp = await fetch(
      `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layerId}/features/${featureId}/width`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || 'Failed to resize');
    }
    const data = await resp.json();
    if (data.feature && data.feature.feature) {
      // The resize popup can now be opened while vertex-editing is still
      // live (it auto-opens on double-click). Its handles were built from
      // the pre-resize corners and _resyncEditingLatLngs only swaps the
      // cached array reference, it doesn't move markers that already
      // exist on screen — end the vertex-edit session outright rather
      // than leave dangling handles at the old rectangle's corners.
      if (layer.editing && layer.editing.enabled()) {
        layer.editing.disable();
        _removeStaleEditHandles(layer);
        layer.setStyle({ color: overlayLayers[layerId]?.color, dashArray: '3,3' });
        if (layer._catExitEdit) {
          document.removeEventListener('keydown', layer._catExitEdit, true);
          layer._catExitEdit = null;
        }
      }
      _restoreLayerFromGeoJSON(layer, data.feature.feature);
      layer.feature = data.feature.feature;
      // If this feature is mid-session, its snapshot must move forward too —
      // otherwise a later Cancel would silently undo a resize that already
      // round-tripped to the database.
      if (_overlayEditSession && _overlayEditSession.snapshots[featureId]) {
        _overlayEditSession.snapshots[featureId] = data.feature.feature;
      }
      layer.setPopupContent(_overlayFeaturePopupHtml(layer.feature, layer, overlayLayers[layerId]?.color));
    }
    if (typeof showStatus === 'function') showStatus('✅ Segment resized', 'success');
  } catch (error) {
    console.error('Error resizing segment:', error);
    if (typeof showStatus === 'function') showStatus(`❌ ${error.message}`, 'error');
  } finally {
    _closeResizePopupDom();
    _hideLiveSize();
  }
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
    // Consume it: the global Escape handler in annotation-runtime-shell-init.js
    // would otherwise ALSO run and silently discard any unsaved annotation the
    // user has open, just because they cancelled a transect.
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
    // This transect line is built by a custom click-collector, not Leaflet.Draw
    // (catGetActiveDrawVertexHandler, used elsewhere, only knows about the
    // latter) — without this, Ctrl+Z while placing transect points fell
    // through to the global handler and undid a previously SAVED annotation
    // instead of the point just placed, leaving the bad point on the
    // in-progress line untouched. Same fix as the Leaflet.Draw case, just a
    // separate state machine. Backspace gets the same treatment for
    // consistency with every other draw tool's convention.
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
    _removeLastTransectPoint();
  } else if (e.key === 'Backspace') {
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
    _removeLastTransectPoint();
  } else if (e.key === 'Enter') {
    // This listener is document-wide (capture): Enter while typing in a form
    // field (segment count/length in the generate panel, the annotation form,
    // a filter box...) must edit that field, not finish the transect.
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing) return;
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

// Ctrl+Z / Backspace mid-draw — remove the most recently placed point,
// mirroring the "delete last vertex" convention the Leaflet.Draw-based
// tools already have.
function _removeLastTransectPoint() {
  const state = _transectDrawState;
  if (!state || state.points.length === 0) {
    if (typeof showStatus === 'function') showStatus('Nothing to remove — no points placed yet', 'info');
    return;
  }
  state.points.pop();
  const marker = state.markers.pop();
  if (marker) map.removeLayer(marker);

  // _updateTransectPolyline only (re)draws once >= 2 points remain — below
  // that, the existing line would otherwise keep showing the segment that
  // used to end at the point we just removed.
  if (state.points.length < 2 && state.polyline) {
    map.removeLayer(state.polyline);
    state.polyline = null;
  } else {
    _updateTransectPolyline();
  }
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
  window.setOverlayBorderWidth = setOverlayBorderWidth;
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
  window.selectOverlayFeatureById = selectOverlayFeatureById;
  window.selectAllFeaturesInLayer = selectAllFeaturesInLayer;
  window.saveOverlayEdit = saveOverlayEdit;
  window.cancelOverlayEdit = cancelOverlayEdit;
  window.toggleFeatureSelection = toggleFeatureSelection;
  window.clearFeatureSelection = clearFeatureSelection;
  window._onFeatureRowToggle = _onFeatureRowToggle;
  window._panToOverlayFeature = _panToOverlayFeature;
  window._toggleFeatureListVisibility = _toggleFeatureListVisibility;
  window._applyOverlayResize = _applyOverlayResize;
  window._closeResizePopupDom = _closeResizePopupDom;
  window.openOverlayResizeById = openOverlayResizeById;
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
          ${catEscHtml(layer.layer_name)}
          ${layer.layer_type ? `<span style="font-size:9px;color:#fff;background:${layer.layer_type === 'transect' ? '#ff8c00' : '#1e90ff'};border-radius:3px;padding:1px 5px;margin-left:5px;text-transform:uppercase;">${catEscHtml(layer.layer_type)}</span>` : ''}
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
  // Saving reloads every overlay from the server, which discards an
  // in-progress move/rotate/vertex edit. Don't do that silently.
  if (_overlayEditSession && _overlayEditSession.dirty) {
    const proceed = await catConfirm(
      'You have unsaved feature edits. Saving layer settings reloads the layers and will discard them. Continue?',
      { danger: true, ok: 'Discard edits and save' }
    );
    if (!proceed) return;
  }
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
    const failedNames = [];
    for (const layer of managementLayers) {
      const resp = await fetch(
        `${window.location.origin}/api/db/projects/${currentProjectId}/overlay-layers/${layer.layer_id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: layer.is_active })
        }
      );
      if (!resp.ok) failedNames.push(layer.layer_name || `#${layer.layer_id}`);
    }
    if (failedNames.length) {
      // Keep the modal open so nothing looks saved when it wasn't.
      throw new Error(`Could not update: ${failedNames.join(', ')}`);
    }

    showStatus('✅ Layer settings saved', 'success');
    closeLayerManagementModal();

    // Reload layers on map
    await loadExistingOverlays(currentProjectId);

  } catch (error) {
    console.error('Error saving layer management:', error);
    showStatus(`❌ Failed to save changes${error && error.message ? ` (${error.message})` : ''}`, 'error');
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
  
  // A drop that didn't start from one of our rows (a file, text, another
  // window) leaves draggedItem null.
  if (!draggedItem) return;
  const targetItem = e.target.closest('.layer-management-item');
  if (!targetItem || targetItem === draggedItem) return;

  const draggedIndex = parseInt(draggedItem.dataset.index);
  const targetIndex = parseInt(targetItem.dataset.index);

  // Reorder array. The drop indicator is a line above the target row, so
  // insert *before* it: after the splice below removes the dragged row, every
  // later index shifts down by one when dragging downward.
  const [removed] = managementLayers.splice(draggedIndex, 1);
  const insertAt = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
  managementLayers.splice(insertAt, 0, removed);

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

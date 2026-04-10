/* ================================================
   CAT - Coral Annotation Tool
   Form Management (Validation, Autocomplete, Save/Update)
   ================================================ */

// Species autocomplete state
let autocompleteResults = [];
let autocompleteSelectedIndex = -1;
let editAutocompleteResults = [];
let editAutocompleteSelectedIndex = -1;

/**
 * Setup form event handlers
 */
function setupFormHandlers() {
  // Save annotation button
  const saveBtn = document.getElementById('saveAnnotationBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveAnnotation);
  }
  
  // Species autocomplete
  setupSpeciesAutocomplete();
  
  // JUV_SUBSTRATE autocomplete
  setupJuvSubstrateAutocomplete();
  
  console.log('✅ Form handlers registered');
}

/**
 * Setup species autocomplete functionality
 */
function setupSpeciesAutocomplete() {
  const speciesInput = document.getElementById('spcode');
  const dropdown = document.getElementById('species-autocomplete');
  
  if (!speciesInput || !dropdown) {
    console.warn('Species autocomplete elements not found');
    return;
  }
  
  // Input handler with debouncing
  let debounceTimer;
  speciesInput.addEventListener('input', function(e) {
    const query = e.target.value.trim();
    
    clearTimeout(debounceTimer);
    
    if (query.length < 2) {
      dropdown.classList.remove('active');
      autocompleteSelectedIndex = -1;
      return;
    }
    
    debounceTimer = setTimeout(() => {
      searchSpecies(query);
    }, 150);
  });
  
  // Keyboard navigation
  speciesInput.addEventListener('keydown', function(e) {
    if (!dropdown.classList.contains('active')) return;
    
    const items = dropdown.querySelectorAll('.autocomplete-item');
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      autocompleteSelectedIndex = Math.min(autocompleteSelectedIndex + 1, items.length - 1);
      updateAutocompleteSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      autocompleteSelectedIndex = Math.max(autocompleteSelectedIndex - 1, -1);
      updateAutocompleteSelection(items);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (autocompleteSelectedIndex >= 0 && autocompleteSelectedIndex < autocompleteResults.length) {
        e.preventDefault();
        selectSpecies(autocompleteResults[autocompleteSelectedIndex]);
      }
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('active');
      autocompleteSelectedIndex = -1;
    }
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', function(e) {
    if (!speciesInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('active');
      autocompleteSelectedIndex = -1;
    }
  });
}

/**
 * Search species from API
 * @param {string} query - Search query
 */
function searchSpecies(query) {
  const dropdown = document.getElementById('species-autocomplete');
  
  dropdown.innerHTML = '<div class="autocomplete-loading">Searching...</div>';
  dropdown.classList.add('active');
  
  const filterQs = typeof window.getSpeciesFilterQueryString === 'function' ? window.getSpeciesFilterQueryString() : '';
  const sep = filterQs ? '&' : '';
  fetch(`/api/coral/species/search?q=${encodeURIComponent(query)}&limit=10${sep}${filterQs}`)
    .then(res => res.json())
    .then(data => {
      autocompleteResults = data.results || [];
      
      if (autocompleteResults.length === 0) {
        dropdown.innerHTML = '<div class="autocomplete-empty">No species found</div>';
        autocompleteSelectedIndex = -1;
      } else {
        autocompleteSelectedIndex = 0;
        
        dropdown.innerHTML = autocompleteResults.map((species, index) => `
          <div class="autocomplete-item ${index === 0 ? 'selected' : ''}" 
               data-index="${index}" 
               onclick="selectSpeciesByIndex(${index})">
            <div class="autocomplete-code">${species.code}</div>
            <div class="autocomplete-name">${species.taxon_name || species.genus}</div>
            ${species.scientific_name ? `<div class="autocomplete-sci">${species.scientific_name}</div>` : ''}
          </div>
        `).join('');
      }
      
      dropdown.classList.add('active');
    })
    .catch(err => {
      console.error('Species search error:', err);
      dropdown.innerHTML = '<div class="autocomplete-empty">Search failed</div>';
    });
}

/**
 * Update autocomplete selection highlighting
 * @param {NodeList} items - Dropdown items
 */
function updateAutocompleteSelection(items) {
  items.forEach((item, index) => {
    if (index === autocompleteSelectedIndex) {
      item.classList.add('selected');
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.classList.remove('selected');
    }
  });
}

/**
 * Select species by index (called from onclick)
 * @param {number} index - Species index in results
 */
function selectSpeciesByIndex(index) {
  if (index >= 0 && index < autocompleteResults.length) {
    selectSpecies(autocompleteResults[index]);
  }
}

/**
 * Select species and fill form field
 * @param {Object} species - Species object
 */
function selectSpecies(species) {
  const speciesInput = document.getElementById('spcode');
  const dropdown = document.getElementById('species-autocomplete');
  
  if (speciesInput) {
    speciesInput.value = species.code;
  }
  
  dropdown.classList.remove('active');
  autocompleteSelectedIndex = -1;
  
  console.log('✅ Species selected:', species.code);
  
  // Focus next field (morphology) to continue workflow
  const morphField = document.getElementById('morph_code');
  if (morphField) {
    morphField.focus();
  }
}

// =========================================================================
// JUV_SUBSTRATE AUTOCOMPLETE
// =========================================================================

const JUV_SUBSTRATE_OPTIONS = [
  'CCAH', 'CCAR', 'TURFH', 'TURFR', 'EMA', 'PESP', 'LOBO', 'HARD', 'CORAL', 'RUB', 'HALI'
];

let juvSubstrateAutocompleteResults = [];
let juvSubstrateAutocompleteSelectedIndex = -1;

/**
 * Setup JUV_SUBSTRATE autocomplete functionality
 */
function setupJuvSubstrateAutocomplete() {
  const juvSubstrateInput = document.getElementById('juv_substrate');
  const dropdown = document.getElementById('juv-substrate-autocomplete');
  
  if (!juvSubstrateInput || !dropdown) {
    console.warn('JUV_SUBSTRATE autocomplete elements not found');
    return;
  }
  
  // Input handler with debouncing
  let debounceTimer;
  juvSubstrateInput.addEventListener('input', function(e) {
    const query = e.target.value.trim().toUpperCase();
    
    clearTimeout(debounceTimer);
    
    if (query.length === 0) {
      dropdown.classList.remove('active');
      juvSubstrateAutocompleteSelectedIndex = -1;
      return;
    }
    
    debounceTimer = setTimeout(() => {
      searchJuvSubstrate(query);
    }, 200);
  });
  
  // Keyboard navigation
  juvSubstrateInput.addEventListener('keydown', function(e) {
    if (!dropdown.classList.contains('active')) return;
    
    const items = dropdown.querySelectorAll('.autocomplete-item');
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      juvSubstrateAutocompleteSelectedIndex = Math.min(juvSubstrateAutocompleteSelectedIndex + 1, items.length - 1);
      updateJuvSubstrateAutocompleteSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      juvSubstrateAutocompleteSelectedIndex = Math.max(juvSubstrateAutocompleteSelectedIndex - 1, -1);
      updateJuvSubstrateAutocompleteSelection(items);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (juvSubstrateAutocompleteSelectedIndex >= 0 && juvSubstrateAutocompleteSelectedIndex < juvSubstrateAutocompleteResults.length) {
        e.preventDefault();
        selectJuvSubstrate(juvSubstrateAutocompleteResults[juvSubstrateAutocompleteSelectedIndex]);
      }
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('active');
      juvSubstrateAutocompleteSelectedIndex = -1;
    }
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', function(e) {
    if (!juvSubstrateInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('active');
      juvSubstrateAutocompleteSelectedIndex = -1;
    }
  });
}

/**
 * Search JUV_SUBSTRATE options
 * @param {string} query - Search query
 */
function searchJuvSubstrate(query) {
  const dropdown = document.getElementById('juv-substrate-autocomplete');
  
  // Filter options based on query
  juvSubstrateAutocompleteResults = JUV_SUBSTRATE_OPTIONS.filter(option => 
    option.includes(query)
  );
  
  if (juvSubstrateAutocompleteResults.length === 0) {
    juvSubstrateAutocompleteSelectedIndex = -1;
    dropdown.innerHTML = '<div class="autocomplete-empty">No substrate found</div>';
  } else {
    // Auto-select first item
    juvSubstrateAutocompleteSelectedIndex = 0;
    
    dropdown.innerHTML = juvSubstrateAutocompleteResults.map((substrate, index) => `
      <div class="autocomplete-item ${index === 0 ? 'selected' : ''}" 
           data-index="${index}" 
           onclick="selectJuvSubstrateByIndex(${index})">
        <div class="autocomplete-code">${substrate}</div>
      </div>
    `).join('');
  }
  
  dropdown.classList.add('active');
}

/**
 * Update autocomplete selection visual state
 * @param {NodeList} items - Autocomplete items
 */
function updateJuvSubstrateAutocompleteSelection(items) {
  items.forEach((item, index) => {
    if (index === juvSubstrateAutocompleteSelectedIndex) {
      item.classList.add('selected');
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.classList.remove('selected');
    }
  });
}

/**
 * Select JUV_SUBSTRATE by index (called from onclick)
 * @param {number} index - Index in results array
 */
function selectJuvSubstrateByIndex(index) {
  if (index >= 0 && index < juvSubstrateAutocompleteResults.length) {
    selectJuvSubstrate(juvSubstrateAutocompleteResults[index]);
  }
}

/**
 * Select JUV_SUBSTRATE and fill form field
 * @param {string} substrate - Substrate code
 */
function selectJuvSubstrate(substrate) {
  const juvSubstrateInput = document.getElementById('juv_substrate');
  const dropdown = document.getElementById('juv-substrate-autocomplete');
  
  if (juvSubstrateInput) {
    juvSubstrateInput.value = substrate;
  }
  
  dropdown.classList.remove('active');
  juvSubstrateAutocompleteSelectedIndex = -1;
  
  console.log('✅ JUV_SUBSTRATE selected:', substrate);
  
  // Focus next field (remnant) to continue workflow
  const remnantField = document.getElementById('remnant');
  if (remnantField) {
    remnantField.focus();
  }
}

/**
 * Save annotation from form
 */
async function saveAnnotation() {
  const currentAnnotation = getCurrentAnnotation();
  
  if (!currentAnnotation) {
    showStatus('Please draw a shape first', 'error');
    return;
  }
  
  // Validate required fields with visual feedback
  const requiredFields = ['analyst', 'obs_year', 'mission_id', 'site'];
  if (typeof catValidateRequired === 'function' && !catValidateRequired(requiredFields)) {
    showStatus('Please fill in all required fields (highlighted in red)', 'error');
    return;
  }
  const missingFields = requiredFields.filter(id => {
    const f = document.getElementById(id);
    return !f || !f.value.trim();
  });
  if (missingFields.length > 0) {
    showStatus('Please fill in all required fields (marked with *)', 'error');
    return;
  }
  
  // Get geometry with full precision
  const layer = currentAnnotation.layer || currentAnnotation;
  const geometry = getFullPrecisionGeometry(layer);
  
  // Get annotation time
  const annotationTimeSeconds = getAnnotationTime();
  
  // Build annotation data
  const annotationData = buildAnnotationData(geometry, currentAnnotation.type, annotationTimeSeconds);
  
  // Set initial sync status; capture layer ref before any async operations (Fix 1b, 1e)
  annotationData._syncStatus = 'pending';
  const savedLayer = layer;

  try {
    // Attach data to layer
    layer.annotationData = annotationData;
    
    // Change layer style from drawing color to saved annotation color (orange if incomplete)
    if (layer.setStyle) {
      layer.setStyle(getAnnotationLayerStyle(annotationData));
    }
    
    // Add to project
    addAnnotationToProject(annotationData);
    const savedIndex = getProjectAnnotations().length - 1;
    
    // Update table
    updateAnnotationTable();
    
    // Add click handler for editing
    layer.off('click');
    layer.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      showAnnotationPopup(layer, e.latlng);
    });
    
    // Add label if enabled (labels are visible by default)
    // Check both window.labelsVisible and call addLabelToAnnotation directly
    const shouldShowLabels = window.labelsVisible !== false; // Default to true
    console.log('💾 Save annotation - adding label. labelsVisible:', shouldShowLabels);
    if (shouldShowLabels && typeof addLabelToAnnotation === 'function') {
      addLabelToAnnotation(layer);
    } else {
      console.warn('⚠️ Label not added. labelsVisible:', shouldShowLabels, 'addLabelToAnnotation exists:', typeof addLabelToAnnotation === 'function');
    }
    
    // Clear form and reset state
    clearAnnotationForm();
    setCurrentAnnotation(null);
    if (typeof hideDiscardButton === 'function') hideDiscardButton();

    // Increment count and reset timer
    incrementAnnotationCount();
    resetAnnotationTimer();
    
    // Mark unsaved changes
    markUnsavedChanges();

    // In Oracle mode, persist immediately and attach DB ID
    if (typeof isOracleProjectMode === 'function' && isOracleProjectMode() && typeof syncAnnotationToDb === 'function') {
      try {
        const synced = await syncAnnotationToDb(annotationData);
        synced._syncStatus = 'synced';
        applySyncedAnnotation(savedIndex, synced);
        savedLayer.annotationData = synced; // direct layer ref — reliable even after rapid annotation (Fix 1b)
        // Push to undo stack after successful DB sync (5d)
        if (typeof undoPushAdd === 'function') undoPushAdd(synced, savedLayer);
      } catch (dbError) {
        console.error('DB annotation create failed:', dbError);
        annotationData._syncStatus = 'error';
        savedLayer.annotationData = annotationData;
        showStatus(`⚠️ Saved locally, DB sync failed: ${dbError.message}`, 'error');
        // Still push to undo stack for local-only add (5d)
        if (typeof undoPushAdd === 'function') undoPushAdd(annotationData, savedLayer);
      }
    } else {
      // Non-Oracle mode: push immediately
      if (typeof undoPushAdd === 'function') undoPushAdd(annotationData, savedLayer);
    }
    
    // Show success
    const projectAnnotations = getProjectAnnotations();
    showStatus(`✅ Annotation saved! Total: ${projectAnnotations.length} (${formatTime(annotationTimeSeconds)})`, 'success');
    console.log('💾 Annotation saved:', annotationData);
    
    // Auto-focus species field for next annotation
    setTimeout(() => {
      const speciesField = document.getElementById('spcode');
      if (speciesField) {
        speciesField.focus();
      }
    }, 100);
    
    // Re-enable drawing tool after brief delay
    setTimeout(() => {
      enableLastDrawingTool();
    }, 150);
    
  } catch (error) {
    console.error('Error saving annotation:', error);
    showStatus(`❌ Error: ${error.message}`, 'error');
  }
}

/**
 * Build annotation data object from form fields
 * @param {Object} geometry - GeoJSON geometry
 * @param {string} type - Annotation type
 * @param {number} timeSeconds - Time spent on annotation
 * @returns {Object} Annotation data
 */
function buildAnnotationData(geometry, type, timeSeconds) {
  const getFieldValue = (id, defaultValue = null) => {
    const element = document.getElementById(id);
    if (!element) {
      console.warn(`Field '${id}' not found in form`);
      return defaultValue;
    }
    return element.value || defaultValue;
  };
  
  const getIntValue = (id, defaultValue = 0) => {
    const value = getFieldValue(id);
    return value ? parseInt(value) : defaultValue;
  };
  
  const getFloatValue = (id, defaultValue = null) => {
    const value = getFieldValue(id);
    return value ? parseFloat(value) : defaultValue;
  };
  
  return {
    geometry: geometry,
    type: type || 'polygon',
    analyst: getFieldValue('analyst'),
    obs_year: getIntValue('obs_year'),
    mission_id: getFieldValue('mission_id'),
    site: getFieldValue('site'),
    transect: getFieldValue('transect'),
    segment: getIntValue('segment'),
    seglength: getFloatValue('seglength'),
    segwidth: getFloatValue('segwidth'),
    no_colony: getIntValue('no_colony', 0),
    spcode: getFieldValue('spcode'),
    juvenile: getIntValue('juvenile', 0),
    juv_substrate: getFieldValue('juv_substrate'),
    remnant: getIntValue('remnant', 0),
    fragment: getIntValue('fragment', 0),
    morph_code: getFieldValue('morph_code'),
    ex_bound: getIntValue('ex_bound', 0),
    old_dead: getIntValue('olddead'),
    rdcause1: getFieldValue('rdcause1'),
    rd_1: getIntValue('rd_1'),
    rdcause2: getFieldValue('rdcause2'),
    rd_2: getIntValue('rd_2'),
    rdcause3: getFieldValue('rdcause3'),
    rd_3: getIntValue('rd_3'),
    con_1: getFieldValue('con_1'),
    extent_1: getIntValue('extent_1'),
    sev_1: getIntValue('sev_1'),
    con_2: getFieldValue('con_2'),
    extent_2: getIntValue('extent_2'),
    sev_2: getIntValue('sev_2'),
    con_3: getFieldValue('con_3'),
    extent_3: getIntValue('extent_3'),
    sev_3: getIntValue('sev_3'),
    created_at: new Date().toISOString(),
    annotation_time_seconds: timeSeconds
  };
}

/**
 * Clear annotation form (preserve key fields)
 */
function clearAnnotationForm() {
  const clearField = (id, defaultValue = '') => {
    const element = document.getElementById(id);
    if (element) {
      element.value = defaultValue;
    }
  };
  
  // Preserve: analyst, obs_year, mission_id, site
  // Clear all annotation-specific fields
  clearField('transect');
  clearField('segment');
  clearField('seglength');
  clearField('segwidth');
  clearField('no_colony', '0');
  clearField('spcode');
  clearField('juvenile', '0');
  clearField('juv_substrate');
  clearField('remnant', '0');
  clearField('fragment', '0');
  clearField('morph_code');
  clearField('ex_bound', '0');
  clearField('olddead');
  clearField('rdcause1');
  clearField('rd_1');
  clearField('rdcause2');
  clearField('rd_2');
  clearField('rdcause3');
  clearField('rd_3');
  clearField('con_1');
  clearField('extent_1');
  clearField('sev_1');
  clearField('con_2');
  clearField('extent_2');
  clearField('sev_2');
  clearField('con_3');
  clearField('extent_3');
  clearField('sev_3');
}

/**
 * Returns true if the annotation has the minimum required fields filled in.
 * Primary requirement: spcode must be set and non-trivial.
 */
function isAnnotationComplete(ann) {
  const sp = ann?.spcode;
  return sp && sp !== '-' && sp.trim() !== '';
}

/**
 * Return the Leaflet style for a layer based on annotation completeness.
 */
function getAnnotationLayerStyle(ann) {
  return isAnnotationComplete(ann)
    ? { color: '#3388ff', weight: 7, opacity: 0.8, fillOpacity: 0.3 }
    : { color: '#e67e22', weight: 7, opacity: 0.9, fillOpacity: 0.25, dashArray: '6 4' };
}

/**
 * Update annotation table display
 */
function updateAnnotationTable() {
  const tbody = document.getElementById('annotationTableBody');
  const countSpan = document.getElementById('annotationCount');
  
  if (!tbody) return;
  
  const projectAnnotations = getProjectAnnotations();
  
  // Update count
  if (countSpan) {
    countSpan.textContent = projectAnnotations.length;
  }

  // Update incomplete count badge
  const incompleteCount = projectAnnotations.filter(a => !isAnnotationComplete(a)).length;
  let incompleteBadge = document.getElementById('incompleteCountBadge');
  if (!incompleteBadge) {
    const filterDiv = document.getElementById('annotationTableFilter')?.parentElement;
    if (filterDiv) {
      incompleteBadge = document.createElement('span');
      incompleteBadge.id = 'incompleteCountBadge';
      incompleteBadge.style.cssText = 'font-size:11px;margin-left:8px;padding:2px 6px;border-radius:10px;display:none;';
      filterDiv.appendChild(incompleteBadge);
    }
  }
  if (incompleteBadge) {
    if (incompleteCount > 0) {
      incompleteBadge.textContent = `⚠️ ${incompleteCount} missing species`;
      incompleteBadge.style.display = 'inline';
      incompleteBadge.style.background = 'rgba(230,126,34,0.15)';
      incompleteBadge.style.color = '#c0392b';
    } else if (projectAnnotations.length > 0) {
      incompleteBadge.textContent = '✅ All complete';
      incompleteBadge.style.display = 'inline';
      incompleteBadge.style.background = 'rgba(40,167,69,0.1)';
      incompleteBadge.style.color = '#28a745';
    } else {
      incompleteBadge.style.display = 'none';
    }
  }
  
  // Clear table and reset any active filter (Fix 3c)
  tbody.innerHTML = '';
  const filterInput = document.getElementById('annotationTableFilter');
  if (filterInput) filterInput.value = '';
  
  if (projectAnnotations.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" style="text-align: center; padding: 20px; color: #6c757d;">
          No annotations yet - draw on the map to create one
        </td>
      </tr>
    `;
    return;
  }
  
  // Populate table
  const oracleMode = typeof isOracleProjectMode === 'function' && isOracleProjectMode();
  projectAnnotations.forEach((ann, index) => {
    const row = document.createElement('tr');
    row.dataset.index = index;

    // Store display index for reference
    ann._displayIndex = index + 1;

    const colonyId = ann.colony_id || ann.no_colony || (index + 1);

    // Sync status indicator — only shown in Oracle mode (Fix 2b)
    let syncDot = '';
    if (oracleMode) {
      const statusMap = {
        synced:    { dot: '',  title: 'Synced',          color: '' },
        pending:   { dot: '○', title: 'Pending sync',    color: '#888' },
        dirty:     { dot: '●', title: 'Unsaved edit',    color: '#e67e22' },
        error:     { dot: '⚠', title: 'Sync error',     color: '#e74c3c' },
        conflict:  { dot: '⚡', title: 'Version conflict', color: '#9b59b6' },
      };
      const s = statusMap[ann._syncStatus];
      if (s && s.dot) {
        syncDot = `<span title="${s.title}" style="margin-left:4px;font-size:10px;color:${s.color};vertical-align:middle;">${s.dot}</span>`;
      }
    }

    // Completeness indicator (5a)
    const completeDot = isAnnotationComplete(ann)
      ? ''
      : `<span title="Missing species code" style="margin-left:3px;font-size:10px;color:#e67e22;vertical-align:middle;">⚠</span>`;

    row.innerHTML = `
      <td><strong style="cursor: pointer; color: #1976d2;">${colonyId}</strong>${syncDot}${completeDot}</td>
      <td style="display: none;">${ann.geometry?.type || 'Polygon'}</td>
      <td class="editable" data-field="site" data-index="${index}">${ann.site || '-'}</td>
      <td class="editable" data-field="spcode" data-index="${index}">${ann.spcode || '-'}</td>
      <td class="editable" data-field="juvenile" data-index="${index}">${ann.juvenile == -1 ? 'Yes' : (ann.juvenile == 0 ? 'No' : '-')}</td>
      <td class="editable" data-field="juv_substrate" data-index="${index}">${ann.juv_substrate || '-'}</td>
      <td class="editable" data-field="analyst" data-index="${index}" style="display: none;">${ann.analyst || '-'}</td>
      <td class="editable" data-field="obs_year" data-index="${index}" style="display: none;">${ann.obs_year || '-'}</td>
      <td class="editable" data-field="mission_id" data-index="${index}" style="display: none;">${ann.mission_id || '-'}</td>
      <td class="editable" data-field="segment" data-index="${index}">${ann.segment || '-'}</td>
      <td class="editable" data-field="transect" data-index="${index}">${ann.transect || '-'}</td>
      <td class="editable" data-field="morph_code" data-index="${index}">${ann.morph_code || '-'}</td>
      <td class="editable" data-field="old_dead" data-index="${index}" style="display: none;">${ann.old_dead !== undefined ? ann.old_dead + '%' : '-'}</td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); openEditModal(${index})" title="Edit Fields">✏️</button>
        <button class="btn btn-sm btn-success" onclick="event.stopPropagation(); enableGeometryEdit(${index})" title="Edit Geometry">📐</button>
        <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteAnnotation(${index})" title="Delete">🗑️</button>
      </td>
    `;
    
    // Add click handler for row selection - zoom to annotation
    row.onclick = (e) => {
      // Don't trigger if clicking buttons or editable cells
      if (e.target.closest('button') || e.target.classList.contains('editable')) {
        return;
      }
      
      // Highlight selected row
      document.querySelectorAll('.annotation-table tbody tr').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      
      // Zoom to annotation
      selectAnnotationForEdit(index);
    };
    
    // Add double-click handlers to editable cells
    row.querySelectorAll('.editable').forEach(cell => {
      cell.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        makeTableCellEditable(cell);
      });
    });
    
    tbody.appendChild(row);
  });
}

/**
 * Apply synced DB annotation to project + map layer
 * @param {number} index - Annotation index
 * @param {Object} syncedAnnotation - Normalized annotation from DB
 */
function applySyncedAnnotation(index, syncedAnnotation) {
  if (index < 0 || !syncedAnnotation) return;

  updateAnnotationInProject(index, syncedAnnotation);

  const drawnItems = getDrawnItems();
  if (!drawnItems) return;

  drawnItems.eachLayer(layer => {
    if (!layer.annotationData) return;
    if (layer.annotationData._displayIndex === index + 1 || layer.annotationData === syncedAnnotation) {
      layer.annotationData = syncedAnnotation;
      // Refresh map style to reflect completeness (5a)
      if (layer.setStyle) layer.setStyle(getAnnotationLayerStyle(syncedAnnotation));
    }
  });
}

/**
 * Sync one annotation by index to DB in Oracle mode
 * @param {number} index - Annotation index
 */
async function syncAnnotationIndexToDb(index) {
  if (typeof isOracleProjectMode !== 'function' || !isOracleProjectMode()) return;
  if (typeof syncAnnotationToDb !== 'function') return;

  const projectAnnotations = getProjectAnnotations();
  const annotation = projectAnnotations[index];
  if (!annotation) return;

  try {
    const synced = await syncAnnotationToDb(annotation);
    synced._syncStatus = 'synced';
    applySyncedAnnotation(index, synced);
  } catch (err) {
    if (err.isConflict) {
      annotation._syncStatus = 'conflict';
      updateAnnotationTable();
      showStatus(`⚠️ Conflict: ${err.message}`, 'error');
      return;
    }
    throw err;
  }
}

/**
 * Select annotation for editing (zoom and highlight)
 * @param {number} index - Annotation index
 */
function selectAnnotationForEdit(index) {
  console.log('🎯 Selecting annotation for edit:', index);
  
  const projectAnnotations = getProjectAnnotations();
  const ann = projectAnnotations[index];
  
  if (!ann) {
    console.error('❌ Annotation not found:', index);
    return;
  }
  
  // Find layer on map
  const drawnItems = getDrawnItems();
  if (!drawnItems) {
    console.error('❌ drawnItems not found');
    return;
  }
  
  let selectedLayer = null;
  
  // Try to find layer by matching the annotation object or by _displayIndex
  drawnItems.eachLayer(layer => {
    if (layer.annotationData) {
      // Match by reference (for new annotations) or by _displayIndex (for loaded annotations)
      if (layer.annotationData === ann || 
          (layer.annotationData._displayIndex && layer.annotationData._displayIndex === index + 1)) {
        selectedLayer = layer;
      }
    }
  });
  
  if (!selectedLayer) {
    console.error('❌ Layer not found for annotation:', index);
    console.log('Looking for _displayIndex:', index + 1);
    console.log('Available layers:', drawnItems.getLayers().length);
    
    // Debug: Log what we have
    drawnItems.eachLayer(layer => {
      if (layer.annotationData) {
        console.log('Layer has _displayIndex:', layer.annotationData._displayIndex);
      }
    });
    return;
  }
  
  console.log('✅ Found layer for annotation', index);
  
  // Highlight temporarily
  const originalStyle = {
    color: selectedLayer.options.color || '#3388ff',
    weight: selectedLayer.options.weight || 7
  };
  
  if (selectedLayer.setStyle) {
    selectedLayer.setStyle({
      color: '#ffff00',  // Yellow highlight
      weight: 5,
      fillOpacity: 0.4
    });
    
    setTimeout(() => {
      if (selectedLayer.setStyle) {
        selectedLayer.setStyle(originalStyle);
      }
    }, 2000);
  }
  
  // Zoom to annotation
  const map = getMap();
  if (!map) {
    console.error('❌ Map not found');
    return;
  }
  
  console.log('🗺️ Zooming to annotation...');
  
  if (selectedLayer.getBounds) {
    map.fitBounds(selectedLayer.getBounds(), { padding: [50, 50] });
    console.log('✅ Zoomed to bounds');
  } else if (selectedLayer.getLatLng) {
    map.setView(selectedLayer.getLatLng(), 18);
    console.log('✅ Zoomed to point');
  }
  
  console.log('✅ Successfully zoomed to annotation', index);
}

/**
 * Delete annotation
 * @param {number} index - Annotation index
 */
async function deleteAnnotation(index) {
  if (!await catConfirm('Delete this annotation?', { danger: true, ok: 'Delete' })) return;

  const projectAnnotations = getProjectAnnotations();
  const ann = projectAnnotations[index];

  if (!ann) return;

  // In Oracle mode, delete from DB first.
  // Skip if annotation never reached the DB (pending/error status means no DB record exists). (Fix 1e)
  const needsDbDelete = ann._dbAnnotationId && ann._syncStatus !== 'pending' && ann._syncStatus !== 'error';
  const isOracle = typeof isOracleProjectMode === 'function' && isOracleProjectMode();
  if (needsDbDelete && isOracle && typeof deleteAnnotationFromDb === 'function') {
    try {
      await deleteAnnotationFromDb(ann);
    } catch (dbError) {
      console.error('DB annotation delete failed:', dbError);
      showStatus(`❌ Failed to delete from DB: ${dbError.message}`, 'error');
      return;
    }
  }

  // Capture layer geometry for potential undo
  const drawnItems = getDrawnItems();
  let targetLayer = null;
  drawnItems.eachLayer(layer => {
    if (layer.annotationData) {
      if (layer.annotationData === ann ||
          (layer.annotationData._displayIndex && layer.annotationData._displayIndex === index + 1)) {
        targetLayer = layer;
      }
    }
  });

  // Snapshot data for undo before removal
  const deletedAnn = { ...ann };
  const deletedGeometry = targetLayer ? targetLayer.toGeoJSON() : null;

  if (targetLayer) {
    const layerId = targetLayer._leaflet_id;
    if (window.annotationLabels && window.annotationLabels.has(layerId)) {
      const label = window.annotationLabels.get(layerId);
      if (window.map && window.map.hasLayer(label)) {
        window.map.removeLayer(label);
      }
      window.annotationLabels.delete(layerId);
    }
    drawnItems.removeLayer(targetLayer);
  }

  removeAnnotationFromProject(index);
  updateAnnotationTable();

  // Show undo toast (Oracle mode only — soft delete is reversible)
  if (isOracle && needsDbDelete && deletedAnn._dbAnnotationId) {
    _showDeleteUndoToast(deletedAnn, deletedGeometry);
  } else {
    showStatus('🗑️ Annotation deleted', 'success');
  }
}

/**
 * Show a 5-second undo toast after an Oracle soft-delete
 */
function _showDeleteUndoToast(deletedAnn, deletedGeometry) {
  // Remove any existing undo toast
  const existing = document.getElementById('deleteUndoToast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'deleteUndoToast';
  toast.style.cssText = [
    'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
    'background:#333', 'color:#fff', 'padding:10px 18px', 'border-radius:6px',
    'z-index:9999', 'display:flex', 'align-items:center', 'gap:12px',
    'font-size:14px', 'box-shadow:0 3px 10px rgba(0,0,0,0.4)'
  ].join(';');

  const msg = document.createElement('span');
  msg.textContent = '🗑️ Annotation deleted';
  toast.appendChild(msg);

  const undoBtn = document.createElement('button');
  undoBtn.textContent = 'Undo';
  undoBtn.style.cssText = 'background:#4a9eff;border:none;color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:13px;';
  toast.appendChild(undoBtn);

  document.body.appendChild(toast);

  let undone = false;
  const timeoutId = setTimeout(() => {
    if (!undone) toast.remove();
  }, 5000);

  undoBtn.addEventListener('click', async () => {
    undone = true;
    clearTimeout(timeoutId);
    toast.remove();
    try {
      const restored = await restoreAnnotationInDb(deletedAnn._dbAnnotationId);
      // Re-add to projectAnnotations and map
      const projectAnnotations = getProjectAnnotations();
      const newIndex = projectAnnotations.length;
      restored._displayIndex = newIndex + 1;
      projectAnnotations.push(restored);

      if (deletedGeometry && typeof L !== 'undefined') {
        const drawnItems = getDrawnItems();
        const layer = L.geoJSON(restored.geometry || deletedGeometry.geometry || deletedGeometry, {
          pane: 'annotationsPane',
          style: { color: '#3388ff', weight: 7, opacity: 0.8, fillOpacity: 0.3 }
        }).getLayers()[0];
        if (layer) {
          layer.annotationData = restored;
          layer.on('click', function(e) { showAnnotationPopup(layer, e.latlng); });
          drawnItems.addLayer(layer);
        }
      }

      updateAnnotationTable();
      showStatus('↩️ Annotation restored', 'success');
    } catch (err) {
      console.error('Restore failed:', err);
      showStatus(`❌ Restore failed: ${err.message}`, 'error');
    }
  });
}

/**
 * Make table cell editable inline
 * @param {HTMLElement} cell - Table cell element
 */
function makeTableCellEditable(cell) {
  // Don't allow editing if already editing
  if (cell.classList.contains('editing')) return;
  // Don't allow inline edit while the full edit modal is open (Fix 1a)
  if (document.getElementById('editModal')?.classList.contains('active')) return;
  
  const field = cell.dataset.field;
  const index = parseInt(cell.dataset.index);
  const projectAnnotations = getProjectAnnotations();
  const annotation = projectAnnotations[index];
  
  if (!annotation) return;
  
  // Get current value
  let currentValue = annotation[field];
  if (currentValue === undefined || currentValue === null) {
    currentValue = '';
  } else if (field === 'old_dead') {
    currentValue = currentValue.toString().replace('%', '');
  } else if (field === 'juvenile') {
    // Keep juvenile as numeric value for editing
    currentValue = currentValue.toString();
  } else {
    currentValue = currentValue.toString();
  }
  
  // Store original
  const originalText = cell.textContent;
  
  // Mark as editing
  cell.classList.add('editing');
  
  // For species and juv_substrate, create autocomplete-enabled input
  if (field === 'spcode' || field === 'juv_substrate') {
    createAutocompleteTableCell(cell, field, currentValue, index);
    return;
  }
  
  // Create input based on field type
  let inputElement = createInputForField(field, currentValue);
  
  // Clear cell and add input
  cell.innerHTML = '';
  cell.appendChild(inputElement);
  inputElement.focus();
  if (inputElement.select) inputElement.select();
  
  // Save function
  const saveEdit = () => {
    // Capture state before edit for undo (5d)
    const prevAnnotation = { ...annotation };
    let newValue = inputElement.value.trim();

    // Convert to appropriate type
    if (newValue === '' || newValue === '-') {
      delete annotation[field];
    } else {
      if (field === 'obs_year' || field === 'old_dead' || field === 'segment' || field === 'juvenile') {
        const num = parseFloat(newValue);
        annotation[field] = isNaN(num) ? null : num;
      } else {
        annotation[field] = newValue;
      }
    }

    // Keep nested .properties in sync for DB-loaded annotations (Fix 1d)
    if (annotation.properties) {
      if (newValue === '' || newValue === '-') {
        delete annotation.properties[field];
      } else {
        annotation.properties[field] = annotation[field];
      }
    }

    // Track sync status (Fix 1e)
    annotation._syncStatus = 'dirty';

    // Push to undo stack (5d)
    if (typeof undoPushEdit === 'function') undoPushEdit(index, prevAnnotation, { ...annotation });

    // Update display
    cell.classList.remove('editing');
    updateAnnotationInProject(index, annotation);
    updateAnnotationTable();
    markUnsavedChanges();

    if (typeof isOracleProjectMode === 'function' && isOracleProjectMode()) {
      syncAnnotationIndexToDb(index).catch((dbError) => {
        console.error('DB inline update failed:', dbError);
        showStatus(`⚠️ DB sync failed: ${dbError.message}`, 'error');
      });
    }
  };
  
  // Cancel function
  const cancelEdit = () => {
    cell.classList.remove('editing');
    cell.textContent = originalText;
  };
  
  // Event handlers
  inputElement.addEventListener('blur', saveEdit);
  inputElement.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  });
}

/**
 * Create autocomplete-enabled table cell for species or juv_substrate
 * @param {HTMLElement} cell - The table cell element
 * @param {string} field - Field name ('spcode' or 'juv_substrate')
 * @param {string} currentValue - Current field value
 * @param {number} index - Annotation index
 */
function createAutocompleteTableCell(cell, field, currentValue, index) {
  const projectAnnotations = getProjectAnnotations();
  const annotation = projectAnnotations[index];
  
  // Create wrapper for input and dropdown
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.width = '100%';
  
  // Create input
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentValue;
  input.style.width = '100%';
  input.style.padding = '4px';
  input.style.border = '1px solid #667eea';
  input.style.borderRadius = '3px';
  input.autocomplete = 'off';
  
  // Create dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'autocomplete-dropdown';
  dropdown.style.position = 'absolute';
  dropdown.style.top = '100%';
  dropdown.style.left = '0';
  dropdown.style.width = '100%';
  dropdown.style.maxHeight = '200px';
  dropdown.style.overflowY = 'auto';
  dropdown.style.background = 'white';
  dropdown.style.border = '1px solid #ddd';
  dropdown.style.borderRadius = '4px';
  dropdown.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  dropdown.style.zIndex = '10000';
  dropdown.style.display = 'none';
  
  // Autocomplete state
  let tableAutocompleteResults = [];
  let tableAutocompleteSelectedIndex = -1;
  let debounceTimer;
  
  // Search function
  const searchTableAutocomplete = (query) => {
    clearTimeout(debounceTimer);
    
    if (field === 'spcode') {
      // Species search
      if (query.length < 2) {
        dropdown.style.display = 'none';
        return;
      }
      
      debounceTimer = setTimeout(() => {
        dropdown.innerHTML = '<div class="autocomplete-loading" style="padding: 8px; text-align: center; color: #888;">Searching...</div>';
        dropdown.style.display = 'block';

        const filterQs = typeof window.getSpeciesFilterQueryString === 'function' ? window.getSpeciesFilterQueryString() : '';
        const sep = filterQs ? '&' : '';
        fetch(`/api/coral/species/search?q=${encodeURIComponent(query)}&limit=10${sep}${filterQs}&cache=1`)
          .then(res => res.json())
          .then(data => {
            tableAutocompleteResults = data.results || [];
            
            if (tableAutocompleteResults.length === 0) {
              dropdown.innerHTML = '<div class="autocomplete-empty" style="padding: 8px; text-align: center; color: #999;">No species found</div>';
            } else {
              tableAutocompleteSelectedIndex = 0;
              dropdown.innerHTML = tableAutocompleteResults.map((species, idx) => `
                <div class="autocomplete-item ${idx === 0 ? 'selected' : ''}" 
                     style="padding: 8px; cursor: pointer; border-bottom: 1px solid #f0f0f0;" 
                     data-index="${idx}">
                  <div class="autocomplete-code" style="font-weight: 600; color: #667eea; font-size: 12px;">${species.code}</div>
                  <div class="autocomplete-name" style="color: #333; font-size: 11px;">${species.taxon_name || species.genus}</div>
                  ${species.scientific_name ? `<div class="autocomplete-sci" style="color: #888; font-size: 10px; font-style: italic;">${species.scientific_name}</div>` : ''}
                </div>
              `).join('');
              
              // Add click handlers
              dropdown.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
                item.addEventListener('mousedown', (e) => {
                  e.preventDefault();
                  input.value = tableAutocompleteResults[idx].code;
                  dropdown.style.display = 'none';
                  saveTableAutocompleteEdit();
                });
                item.addEventListener('mouseenter', () => {
                  dropdown.querySelectorAll('.autocomplete-item').forEach(i => i.classList.remove('selected'));
                  item.classList.add('selected');
                  tableAutocompleteSelectedIndex = idx;
                });
              });
            }
          })
          .catch(err => {
            console.error('Species search error:', err);
            dropdown.innerHTML = '<div class="autocomplete-empty" style="padding: 8px; text-align: center; color: #999;">Search failed</div>';
          });
      }, 150);

    } else if (field === 'juv_substrate') {
      // JUV_SUBSTRATE search
      const upperQuery = query.toUpperCase();
      
      if (query.length === 0) {
        dropdown.style.display = 'none';
        return;
      }
      
      tableAutocompleteResults = JUV_SUBSTRATE_OPTIONS.filter(option => 
        option.includes(upperQuery)
      );
      
      if (tableAutocompleteResults.length === 0) {
        dropdown.innerHTML = '<div class="autocomplete-empty" style="padding: 8px; text-align: center; color: #999;">No substrate found</div>';
        dropdown.style.display = 'block';
      } else {
        tableAutocompleteSelectedIndex = 0;
        dropdown.innerHTML = tableAutocompleteResults.map((substrate, idx) => `
          <div class="autocomplete-item ${idx === 0 ? 'selected' : ''}" 
               style="padding: 8px; cursor: pointer; border-bottom: 1px solid #f0f0f0;" 
               data-index="${idx}">
            <div class="autocomplete-code" style="font-weight: 600; color: #667eea; font-size: 12px;">${substrate}</div>
          </div>
        `).join('');
        dropdown.style.display = 'block';
        
        // Add click handlers
        dropdown.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            input.value = tableAutocompleteResults[idx];
            dropdown.style.display = 'none';
            saveTableAutocompleteEdit();
          });
          item.addEventListener('mouseenter', () => {
            dropdown.querySelectorAll('.autocomplete-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            tableAutocompleteSelectedIndex = idx;
          });
        });
      }
    }
  };
  
  // Save function
  const saveTableAutocompleteEdit = () => {
    const newValue = input.value.trim();
    
    if (newValue === '' || newValue === '-') {
      delete annotation[field];
    } else {
      annotation[field] = newValue;
    }
    
    cell.classList.remove('editing');
    dropdown.style.display = 'none';
    updateAnnotationInProject(index, annotation);
    updateAnnotationTable();
    markUnsavedChanges();

    if (typeof isOracleProjectMode === 'function' && isOracleProjectMode()) {
      syncAnnotationIndexToDb(index).catch((dbError) => {
        console.error('DB autocomplete update failed:', dbError);
        showStatus(`⚠️ DB sync failed: ${dbError.message}`, 'error');
      });
    }
  };
  
  // Cancel function
  const cancelTableAutocompleteEdit = () => {
    cell.classList.remove('editing');
    dropdown.style.display = 'none';
    updateAnnotationTable();
  };
  
  // Input event handlers
  input.addEventListener('input', (e) => {
    searchTableAutocomplete(e.target.value.trim());
  });
  
  input.addEventListener('keydown', (e) => {
    if (dropdown.style.display === 'block') {
      const items = dropdown.querySelectorAll('.autocomplete-item');
      
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        tableAutocompleteSelectedIndex = Math.min(tableAutocompleteSelectedIndex + 1, items.length - 1);
        items.forEach((item, idx) => {
          if (idx === tableAutocompleteSelectedIndex) {
            item.classList.add('selected');
            item.style.background = '#f8f9fa';
            item.scrollIntoView({ block: 'nearest' });
          } else {
            item.classList.remove('selected');
            item.style.background = '';
          }
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        tableAutocompleteSelectedIndex = Math.max(tableAutocompleteSelectedIndex - 1, -1);
        items.forEach((item, idx) => {
          if (idx === tableAutocompleteSelectedIndex) {
            item.classList.add('selected');
            item.style.background = '#f8f9fa';
            item.scrollIntoView({ block: 'nearest' });
          } else {
            item.classList.remove('selected');
            item.style.background = '';
          }
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (tableAutocompleteSelectedIndex >= 0 && tableAutocompleteSelectedIndex < tableAutocompleteResults.length) {
          if (field === 'spcode') {
            input.value = tableAutocompleteResults[tableAutocompleteSelectedIndex].code;
          } else {
            input.value = tableAutocompleteResults[tableAutocompleteSelectedIndex];
          }
        }
        dropdown.style.display = 'none';
        saveTableAutocompleteEdit();
      } else if (e.key === 'Tab') {
        // Select highlighted item on Tab
        if (tableAutocompleteSelectedIndex >= 0 && tableAutocompleteSelectedIndex < tableAutocompleteResults.length) {
          e.preventDefault();
          if (field === 'spcode') {
            input.value = tableAutocompleteResults[tableAutocompleteSelectedIndex].code;
          } else {
            input.value = tableAutocompleteResults[tableAutocompleteSelectedIndex];
          }
          dropdown.style.display = 'none';
          saveTableAutocompleteEdit();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelTableAutocompleteEdit();
      }
    } else {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveTableAutocompleteEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelTableAutocompleteEdit();
      }
    }
  });
  
  input.addEventListener('blur', (e) => {
    // Delay to allow clicking on dropdown items
    setTimeout(() => {
      saveTableAutocompleteEdit();
    }, 200);
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });
  
  // Build and insert
  wrapper.appendChild(input);
  wrapper.appendChild(dropdown);
  cell.innerHTML = '';
  cell.appendChild(wrapper);
  input.focus();
  if (input.select) input.select();
}

/**
 * Create input element for field type
 * @param {string} field - Field name
 * @param {string} value - Current value
 * @returns {HTMLElement} Input element
 */
function createInputForField(field, value) {
  let input;
  
  if (field === 'segment') {
    input = document.createElement('select');
    input.innerHTML = `
      <option value="">-</option>
      <option value="0">0</option>
      <option value="5">5</option>
      <option value="10">10</option>
      <option value="15">15</option>
    `;
    input.value = value;
  } else if (field === 'transect') {
    input = document.createElement('select');
    input.innerHTML = `
      <option value="">-</option>
      <option value="A">A</option>
      <option value="B">B</option>
    `;
    input.value = value;
  } else if (field === 'juvenile') {
    input = document.createElement('select');
    input.innerHTML = `
      <option value="0">0 (No)</option>
      <option value="-1">-1 (Yes)</option>
    `;
    input.value = value;
  } else if (field === 'obs_year') {
    input = document.createElement('input');
    input.type = 'number';
    input.min = '2000';
    input.max = '2100';
    input.value = value;
  } else if (field === 'old_dead') {
    input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.value = value;
  } else if (field === 'morph_code') {
    // Dropdown for morphology code
    input = document.createElement('select');
    input.innerHTML = `
      <option value="">-</option>
      <option value="BR">BR - Branching</option>
      <option value="CO">CO - Columnar</option>
      <option value="EN">EN - Encrusting</option>
      <option value="FO">FO - Foliaceous</option>
      <option value="FL">FL - Free-living</option>
      <option value="LA">LA - Laminar</option>
      <option value="MD">MD - Mounding</option>
      <option value="MA">MA - Massive</option>
      <option value="PL">PL - Plating</option>
      <option value="SM">SM - Submassive</option>
      <option value="SO">SO - Solitary</option>
      <option value="TB">TB - Tabular</option>
    `;
    input.value = value;
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    if (field === 'analyst' || field === 'spcode') {
      input.maxLength = 10;
    }
  }
  
  return input;
}

/**
 * Open edit modal for an annotation
 * @param {number} index - Index of annotation in projectAnnotations array
 */
function openEditModal(index) {
  // Cancel any active inline cell edits before opening modal (Fix 1a)
  document.querySelectorAll('td.editing').forEach(cell => {
    cell.classList.remove('editing');
    const ann = getProjectAnnotations()[parseInt(cell.dataset.index)];
    const val = ann?.[cell.dataset.field];
    cell.textContent = (val !== undefined && val !== null) ? String(val) : '-';
  });

  const projectAnnotations = getProjectAnnotations();
  const annotation = projectAnnotations[index];
  if (!annotation) {
    console.error('Annotation not found:', index);
    return;
  }
  
  document.getElementById('editModalId').textContent = index + 1;
  
  // Build the form HTML
  const formHTML = `
    <div class="modal-form-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; max-height: 60vh; overflow-y: auto;">
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Analyst *</label>
        <input type="text" id="edit_analyst" value="${annotation.analyst || ''}" maxlength="10" required style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Year *</label>
        <input type="number" id="edit_obs_year" value="${annotation.obs_year || ''}" min="2000" max="2100" required style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Mission ID *</label>
        <input type="text" id="edit_mission_id" value="${annotation.mission_id || ''}" required style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Site *</label>
        <input type="text" id="edit_site" value="${annotation.site || ''}" required style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Transect</label>
        <select id="edit_transect" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
          <option value="">-</option>
          <option value="A" ${annotation.transect === 'A' ? 'selected' : ''}>A</option>
          <option value="B" ${annotation.transect === 'B' ? 'selected' : ''}>B</option>
        </select>
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Segment</label>
        <select id="edit_segment" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
          <option value="">-</option>
          <option value="0" ${annotation.segment == 0 ? 'selected' : ''}>0</option>
          <option value="5" ${annotation.segment == 5 ? 'selected' : ''}>5</option>
          <option value="10" ${annotation.segment == 10 ? 'selected' : ''}>10</option>
          <option value="15" ${annotation.segment == 15 ? 'selected' : ''}>15</option>
        </select>
      </div>
      <div class="modal-form-field" style="position: relative;">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Species Code</label>
        <input type="text" id="edit_spcode" value="${annotation.spcode || ''}" maxlength="10" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" autocomplete="off" />
        <div id="edit-species-autocomplete" class="species-autocomplete-dropdown" style="position: absolute; z-index: 10000; display: none; background: white; border: 1px solid #ddd; border-radius: 4px; max-height: 200px; overflow-y: auto; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,0.15);"></div>
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Morphology Code</label>
        <select id="edit_morph_code" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
          <option value="">-</option>
          <option value="BR" ${annotation.morph_code === 'BR' ? 'selected' : ''}>BR - Branching</option>
          <option value="CO" ${annotation.morph_code === 'CO' ? 'selected' : ''}>CO - Columnar</option>
          <option value="EN" ${annotation.morph_code === 'EN' ? 'selected' : ''}>EN - Encrusting</option>
          <option value="FO" ${annotation.morph_code === 'FO' ? 'selected' : ''}>FO - Foliaceous</option>
          <option value="FL" ${annotation.morph_code === 'FL' ? 'selected' : ''}>FL - Free-living</option>
          <option value="LA" ${annotation.morph_code === 'LA' ? 'selected' : ''}>LA - Laminar</option>
          <option value="MD" ${annotation.morph_code === 'MD' ? 'selected' : ''}>MD - Mounding</option>
          <option value="MA" ${annotation.morph_code === 'MA' ? 'selected' : ''}>MA - Massive</option>
          <option value="PL" ${annotation.morph_code === 'PL' ? 'selected' : ''}>PL - Plating</option>
          <option value="SM" ${annotation.morph_code === 'SM' ? 'selected' : ''}>SM - Submassive</option>
          <option value="SO" ${annotation.morph_code === 'SO' ? 'selected' : ''}>SO - Solitary</option>
          <option value="TB" ${annotation.morph_code === 'TB' ? 'selected' : ''}>TB - Tabular</option>
        </select>
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Old Dead %</label>
        <input type="number" id="edit_old_dead" value="${annotation.old_dead || ''}" min="0" max="100" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Juvenile</label>
        <input type="number" id="edit_juvenile" value="${annotation.juvenile || 0}" min="0" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">JUV_SUBSTRATE</label>
        <input type="text" id="edit_juv_substrate" value="${annotation.juv_substrate || ''}" maxlength="50" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
      </div>
      <div class="modal-form-field">
        <label style="font-weight: bold; display: block; margin-bottom: 5px;">Remnant</label>
        <input type="number" id="edit_remnant" value="${annotation.remnant || 0}" min="0" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
      </div>
    </div>
  `;
  
  document.getElementById('editFormContainer').innerHTML = formHTML;
  document.getElementById('editModal').classList.add('active');
  
  // Store the index for saving
  document.getElementById('editModal').dataset.annotationIndex = index;
  
  console.log('✅ Opened edit modal for annotation', index);
}

/**
 * Close edit modal
 */
function closeEditModal() {
  document.getElementById('editModal').classList.remove('active');
  document.getElementById('editFormContainer').innerHTML = '';
  document.getElementById('editModal').dataset.annotationIndex = '';
  
  // Hide geometry edit buttons if they're visible
  if (typeof cancelGeometryEdit === 'function') {
    cancelGeometryEdit();
  }
}

/**
 * Enable geometry editing for an annotation
 * @param {number} index - Index of annotation in projectAnnotations array
 */
function enableGeometryEdit(index) {
  const projectAnnotations = getProjectAnnotations();
  const ann = projectAnnotations[index];
  if (!ann) {
    console.error('Annotation not found:', index);
    return;
  }
  
  // Find the layer on the map using same logic as selectAnnotationForEdit
  let targetLayer = null;
  drawnItems.eachLayer(layer => {
    if (layer.annotationData) {
      // Match by reference (for new annotations) or by _displayIndex (for loaded annotations)
      if (layer.annotationData === ann || 
          (layer.annotationData._displayIndex && layer.annotationData._displayIndex === index + 1)) {
        targetLayer = layer;
      }
    }
  });
  
  if (!targetLayer) {
    console.error('Layer not found for annotation:', index);
    return;
  }
  
  // Disable any previous editing
  if (currentEditingLayer && currentEditingLayer.editing) {
    currentEditingLayer.editing.disable();
  }
  
  // Enable editing on this layer
  if (targetLayer.editing) {
    targetLayer.editing.enable();
    currentEditingLayer = targetLayer;
    
    // Zoom to the annotation
    if (targetLayer.getBounds) {
      map.fitBounds(targetLayer.getBounds(), { padding: [50, 50] });
    } else if (targetLayer.getLatLng) {
      map.setView(targetLayer.getLatLng(), 18);
    }
    
    // Highlight the layer being edited
    if (targetLayer.setStyle) {
      targetLayer.setStyle({
        color: '#ffaa00',
        weight: 3,
        fillOpacity: 0.3
      });
    }
    
    showStatus(`📐 Editing geometry for annotation #${index + 1} - Drag vertices to modify. Click "Save Geometry" when done.`, 'info');
    
    // Store the original LatLngs with full precision
    if (targetLayer.getLatLngs) {
      const latlngs = targetLayer.getLatLngs();
      currentEditingLayer.originalLatLngs = JSON.parse(JSON.stringify(latlngs));
    } else if (targetLayer.getLatLng) {
      currentEditingLayer.originalLatLngs = JSON.parse(JSON.stringify(targetLayer.getLatLng()));
    }
    currentEditingLayer.editingIndex = index;
    
    // Add geometry edit buttons to the annotation panel header
    const annotationHeader = document.querySelector('.annotation-panel h3');
    if (annotationHeader) {
      const headerParent = annotationHeader.parentElement;
      
      // Remove any existing buttons first
      const existingContainer = document.getElementById('geometryEditButtons');
      if (existingContainer) {
        existingContainer.remove();
      }
      
      // Create button container
      const buttonContainer = document.createElement('div');
      buttonContainer.id = 'geometryEditButtons';
      buttonContainer.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-left: auto;';
      
      // Create save button
      const saveGeomBtn = document.createElement('button');
      saveGeomBtn.className = 'btn btn-success';
      saveGeomBtn.style.cssText = 'padding: 6px 12px; font-size: 12px;';
      saveGeomBtn.innerHTML = '💾 Save Geometry';
      saveGeomBtn.onclick = () => saveGeometryEdit(index);
      
      // Create cancel button
      const cancelGeomBtn = document.createElement('button');
      cancelGeomBtn.className = 'btn btn-secondary';
      cancelGeomBtn.style.cssText = 'padding: 6px 12px; font-size: 12px;';
      cancelGeomBtn.innerHTML = '✖️ Cancel';
      cancelGeomBtn.onclick = cancelGeometryEdit;
      
      // Add editing indicator
      const editingLabel = document.createElement('span');
      editingLabel.style.cssText = 'font-size: 11px; color: #ff9800; font-weight: bold;';
      editingLabel.innerHTML = `📐 Editing #${index + 1}`;
      
      buttonContainer.appendChild(editingLabel);
      buttonContainer.appendChild(saveGeomBtn);
      buttonContainer.appendChild(cancelGeomBtn);
      
      // Insert buttons into header
      headerParent.appendChild(buttonContainer);
    }
    
    console.log('✅ Geometry editing enabled for annotation', index);
  }
}

/**
 * Save geometry edits
 * @param {number} index - Annotation index
 */
async function saveGeometryEdit(index) {
  if (!currentEditingLayer) return;
  
  // Disable editing and clean up handles
  if (currentEditingLayer.editing) {
    currentEditingLayer.editing.disable();
    if (typeof _removeStaleEditHandles === 'function') _removeStaleEditHandles(currentEditingLayer);
  }

  // Update the annotation's geometry with new coordinates
  const projectAnnotations = getProjectAnnotations();
  const ann = projectAnnotations[index];
  if (ann) {
    ann.geometry = currentEditingLayer.toGeoJSON().geometry;
    
    // Reset style to original
    if (currentEditingLayer.setStyle) {
      currentEditingLayer.setStyle({
        color: '#3388ff',
        weight: 7,
        opacity: 0.8,
        fillOpacity: 0.3
      });
    }
    
    // Update the label position to match new geometry
    // Remove old label first, then add new one at updated position
    const annotationId = currentEditingLayer._leaflet_id;
    if (annotationLabels && annotationLabels.has(annotationId)) {
      const oldLabel = annotationLabels.get(annotationId);
      if (map && map.hasLayer(oldLabel)) {
        map.removeLayer(oldLabel);
      }
      annotationLabels.delete(annotationId);
    }
    
    // Add new label at updated geometry position
    if (labelsVisible) {
      setTimeout(() => {
        addLabelToAnnotation(currentEditingLayer);
      }, 50);
    }
    
    // Update annotation in project
    updateAnnotationInProject(index, ann);
    markUnsavedChanges();

    if (typeof isOracleProjectMode === 'function' && isOracleProjectMode()) {
      try {
        await syncAnnotationIndexToDb(index);
      } catch (dbError) {
        console.error('DB geometry update failed:', dbError);
        showStatus(`⚠️ Geometry saved locally, DB sync failed: ${dbError.message}`, 'error');
      }
    }
    
    console.log('✅ Geometry updated for annotation', index);
    showStatus('✅ Geometry saved', 'success');
  }
  
  // Remove button container
  const buttonContainer = document.getElementById('geometryEditButtons');
  if (buttonContainer) {
    buttonContainer.remove();
  }
  
  // Clean up
  delete currentEditingLayer.originalLatLngs;
  delete currentEditingLayer.editingIndex;
  currentEditingLayer = null;
}

/**
 * Cancel geometry editing
 */
function cancelGeometryEdit() {
  if (!currentEditingLayer) return;
  
  // Restore original geometry
  if (currentEditingLayer.originalLatLngs) {
    const originalLatLngs = currentEditingLayer.originalLatLngs;
    
    // Restore coordinates based on structure
    if (Array.isArray(originalLatLngs)) {
      if (Array.isArray(originalLatLngs[0])) {
        // Polygon - nested array
        const coords = originalLatLngs.map(ring => 
          Array.isArray(ring) ? ring.map(pt => L.latLng(pt.lat, pt.lng)) : L.latLng(ring.lat, ring.lng)
        );
        currentEditingLayer.setLatLngs(coords);
      } else {
        // Polyline - flat array
        const coords = originalLatLngs.map(pt => L.latLng(pt.lat, pt.lng));
        currentEditingLayer.setLatLngs(coords);
      }
    } else {
      // Point
      currentEditingLayer.setLatLng(L.latLng(originalLatLngs.lat, originalLatLngs.lng));
    }
  }
  
  // Disable editing and clean up handles
  if (currentEditingLayer.editing) {
    currentEditingLayer.editing.disable();
    if (typeof _removeStaleEditHandles === 'function') _removeStaleEditHandles(currentEditingLayer);
  }

  // Reset style
  if (currentEditingLayer.setStyle) {
    currentEditingLayer.setStyle({
      color: '#3388ff',
      weight: 7,
      opacity: 0.8,
      fillOpacity: 0.3
    });
  }

  // Remove button container
  const buttonContainer = document.getElementById('geometryEditButtons');
  if (buttonContainer) {
    buttonContainer.remove();
  }

  // Clean up
  delete currentEditingLayer.originalLatLngs;
  delete currentEditingLayer.editingIndex;
  currentEditingLayer = null;

  showStatus('↩️ Geometry edit cancelled - changes discarded', 'info');
}

/**
 * Save edited annotation from modal
 */
async function saveEditedAnnotation() {
  const index = parseInt(document.getElementById('editModal').dataset.annotationIndex);
  const projectAnnotations = getProjectAnnotations();
  
  if (isNaN(index) || !projectAnnotations[index]) {
    console.error('Invalid annotation index:', index);
    return;
  }
  
  const annotation = projectAnnotations[index];

  // Capture state before edits for undo (5d)
  const prevAnnotation = { ...annotation };

  // Update annotation with form values
  annotation.analyst = document.getElementById('edit_analyst').value;
  annotation.obs_year = parseInt(document.getElementById('edit_obs_year').value);
  annotation.mission_id = document.getElementById('edit_mission_id').value;
  annotation.site = document.getElementById('edit_site').value;
  annotation.transect = document.getElementById('edit_transect').value;
  annotation.segment = document.getElementById('edit_segment').value;
  annotation.spcode = document.getElementById('edit_spcode').value;
  annotation.morph_code = document.getElementById('edit_morph_code').value;
  annotation.old_dead = document.getElementById('edit_old_dead').value;
  annotation.juvenile = parseInt(document.getElementById('edit_juvenile').value) || 0;
  annotation.juv_substrate = document.getElementById('edit_juv_substrate').value;
  annotation.remnant = parseInt(document.getElementById('edit_remnant').value) || 0;
  
  // Add updated_at timestamp
  annotation.updated_at = new Date().toISOString();

  // Keep nested .properties in sync for DB-loaded annotations (Fix 1d)
  if (annotation.properties) {
    ['analyst', 'obs_year', 'mission_id', 'site', 'transect', 'segment',
     'spcode', 'morph_code', 'old_dead', 'juvenile', 'juv_substrate', 'remnant', 'updated_at'].forEach(f => {
      annotation.properties[f] = annotation[f];
    });
  }

  // Track sync status (Fix 1e)
  annotation._syncStatus = 'dirty';

  // Update the layer's annotationData and refresh style for completeness (5a)
  drawnItems.eachLayer(layer => {
    if (layer.annotationData === annotation) {
      layer.annotationData = annotation;
      if (layer.setStyle) layer.setStyle(getAnnotationLayerStyle(annotation));

      // Update label if enabled
      if (labelsVisible) {
        addLabelToAnnotation(layer);
      }
    }
  });
  
  // Update the annotation table
  updateAnnotationTable();
  
  // Update annotation in project
  updateAnnotationInProject(index, annotation);
  
  // Mark unsaved changes
  markUnsavedChanges();

  if (typeof isOracleProjectMode === 'function' && isOracleProjectMode()) {
    try {
      await syncAnnotationIndexToDb(index);
      annotation._syncStatus = 'synced';
    } catch (dbError) {
      console.error('DB modal edit failed:', dbError);
      showStatus(`⚠️ Saved locally, DB sync failed: ${dbError.message}`, 'error');
    }
  }

  // Push to undo stack (5d)
  if (typeof undoPushEdit === 'function') undoPushEdit(index, prevAnnotation, { ...annotation });

  // Close modal
  closeEditModal();

  showStatus('✅ Annotation updated', 'success');
  console.log('✅ Saved annotation', index, annotation);
}

/**
 * Filter annotation table rows by a query string (Fix 3c)
 * Matches against spcode, site, analyst (case-insensitive)
 */
function filterAnnotationTable(query) {
  const q = (query || '').trim().toLowerCase();
  const rows = document.querySelectorAll('#annotationTableBody tr');
  rows.forEach(row => {
    if (!q) { row.style.display = ''; return; }
    const index = parseInt(row.dataset.index);
    if (isNaN(index)) { row.style.display = ''; return; }
    const ann = getProjectAnnotations()[index];
    if (!ann) { row.style.display = 'none'; return; }
    const haystack = [ann.spcode, ann.site, ann.analyst, ann.mission_id, ann.transect]
      .filter(Boolean).join(' ').toLowerCase();
    row.style.display = haystack.includes(q) ? '' : 'none';
  });
}

// Make functions globally accessible
window.isAnnotationComplete = isAnnotationComplete;
window.getAnnotationLayerStyle = getAnnotationLayerStyle;
window.updateAnnotationTable = updateAnnotationTable;
window.filterAnnotationTable = filterAnnotationTable;
window.selectAnnotationForEdit = selectAnnotationForEdit;
window.selectSpeciesByIndex = selectSpeciesByIndex;
window.selectJuvSubstrateByIndex = selectJuvSubstrateByIndex;
window.deleteAnnotation = deleteAnnotation;
window.openEditModal = openEditModal;
window.closeEditModal = closeEditModal;
window.enableGeometryEdit = enableGeometryEdit;
window.saveGeometryEdit = saveGeometryEdit;
window.cancelGeometryEdit = cancelGeometryEdit;
window.saveEditedAnnotation = saveEditedAnnotation;

// Export functions
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    setupFormHandlers,
    setupSpeciesAutocomplete,
    saveAnnotation,
    clearAnnotationForm,
    updateAnnotationTable,
    selectAnnotationForEdit,
    deleteAnnotation,
    makeTableCellEditable
  };
}

// Extracted from annotation-file-mode-runtime.js (Phase 2c: project/layers)
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
        : Object.fromEntries(Object.entries(ann).filter(([k]) => !['geometry', 'feature', '_displayIndex', 'id'].includes(k)));

      return {
        feature,
        properties,
        created_by: (properties.ANALYST || properties.analyst || document.getElementById('analyst')?.value || null)
      };
    }

    function isOracleProjectMode() {
      return storageBackend === 'oracle' && !!currentProject?.project_id;
    }

    // ── Project annotation helpers (needed by autosave, undo, etc.) ──

    function getDbAnnotationId(annotation) {
      return annotation?._dbAnnotationId || annotation?.annotation_id || annotation?.id || null;
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
        _syncStatus: 'synced'
      };
    }

    async function syncAnnotationToDb(annotation, assetId = null) {
      if (!isOracleProjectMode()) return annotation;
      const projectId = currentProject.project_id;
      const annotationId = getDbAnnotationId(annotation);
      const payload = normalizeAnnotationForDb(annotation);
      if (assetId) payload.asset_id = assetId;

      if (annotationId) {
        const putBody = {
          feature: payload.feature,
          properties: payload.properties,
          created_by: payload.created_by
        };
        if (annotation._dbAnnotationVersion != null) putBody.version = annotation._dbAnnotationVersion;
        const resp = await fetch(`${serverUrl}/api/db/projects/${projectId}/annotations/${annotationId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(putBody)
        });
        if (resp.status === 409) {
          const conflictData = await resp.json().catch(() => ({}));
          const err = new Error(`Conflict: annotation #${annotationId} was modified by another user`);
          err.isConflict = true;
          err.serverAnnotation = conflictData.current_annotation ? normalizeDbAnnotationResponse(conflictData.current_annotation) : null;
          throw err;
        }
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}));
          throw new Error(e.detail || `Failed to update annotation #${annotationId}`);
        }
        const result = await resp.json();
        return normalizeDbAnnotationResponse(result.annotation);
      }

      const resp = await fetch(`${serverUrl}/api/db/projects/${projectId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.detail || 'Failed to create annotation');
      }
      const result = await resp.json();
      return normalizeDbAnnotationResponse(result.annotation);
    }

    function getProjectAnnotations() {
      return projectAnnotations;
    }

    function removeAnnotationFromProject(index) {
      projectAnnotations.splice(index, 1);
    }

    function updateAnnotationInProject(index, annotationData) {
      if (index >= 0 && index < projectAnnotations.length) {
        projectAnnotations[index] = annotationData;
      }
    }

    function applySyncedAnnotation(index, syncedAnnotation) {
      if (index < 0 || !syncedAnnotation) return;
      const oldAnnotation = projectAnnotations[index];
      updateAnnotationInProject(index, syncedAnnotation);
      // Also update the parallel annotations array used by table/stats
      if (index >= 0 && index < annotations.length && annotations[index] === oldAnnotation) {
        annotations[index] = syncedAnnotation;
      }
      drawnItems.eachLayer(layer => {
        if (!layer.annotationData) return;
        if (layer.annotationData._displayIndex === index + 1 || layer.annotationData === oldAnnotation) {
          layer.annotationData = syncedAnnotation;
        }
      });
    }

    // ── End project annotation helpers ──

    function normalizeDbGeoJsonFeature(feature) {
      const properties = feature?.properties || {};
      const geometryPayload = feature?.geometry || null;
      const geometry = geometryPayload?.type === 'Feature'
        ? geometryPayload.geometry
        : geometryPayload;
      const id = feature?.id ?? properties.annotation_id;

      return {
        type: 'Feature',
        id,
        geometry,
        properties
      };
    }

    async function loadProjectFromDatabase(projectId) {
      const numericId = Number(projectId);
      if (!Number.isFinite(numericId) || numericId <= 0) {
        throw new Error('Invalid database project_id');
      }

      const overlay = document.getElementById('loadingOverlay');
      const loadingTitle = document.getElementById('loadingTitle');
      const loadingMessage = document.getElementById('loadingMessage');
      const loadingProgress = document.getElementById('loadingProgress');
      const loadingIcon = document.getElementById('loadingIcon');

      overlay.style.display = 'flex';
      loadingTitle.textContent = 'Loading DB Project';
      loadingMessage.textContent = `Fetching project #${numericId} from Oracle...`;
      loadingProgress.style.width = '20%';
      loadingIcon.textContent = '🗄️';

      const response = await fetch(`${serverUrl}/api/db/projects/${numericId}/snapshot`);
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `Failed to load DB project ${numericId}`);
      }

      const snapshot = await response.json();
      currentProject = transformDbSnapshotToProject(snapshot);
      projectAnnotations = (snapshot.annotations || []).map((a) => {
        // Use normalizeDbAnnotationResponse to preserve _dbAnnotationId / _dbAnnotationVersion
        // so the change-polling knows which annotations are already local
        if (a.annotation_id != null || a.version != null) {
          return normalizeDbAnnotationResponse(a);
        }
        if (a.properties && a.feature?.geometry) {
          return {
            ...a.properties,
            properties: a.properties,
            geometry: a.feature.geometry
          };
        }
        return a;
      });

      loadingProgress.style.width = '70%';
      loadingTitle.textContent = 'Initializing Map';
      loadingMessage.textContent = 'Loading COG layers and annotations...';
      loadingIcon.textContent = '🗺️';

      document.getElementById('uploadPanel').style.display = 'none';
      document.getElementById('mapLayersPanel').style.display = 'block';
      document.getElementById('annotationFormPanel').style.display = 'block';
      document.getElementById('saveProjectBtn').style.display = 'block';

      const siteBadge = document.getElementById('mapLayersSiteBadge');
      if (siteBadge) {
        siteBadge.textContent = currentProject.site || currentProject.project_name || `Project ${numericId}`;
      }

      initializeAnnotationForm();
      loadProjectLayers();
      loadProjectAnnotations();
      startTimer();

      // Initialize overlay layers (shapefiles) for DB projects
      if (typeof initializeOverlayControls === 'function') {
        initializeOverlayControls(numericId);
      }

      // Start DB annotation session (best effort)
      try {
        const analyst = document.getElementById('analyst')?.value || 'unknown';
        const sessionResp = await fetch(`${serverUrl}/api/db/projects/${numericId}/sessions/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: analyst })
        });
        if (sessionResp.ok) {
          const sessionData = await sessionResp.json();
          currentDbSessionId = sessionData.session?.session_id || null;
        }
      } catch (sessionErr) {
        console.warn('Could not start DB annotation session:', sessionErr);
      }

      loadingProgress.style.width = '100%';
      loadingTitle.textContent = 'Project Loaded';
      loadingMessage.textContent = `Project #${numericId} loaded from database`;
      loadingIcon.textContent = '✅';

      await new Promise(resolve => setTimeout(resolve, 900));
      overlay.style.display = 'none';
    }
    
    async function loadProjectFromFile(file) {
      try {
        const text = await file.text();
        const projectData = JSON.parse(text);
        
        // Upload to backend for processing (COG creation, etc.)
        const formData = new FormData();
        formData.append('file', file);  // Send the actual file, not just text
        
        // Show full-screen loading overlay
        const overlay = document.getElementById('loadingOverlay');
        const loadingTitle = document.getElementById('loadingTitle');
        const loadingMessage = document.getElementById('loadingMessage');
        const loadingProgress = document.getElementById('loadingProgress');
        const loadingIcon = document.getElementById('loadingIcon');
        
        overlay.style.display = 'flex';
        loadingTitle.textContent = 'Loading Project';
        loadingMessage.textContent = 'Parsing project file...';
        loadingProgress.style.width = '10%';
        loadingIcon.textContent = '📄';
        
        // Brief delay to show parsing message
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Update to show COG processing will happen
        loadingTitle.textContent = 'Processing Project';
        loadingMessage.textContent = 'Creating Cloud Optimized GeoTIFF (COG) files if needed... This is a one-time process and may take several minutes for large images. Please Wait...';
        loadingProgress.style.width = '20%';
        loadingIcon.textContent = '⚙️';
        
        const response = await fetch(`${serverUrl}/api/file-projects/upload-project`, {
          method: 'POST',
          body: formData
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.detail || 'Failed to load project');
        }
        
        const result = await response.json();
        currentProject = result.project;
        projectAnnotations = result.annotations || [];
        
        // Update progress - completed processing, now initializing
        loadingTitle.textContent = 'Initializing Map';
        loadingMessage.textContent = 'COG creation complete! Loading map layers and annotations...';
        loadingProgress.style.width = '70%';
        loadingIcon.textContent = '🗺️';
        
        // Hide upload panel, show map layers and annotation form
        document.getElementById('uploadPanel').style.display = 'none';
        document.getElementById('mapLayersPanel').style.display = 'block';
        document.getElementById('annotationFormPanel').style.display = 'block';
        document.getElementById('saveProjectBtn').style.display = 'block';
        
        // Update site badge
        const siteBadge = document.getElementById('mapLayersSiteBadge');
        if (siteBadge) {
          siteBadge.textContent = currentProject.site || currentProject.project_name;
        }
        
        // Initialize annotation form with project data
        initializeAnnotationForm();
        
        // Load layers
        loadProjectLayers();
        
        // Load shapefiles if present
        if (currentProject.shapefiles && currentProject.shapefiles.length > 0) {
          loadProjectShapefiles();
        }
        
        // Load existing annotations
        loadProjectAnnotations();
        
        // Start the timer automatically
        startTimer();
        
        // Update progress - complete
        loadingProgress.style.width = '100%';
        loadingTitle.textContent = 'Project Loaded';
        loadingIcon.textContent = '✅';
        
        const numTifs = currentProject.tif_files?.length || 0;
        const numAnnotations = projectAnnotations.length;
        const numShapefiles = currentProject.shapefiles?.length || 0;
        
        loadingMessage.textContent = `${numTifs} image${numTifs !== 1 ? 's' : ''} • ${numAnnotations} annotation${numAnnotations !== 1 ? 's' : ''}${numShapefiles > 0 ? ` • ${numShapefiles} shapefile${numShapefiles !== 1 ? 's' : ''}` : ''}`;
        
        // Hide overlay after a brief success display
        await new Promise(resolve => setTimeout(resolve, 1200));
        overlay.style.display = 'none';
        
      } catch (error) {
        console.error('Error loading project:', error);
        
        // Hide overlay and show error
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.style.display = 'none';
        
        document.getElementById('uploadStatus').innerHTML = `<span style="color: #ef4444;">❌ Error: ${error.message}</span>`;
      }
    }
    
    function initializeAnnotationForm() {
      // Pre-fill annotation form with project data
      if (currentProject) {
        const analystField = document.getElementById('analyst');
        const siteField = document.getElementById('site');
        const obsYearField = document.getElementById('obs_year');
        const missionIdField = document.getElementById('mission_id');
        
        // Analyst field - from project.metadata.observer, then localStorage
        if (analystField && currentProject.metadata?.observer) {
          analystField.value = currentProject.metadata.observer;
        } else if (analystField && !analystField.value) {
          const saved = localStorage.getItem('cat_analyst');
          if (saved) {
            analystField.value = saved;
            markFieldAsAutofilled(analystField);
          }
        }
        
        // Site field - from project.site
        if (siteField && currentProject.site) {
          siteField.value = currentProject.site;
        }
        
        // Observation year - from project.year
        if (obsYearField && currentProject.year) {
          obsYearField.value = currentProject.year;
        }
        
        // Mission ID - from project.cruise
        if (missionIdField && currentProject.cruise) {
          missionIdField.value = currentProject.cruise;
        }
        
        console.log('✅ Annotation form initialized with project data:', {
          analyst: currentProject.metadata?.observer,
          site: currentProject.site,
          obs_year: currentProject.year,
          mission_id: currentProject.cruise
        });
      }
    }
    
    function loadProjectLayers() {
      const mapFileSection = document.getElementById('mapFileSection');
      if (!mapFileSection) return;
      
      // Clear existing layers but preserve shapefile container
      const shapefileContainer = document.getElementById('shapefileLayersContainer');
      const shapefileHTML = shapefileContainer ? shapefileContainer.outerHTML : '<div id="shapefileLayersContainer"></div>';
      
      mapFileSection.innerHTML = `
        <div class="layer-subsection-title">🗺️ Map Files</div>
        <button onclick="zoomToSite()" style="width: 100%; margin-bottom: 10px; padding: 8px; background: linear-gradient(135deg, #06b6d4, #0891b2); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">📍 Zoom to Site</button>
      `;
      
      // Find the first non-DEM TIF (orthomosaic) to auto-load
      let autoLoadTif = null;
      for (const tif of currentProject.tif_files) {
        const isDEM = tif.type === 'DEM' || tif.name.toLowerCase().includes('dem');
        if (!isDEM && !autoLoadTif) {
          autoLoadTif = tif;
          break;
        }
      }
      // If no orthomosaic found, fall back to first TIF
      if (!autoLoadTif && currentProject.tif_files.length > 0) {
        autoLoadTif = currentProject.tif_files[0];
      }
      
      // Add TIF files as layers
      currentProject.tif_files.forEach((tif, index) => {
        const layerDiv = document.createElement('div');
        layerDiv.className = 'layer-item';
        const shouldAutoLoad = tif === autoLoadTif;
        const isDEM = tif.type === 'DEM' || tif.name.toLowerCase().includes('dem');
        const safeId = `tif_${tif.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        
        // For DEM layers, add collapsible controls like shapefiles
        if (isDEM) {
          layerDiv.innerHTML = `
            <div class="layer-header tif-header-${safeId}" style="cursor: pointer;">
              <div class="layer-name" style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                <label onclick="event.stopPropagation()" style="display: flex; align-items: center; gap: 8px; flex: 1;">
                  <input type="checkbox" class="tif-layer-checkbox" data-tif-id="${tif.id}" data-cog-path="${tif.cog_path}" data-type="${tif.type}" ${shouldAutoLoad ? 'checked' : ''}>
                  <span>${tif.name}</span>
                </label>
                <span class="layer-collapse-icon" id="${safeId}_detailsIcon">▶</span>
              </div>
            </div>
            <div class="layer-details collapsed" id="${safeId}_details">
              <div class="opacity-control">
                <label>Opacity: <span id="${safeId}_opacityValue">70</span>%</label>
                <input type="range" class="opacity-slider" id="${safeId}_opacity" min="0" max="100" value="70" disabled>
              </div>
              <div class="opacity-control" style="margin-top: 8px;">
                <label>Colormap:</label>
                <select id="${safeId}_colormap" class="dem-colormap-select" disabled style="width: 100%; padding: 6px; border-radius: 4px; border: 1px solid #ddd; margin-top: 4px;">
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
        } else {
          // Regular TIF (orthomosaic) - simple checkbox with consistent styling matching DEM headers
          layerDiv.innerHTML = `
            <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: #333;">
              <input type="checkbox" class="tif-layer-checkbox" data-tif-id="${tif.id}" data-cog-path="${tif.cog_path}" data-type="${tif.type}" ${shouldAutoLoad ? 'checked' : ''}>
              <span>📷 ${tif.name}</span>
            </label>
          `;
        }
        
        mapFileSection.appendChild(layerDiv);
        
        // Add header click listener for DEM layers
        if (isDEM) {
          const header = layerDiv.querySelector(`.tif-header-${safeId}`);
          header.addEventListener('click', () => {
            toggleLayerDetails(`${safeId}_details`);
          });
        }
        
        // Add change listener
        const checkbox = layerDiv.querySelector('.tif-layer-checkbox');
        const opacitySlider = layerDiv.querySelector(`#${safeId}_opacity`);
        const colormapSelect = layerDiv.querySelector(`#${safeId}_colormap`);
        
        checkbox.addEventListener('change', (e) => {
          if (e.target.checked) {
            loadTifLayer(tif);
            // Enable controls for DEM
            if (isDEM && opacitySlider) opacitySlider.disabled = false;
            if (isDEM && colormapSelect) colormapSelect.disabled = false;
          } else {
            removeTifLayer(tif.id);
            // Disable controls for DEM
            if (isDEM && opacitySlider) opacitySlider.disabled = true;
            if (isDEM && colormapSelect) colormapSelect.disabled = true;
          }
        });
        
        // Add opacity slider listener for DEM
        if (isDEM && opacitySlider) {
          opacitySlider.addEventListener('input', (e) => {
            setTifOpacity(tif.id, e.target.value, safeId);
          });
        }
        
        // Add colormap change listener for DEM
        if (isDEM && colormapSelect) {
          colormapSelect.addEventListener('change', (e) => {
            updateTifColormap(tif, safeId);
          });
        }
        
        // Auto-load orthomosaic TIF
        if (shouldAutoLoad) {
          loadTifLayer(tif);
          if (isDEM && opacitySlider) opacitySlider.disabled = false;
          if (isDEM && colormapSelect) colormapSelect.disabled = false;
        }
      });
      
      // Re-append the shapefile container to ensure it stays at the bottom of map files
      const finalShapefileContainer = document.getElementById('shapefileLayersContainer');
      if (finalShapefileContainer) {
        mapFileSection.appendChild(finalShapefileContainer);
      } else {
        // Create it if it doesn't exist
        const newContainer = document.createElement('div');
        newContainer.id = 'shapefileLayersContainer';
        mapFileSection.appendChild(newContainer);
      }
    }
    
    async function loadProjectShapefiles() {
      const shapefileContainer = document.getElementById('shapefileLayersContainer');
      if (!shapefileContainer || !currentProject.shapefiles) return;
      
      shapefileContainer.innerHTML = '';
      
      for (const shapefile of currentProject.shapefiles) {
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
                <input type="checkbox" class="shapefile-checkbox" data-shapefile-name="${shapefile.name}" data-shapefile-path="${shapefilePath}" data-shapefile-id="${safeId}">
                <span>${shapefile.name}</span>
              </label>
              <span class="layer-collapse-icon" id="shapefile_${safeId}_detailsIcon">▶</span>
            </div>
          </div>
          <div class="layer-details collapsed" id="shapefile_${safeId}_details">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
              <label style="font-size:11px; color:#aaa; display:flex; align-items:center; gap:3px; cursor:pointer;">
                <input type="checkbox" class="shapefile-border-only" id="shapefile_${safeId}_borderOnly" data-shapefile-name="${shapefile.name}" data-safe-id="${safeId}" disabled> Border only
              </label>
            </div>
            <div class="opacity-control">
              <label>Opacity: <span id="shapefile_${safeId}_opacityValue">80</span>%</label>
              <input type="range" class="opacity-slider shapefile-opacity-slider" id="shapefile_${safeId}_opacity" min="0" max="100" value="80" disabled data-shapefile-name="${shapefile.name}" data-safe-id="${safeId}">
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
        const borderOnlyCheckbox = layerDiv.querySelector(`#shapefile_${safeId}_borderOnly`);

        // Opacity slider listener
        opacitySlider.addEventListener('input', (e) => {
          setShapefileOpacity(shapefile.name, e.target.value, safeId);
        });

        // Border-only toggle
        if (borderOnlyCheckbox) {
          borderOnlyCheckbox.addEventListener('change', () => {
            toggleShapefileBorderOnly(shapefile.name, borderOnlyCheckbox.checked, safeId);
          });
        }

        checkbox.addEventListener('change', async (e) => {
          if (e.target.checked) {
            await loadShapefileLayer(shapefile, safeId);
            // Enable controls when shapefile is loaded
            if (opacitySlider) opacitySlider.disabled = false;
            if (borderOnlyCheckbox) borderOnlyCheckbox.disabled = false;
          } else {
            removeShapefileLayer(shapefile.name);
            // Disable controls when shapefile is removed
            if (opacitySlider) opacitySlider.disabled = true;
            if (borderOnlyCheckbox) borderOnlyCheckbox.disabled = true;
          }
        });
      }
    }
    
    async function loadShapefileLayer(shapefile, safeId) {
      console.log('Loading shapefile:', shapefile.name);
      
      // Use shapefile_path property (from project creator)
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
        // Fetch the shapefile GeoJSON
        const fetchUrl = `${serverUrl}/api/file-projects/shapefile?path=${encodeURIComponent(shapefilePath)}`;
        console.log('🌐 Fetching shapefile from:', fetchUrl);
        
        const response = await fetch(fetchUrl);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`❌ Shapefile load failed (${response.status}):`, errorText);
          alert(`Failed to load shapefile: ${shapefile.name}\nError: ${errorText}`);
          // Uncheck the box
          const checkbox = document.querySelector(`[data-shapefile-name="${shapefile.name}"]`);
          if (checkbox) checkbox.checked = false;
          return;
        }
        
        const geojson = await response.json();
        console.log('📊 GeoJSON features:', geojson.features?.length || 0);
        console.log('📍 GeoJSON sample:', geojson.features?.[0]);
        
        if (!geojson.features || geojson.features.length === 0) {
          console.warn('⚠️ Shapefile has no features');
          alert(`Shapefile "${shapefile.name}" is empty (no features)`);
          const checkbox = document.querySelector(`[data-shapefile-name="${shapefile.name}"]`);
          if (checkbox) checkbox.checked = false;
          return;
        }
        
        // Create layer - explicitly use shapefilePane so it stays below annotations
        const layer = L.geoJSON(geojson, {
          pane: 'shapefilePane',
          style: {
            color: '#ff7800',
            weight: 2,
            opacity: 0.8,
            fillOpacity: 0.15
          }
        });
        
        // Store layer data
        shapefileLayers[shapefile.name] = {
          layer: layer,
          visible: true,
          opacity: 80
        };
        
        // Add to map
        layer.addTo(map);
        
        // Get bounds for debugging
        const bounds = layer.getBounds();
        const boundsInfo = {
          southwest: [bounds.getSouth(), bounds.getWest()],
          northeast: [bounds.getNorth(), bounds.getEast()],
          center: bounds.getCenter()
        };
        console.log('✅ Loaded shapefile:', shapefile.name);
        console.log('📏 Shapefile bounds:', boundsInfo);
        console.log('📍 Center:', boundsInfo.center.lat, boundsInfo.center.lng);
        
        // Check if shapefile might be off-screen from current map view
        if (map.getBounds) {
          const mapBounds = map.getBounds();
          const shapefileVisible = mapBounds.intersects(bounds);
          console.log('👁️ Shapefile visible in current view:', shapefileVisible);
          if (!shapefileVisible) {
            console.warn('⚠️ Shapefile is outside current map view!');
            console.log('💡 Tip: The shapefile loaded but might be in a different location.');
            
            // Ask if user wants to zoom to shapefile
            if (await catConfirm(`Shapefile "${shapefile.name}" loaded but is outside the current view.\n\nZoom to shapefile location?`, { ok: 'Zoom' })) {
              map.fitBounds(bounds, { padding: [50, 50] });
            }
          }
        }
      } catch (error) {
        console.error('Error loading shapefile:', error);
        alert(`Error loading shapefile: ${shapefile.name}`);
        // Uncheck the box
        const checkbox = document.querySelector(`[data-shapefile-name="${shapefile.name}"]`);
        if (checkbox) checkbox.checked = false;
      }
    }
    
    function removeShapefileLayer(shapefileName) {
      if (shapefileLayers[shapefileName]) {
        map.removeLayer(shapefileLayers[shapefileName].layer);
        delete shapefileLayers[shapefileName];
        console.log('Removed shapefile:', shapefileName);
      }
    }
    
    let tifLayers = {};
    let projectBounds = null; // Store bounds for zoom functionality
    let demTifData = null; // Store DEM TIF data for reloading

    // Convert gs:// URIs to GDAL /vsigs/ paths required by titiler/rasterio
    function toGdalPath(path) {
      if (!path) return path;
      if (path.startsWith('gs://')) return '/vsigs/' + path.slice(5);
      return path;
    }

    // ========== CRS / Bounds Validation Helpers ==========

    /**
     * Detect bogus bounds returned by TiTiler for files with
     * LOCAL_CS or unknown CRS.  Returns { bogus, reason }.
     */
    function areBoundsBogus(bounds, crsString) {
      // CRS check – LOCAL_CS means no real geographic reference
      if (crsString && /LOCAL_CS/i.test(crsString)) {
        return { bogus: true, reason: 'LOCAL_CS' };
      }

      if (!bounds || bounds.length !== 4) {
        return { bogus: true, reason: 'missing bounds' };
      }

      const [minLng, minLat, maxLng, maxLat] = bounds;

      // TiTiler global-fallback when reprojection fails
      if (minLng <= -179.9 && minLat <= -89.9 && maxLng >= 179.9 && maxLat >= 89.9) {
        return { bogus: true, reason: 'global fallback bounds' };
      }

      return { bogus: false };
    }

    /**
     * Pull real-world lat/lon from the project's site-visit metadata
     * stored in Oracle.  Returns { lat, lon } or null.
     */
    function getMetadataFallbackCenter() {
      const vi = currentProject?.metadata?.visit_info;
      if (!vi) return null;

      const lat = parseFloat(vi.latitude);
      const lon = parseFloat(vi.longitude);

      if (isFinite(lat) && isFinite(lon)
          && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        return { lat, lon };
      }
      return null;
    }

    /**
     * Show a persistent CRS warning banner above the map.
     */
    function showCrsWarning(reason) {
      // Avoid duplicates
      if (document.getElementById('crsWarningBanner')) return;

      const banner = document.createElement('div');
      banner.id = 'crsWarningBanner';
      banner.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; z-index: 10000;
        background: linear-gradient(135deg, #f59e0b, #d97706);
        color: #fff; padding: 10px 18px; font-size: 14px; font-weight: 600;
        display: flex; align-items: center; justify-content: space-between;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      `;

      const msg = reason === 'LOCAL_CS'
        ? '🔬  Underwater LOCAL_CS imagery — coordinates are in local metres (not geographic). Annotations work normally.'
        : '⚠️  COG bounds could not be determined — map is centred on site metadata coordinates.';

      banner.innerHTML = `
        <span>${msg}</span>
        <button onclick="this.parentElement.remove()"
          style="background:rgba(255,255,255,0.25); border:none; color:#fff;
                 border-radius:4px; padding:4px 12px; cursor:pointer; font-weight:700;
                 margin-left:12px; white-space:nowrap;">✕ Dismiss</button>
      `;
      document.body.prepend(banner);
    }

    async function loadTifLayer(tif) {
      let cogPath = encodeURIComponent(toGdalPath(tif.cog_path));
      let isLocalCs = false;
      let nativeBounds = null; // bounds in the file's native CRS (metres for LOCAL_CS)

      // --- Check CRS and get VRT override for LOCAL_CS files ---
      try {
        const crsResp = await fetch(`${serverUrl}/api/check-cog-crs?url=${encodeURIComponent(tif.cog_path)}`);
        if (crsResp.ok) {
          const crsData = await crsResp.json();
          isLocalCs = crsData.is_local_cs;
          nativeBounds = crsData.bounds_native;
          if (isLocalCs && crsData.vrt_path) {
            // Use the VRT path (with EPSG:4326 assigned) for all tile requests
            cogPath = encodeURIComponent(crsData.vrt_path);
            console.log('🔧 LOCAL_CS detected — using VRT override:', crsData.vrt_path);
          }
        }
      } catch (e) {
        console.warn('CRS check failed, proceeding with original COG:', e);
      }

      let tileUrl = `${serverUrl}/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${cogPath}`;
      
      // Check if this is a DEM
      const isDEM = tif.type === 'DEM' || tif.name.toLowerCase().includes('dem');
      
      // For DEMs, fetch statistics and add proper parameters
      if (isDEM) {
        const safeId = `tif_${tif.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const colormapSelect = document.getElementById(`${safeId}_colormap`);
        const colormap = colormapSelect?.value || 'viridis';
        
        try {
          // Fetch statistics to get proper rescale values
          const statsUrl = `${serverUrl}/statistics?url=${cogPath}`;
          const statsResponse = await fetch(statsUrl);
          const stats = await statsResponse.json();
          
          console.log('DEM statistics:', stats);
          
          // Handle different statistics response formats
          const bandStats = stats.b1 || stats['1'] || (stats.statistics && stats.statistics[0]) || {};
          
          // Use percentiles if available (more robust than min/max with outliers)
          const min = bandStats.percentile_2 || bandStats.min || -10;
          const max = bandStats.percentile_98 || bandStats.max || 10;
          
          console.log('Using DEM rescale:', min, 'to', max);
          
          // Add DEM parameters: band index, colormap, and rescale
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
      
      // Use full opacity for orthomosaics (1.0), lower for DEMs (0.7) to show underlying layers
      const defaultOpacity = isDEM ? 0.7 : 1.0;

      // Constrain tile requests to known raster bounds when possible (avoids out-of-range 500s)
      let rasterBounds = null;
      if (Array.isArray(tif.bounds) && tif.bounds.length === 4) {
        const [minLng, minLat, maxLng, maxLat] = tif.bounds;
        const validGeographicBounds =
          Number.isFinite(minLng) && Number.isFinite(minLat) && Number.isFinite(maxLng) && Number.isFinite(maxLat) &&
          Math.abs(minLng) <= 180 && Math.abs(maxLng) <= 180 &&
          Math.abs(minLat) <= 90 && Math.abs(maxLat) <= 90 &&
          minLng < maxLng && minLat < maxLat;

        if (validGeographicBounds) {
          rasterBounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
        }
      }
      
      const layer = L.tileLayer(tileUrl, {
        tms: false,
        opacity: defaultOpacity,
        attribution: tif.name,
        maxZoom: 2000,  // Match basic viewer setting
        minZoom: 0,
        tileSize: 256,
        errorTileUrl: '',  // Don't show broken image icons
        crossOrigin: true,
        noWrap: true,
        bounds: rasterBounds || undefined
      });
      
      layer.addTo(map);
      tifLayers[tif.id] = layer;

      const applyResolvedBoundsToLayer = (minLng, minLat, maxLng, maxLat) => {
        const resolvedBounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
        layer.options.bounds = resolvedBounds;
        layer.redraw();
      };
      
      // Store DEM layer reference for opacity and colormap controls
      if (isDEM) {
        demLayer = layer;
        // Show DEM global controls when a DEM is loaded
        const demControls = document.getElementById('demGlobalControls');
        if (demControls) {
          demControls.style.display = 'block';
        }
      }
      
      // Add error handler (only log first few errors)
      layer.on('tileerror', (error) => {
        tileErrorCount++;
        if (tileErrorCount <= 3) {
          console.error('❌ Tile load error #' + tileErrorCount + ':', error.tile.src);
        }
        if (tileErrorCount === 10) {
          console.error('⚠️ Suppressing further tile error messages...');
        }
      });
      
      // Track tile loading (only log first few to avoid spam)
      let tileLoadCount = 0;
      let tileErrorCount = 0;
      
      layer.on('tileloadstart', (e) => {
        if (tileLoadCount < 3) {
          console.log('📥 Tile request:', e.tile.src);
          tileLoadCount++;
        }
      });
      
      layer.on('tileload', (e) => {
        if (tileLoadCount <= 3) {
          console.log('✅ Tile loaded successfully:', e.tile.naturalWidth, 'x', e.tile.naturalHeight);
        }
      });
      
      // Store bounds if available and zoom to it
      // If bounds are not in tif metadata (e.g. loaded from DB), fetch from titiler /info
      let boundsToUse = (tif.bounds && tif.bounds.length === 4) ? tif.bounds : null;
      let cogCrs = null; // CRS string from /info (for LOCAL_CS detection)

      // For LOCAL_CS with VRT: always fetch bounds from /info on the VRT
      // (the VRT has EPSG:4326 so bounds = native metres treated as degrees)
      if (isLocalCs && nativeBounds && nativeBounds.length === 4) {
        // nativeBounds from /api/check-cog-crs are [left, bottom, right, top]
        boundsToUse = nativeBounds;
        cogCrs = 'LOCAL_CS_VRT_OVERRIDE';
        console.log('📐 Using native bounds from VRT override:', boundsToUse);
      } else if (!boundsToUse) {
        try {
          const infoUrl = `${serverUrl}/info?url=${cogPath}`;
          const infoResp = await fetch(infoUrl);
          if (infoResp.ok) {
            const info = await infoResp.json();
            if (info.bounds && info.bounds.length === 4) {
              boundsToUse = info.bounds; // [minLng, minLat, maxLng, maxLat]
              console.log('📐 Fetched bounds from /info:', boundsToUse);
            }
            // Capture CRS string for LOCAL_CS detection
            if (info.crs) {
              cogCrs = typeof info.crs === 'string' ? info.crs : JSON.stringify(info.crs);
              console.log('📐 COG CRS:', cogCrs);
            }
          }
        } catch (e) {
          console.warn('Could not fetch bounds from /info:', e);
        }
      }

      // --- LOCAL_CS with VRT: zoom to native bounds (metres as degrees) ---
      if (isLocalCs && boundsToUse && boundsToUse.length === 4) {
        const [minLng, minLat, maxLng, maxLat] = boundsToUse;
        projectBounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
        applyResolvedBoundsToLayer(minLng, minLat, maxLng, maxLat);

        console.log('📍 LOCAL_CS project bounds (metres → degrees):', {
          southwest: [minLat, minLng],
          northeast: [maxLat, maxLng],
          center: projectBounds.getCenter()
        });

        if (Object.keys(tifLayers).length === 1) {
          map.fitBounds(projectBounds, { padding: [50, 50], maxZoom: 22 });
          console.log('🎯 Zoomed to LOCAL_CS imagery bounds via VRT');
        }
        showCrsWarning('LOCAL_CS');
        showStatus('🔬 LOCAL_CS imagery loaded — coordinates are local metres', 'info');
      }
      // --- Normal CRS: validate bounds ---
      else {
        const boundsCheck = areBoundsBogus(boundsToUse, cogCrs);

        if (boundsCheck.bogus) {
          console.warn(`⚠️ Bogus COG bounds detected (${boundsCheck.reason}):`, boundsToUse);

          const fallback = getMetadataFallbackCenter();
          if (fallback) {
            console.log(`📍 Using metadata fallback center: ${fallback.lat}, ${fallback.lon}`);
            if (Object.keys(tifLayers).length === 1) {
              map.setView([fallback.lat, fallback.lon], 18, { animate: true });
              console.log('🎯 Zoomed to metadata site location');
            }
            showCrsWarning(boundsCheck.reason);
            showStatus(`⚠️ COG has ${boundsCheck.reason} — centred on site metadata`, 'warning');
          } else {
            console.warn('⚠️ No metadata lat/lon fallback available');
            showCrsWarning(boundsCheck.reason);
            showStatus('⚠️ COG has no valid bounds and no metadata fallback', 'warning');
          }
        } else if (boundsToUse) {
          const [minLng, minLat, maxLng, maxLat] = boundsToUse;

          // Sanity check: reject obviously invalid coordinates
          const looksInvalid = Math.abs(minLng) > 180 || Math.abs(maxLng) > 180
                            || Math.abs(minLat) > 90  || Math.abs(maxLat) > 90;

          if (looksInvalid) {
            console.warn('⚠️ Bounds look invalid (out of lat/lon range):', boundsToUse);
            const fallback = getMetadataFallbackCenter();
            if (fallback && Object.keys(tifLayers).length === 1) {
              map.setView([fallback.lat, fallback.lon], 18, { animate: true });
              showCrsWarning('projected coordinates');
              showStatus('⚠️ COG bounds out of range — centred on site metadata', 'warning');
            }
          } else {
            projectBounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
            applyResolvedBoundsToLayer(minLng, minLat, maxLng, maxLat);

            console.log('📍 Project bounds:', {
              southwest: [minLat, minLng],
              northeast: [maxLat, maxLng],
              center: projectBounds.getCenter()
            });

            if (Object.keys(tifLayers).length === 1) {
              map.fitBounds(projectBounds, { padding: [50, 50], maxZoom: 22 });
              console.log('🎯 Zoomed to layer bounds:', projectBounds);
            }
          }
        }
      }
      
      console.log('✅ Loaded layer:', tif.name);
    }
    
    function removeTifLayer(tifId) {
      if (tifLayers[tifId]) {
        map.removeLayer(tifLayers[tifId]);
        
        // If this is the DEM layer, hide controls and clear reference
        if (tifLayers[tifId] === demLayer) {
          demLayer = null;
          const demControls = document.getElementById('demGlobalControls');
          if (demControls) {
            demControls.style.display = 'none';
          }
        }
        
        delete tifLayers[tifId];
      }
    }
    
    function loadProjectAnnotations() {
      // Clear existing annotations
      drawnItems.clearLayers();
      annotations = [];
      
      // Check if project has imported annotations
      if (currentProject.annotations && Array.isArray(currentProject.annotations)) {
        console.log(`📥 Loading ${currentProject.annotations.length} imported annotations from project...`);
        projectAnnotations = currentProject.annotations;
      }
      
      // Load annotations from project
      projectAnnotations.forEach((ann, idx) => {
        const layer = L.geoJSON(ann.geometry, {
          pane: 'annotationsPane',  // Ensure annotations are in the top pane
          style: {
            color: '#3388ff',
            weight: 7,
            opacity: 0.8,
            fillOpacity: 0.3
          }
        }).getLayers()[0];
        
        // Normalize annotation format: if properties are nested, flatten them to root level
        // Preserve DB tracking fields (_dbAnnotationId, _dbAnnotationVersion, _syncStatus)
        let normalizedAnn = {...ann};
        if (ann.properties && typeof ann.properties === 'object') {
          // Merge properties to root level for compatibility with existing code
          normalizedAnn = {
            ...ann.properties,
            geometry: ann.geometry
          };
          // Carry over DB tracking fields from the parent object
          if (ann._dbAnnotationId != null) normalizedAnn._dbAnnotationId = ann._dbAnnotationId;
          if (ann._dbAnnotationVersion != null) normalizedAnn._dbAnnotationVersion = ann._dbAnnotationVersion;
          if (ann._syncStatus) normalizedAnn._syncStatus = ann._syncStatus;
          if (ann.id != null) normalizedAnn.id = ann.id;
        }
        
        // Add the array index as the display ID (for consistent referencing)
        normalizedAnn._displayIndex = idx + 1;
        
        layer.annotationData = normalizedAnn;

        // Apply correct style: orange-dashed if no species, blue if complete
        if (typeof getAnnotationLayerStyle === 'function' && layer.setStyle) {
          layer.setStyle(getAnnotationLayerStyle(normalizedAnn));
        }
        
        // Add click handler to show popup with details
        layer.on('click', function(e) {
          showAnnotationPopup(layer, e.latlng);
        });
        
        drawnItems.addLayer(layer);
        annotations.push(normalizedAnn);
      });
      
      // Add labels AFTER all layers are added to the map
      if (labelsVisible) {
        console.log('📍 Adding labels to all annotations...');
        showAllAnnotationLabels();
      }
      
      updateAnnotationTable();
      console.log(`✅ Loaded ${annotations.length} annotations`);
      
      // Show import info if annotations were imported
      if (currentProject.metadata?.imported_annotations) {
        const importInfo = currentProject.metadata.imported_annotations;
        console.log(`ℹ️ Imported ${importInfo.count} annotations from "${importInfo.source_file}"`);
      }
    }
    

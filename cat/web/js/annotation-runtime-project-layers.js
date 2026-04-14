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
      if (!window._catPopoutMode) {
        loadProjectLayers();
        // Initialize overlay layers (shapefiles) for DB projects
        if (typeof initializeOverlayControls === 'function') {
          initializeOverlayControls(numericId);
        }
      }
      loadProjectAnnotations();
      startTimer();

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
          // Regular TIF (orthomosaic) — compact row + gear button opens right-side drawer
          cogTifRegistry[tif.id] = tif;
          layerDiv.innerHTML = `
            <div class="layer-header" style="display:flex;align-items:center;justify-content:space-between;padding:4px 2px;">
              <label style="display:flex;align-items:center;gap:8px;flex:1;cursor:pointer;">
                <input type="checkbox" class="tif-layer-checkbox" data-tif-id="${tif.id}" data-cog-path="${tif.cog_path}" data-type="${tif.type}" ${shouldAutoLoad ? 'checked' : ''}>
                <span style="font-size:13px;font-weight:600;color:#333;">📷 ${tif.name}</span>
              </label>
              <button class="cog-settings-open-btn" title="COG Settings"
                style="background:none;border:1px solid #d1d5db;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:13px;color:#555;line-height:1.4;">⚙</button>
            </div>
          `;

          layerDiv.querySelector('.cog-settings-open-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openCogSettingsDrawer(tif);
          });
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
            if (isDEM && opacitySlider) opacitySlider.disabled = false;
            if (isDEM && colormapSelect) colormapSelect.disabled = false;
          } else {
            removeTifLayer(tif.id);
            if (isDEM && opacitySlider) opacitySlider.disabled = true;
            if (isDEM && colormapSelect) colormapSelect.disabled = true;
          }
        });

        // DEM: opacity slider
        if (isDEM && opacitySlider) {
          opacitySlider.addEventListener('input', (e) => {
            setTifOpacity(tif.id, e.target.value, safeId);
          });
        }

        // DEM: colormap
        if (isDEM && colormapSelect) {
          colormapSelect.addEventListener('change', (e) => {
            updateTifColormap(tif, safeId);
          });
        }

        // Non-DEM: all controls live in the drawer; nothing to wire up here

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

    // TiTiler URL params per tif.id — gamma, saturation, contrast, rescale
    let cogVisualSettings = {};
    // CSS pane filter settings per tif.id — sharpness, noiseReduction, grayscale, hueRotate
    let cogPaneSettings = {};
    // Registry: tif.id → tif object, so the drawer can look up any layer
    let cogTifRegistry = {};

    function ensureSharpenFilter() {
      if (document.getElementById('cogFilterDefs')) return;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'cogFilterDefs';
      svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
      svg.innerHTML = `<defs>
        <filter id="cogSharpen" x="0" y="0" width="100%" height="100%">
          <feConvolveMatrix order="3" kernelMatrix="0 0 0 0 1 0 0 0 0" preserveAlpha="true"/>
        </filter>
      </defs>`;
      document.body.appendChild(svg);
    }

    function ensureCogDrawer() {
      if (document.getElementById('cogSettingsDrawer')) return;
      const style = document.createElement('style');
      style.textContent = `
        #cogSettingsDrawer {
          position: fixed; top: 0; right: 0; width: 300px; height: 100%;
          background: #fff; z-index: 9998;
          transform: translateX(105%);
          transition: transform 0.25s cubic-bezier(0.4,0,0.2,1);
          box-shadow: -6px 0 28px rgba(0,0,0,0.14);
          overflow-y: auto; padding: 0; box-sizing: border-box;
          font-family: inherit;
        }
        #cogSettingsDrawer.cog-drawer-open { transform: translateX(0); }
        .cog-drawer-section { padding: 12px 14px; border-bottom: 1px solid #f0f0f0; }
        .cog-drawer-section-title { font-size: 11px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
        .cog-drawer-row { margin-bottom: 6px; }
        .cog-drawer-row label { display: flex; justify-content: space-between; font-size: 11px; color: #444; margin-bottom: 2px; }
        .cog-drawer-row input[type=range] { width: 100%; height: 4px; }
        .cog-preset-btn { flex: 1; padding: 5px 4px; background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: 600; }
        .cog-preset-btn:hover { background: #e5e7eb; }
        .cog-action-btn { flex: 1; padding: 6px; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600; }
      `;
      document.head.appendChild(style);
      const drawer = document.createElement('div');
      drawer.id = 'cogSettingsDrawer';
      document.body.appendChild(drawer);
    }

    function openCogSettingsDrawer(tif) {
      ensureSharpenFilter();
      ensureCogDrawer();
      const drawer = document.getElementById('cogSettingsDrawer');
      const vs = cogVisualSettings[tif.id] || {};
      const ps = cogPaneSettings[tif.id] || {};
      const v  = (key, def) => vs[key] ?? def;
      const p  = (key, def) => ps[key] ?? def;

      drawer.innerHTML = `
        <div style="position:sticky;top:0;background:#fff;z-index:1;padding:14px 14px 10px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;">
          <div style="font-weight:700;font-size:13px;color:#111;">⚙ COG Settings</div>
          <div style="font-size:11px;color:#888;flex:1;margin:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${tif.name}</div>
          <button id="cogDrawerClose" style="background:none;border:none;font-size:20px;cursor:pointer;color:#999;line-height:1;padding:0;">✕</button>
        </div>

        <div class="cog-drawer-section">
          <div class="cog-drawer-section-title">Opacity</div>
          <div class="cog-drawer-row">
            <label>Opacity <span id="d_opacityValue">${Math.round((tifLayers[tif.id]?.options?.opacity ?? 1) * 100)}</span>%</label>
            <input type="range" id="d_opacity" min="0" max="100" value="${Math.round((tifLayers[tif.id]?.options?.opacity ?? 1) * 100)}">
          </div>
        </div>

        <div class="cog-drawer-section">
          <div class="cog-drawer-section-title">Image Tone</div>
          <div class="cog-drawer-row">
            <label>Brightness (γ) <span id="d_gammaValue">${(v('gamma', 1)).toFixed(1)}</span></label>
            <input type="range" id="d_gamma" min="50" max="300" value="${Math.round(v('gamma', 1) * 100)}">
          </div>
          <div class="cog-drawer-row">
            <label>Saturation <span id="d_saturationValue">${(v('saturation', 1)).toFixed(1)}</span></label>
            <input type="range" id="d_saturation" min="0" max="200" value="${Math.round(v('saturation', 1) * 100)}">
          </div>
          <div class="cog-drawer-row">
            <label>Contrast <span id="d_contrastValue">${v('contrast', 0)}</span></label>
            <input type="range" id="d_contrast" min="0" max="50" value="${v('contrast', 0)}">
          </div>
        </div>

        <div class="cog-drawer-section">
          <div class="cog-drawer-section-title">Color Balance</div>
          <div class="cog-drawer-row">
            <label>Red <span id="d_gammaRValue">${(v('gammaR', 1)).toFixed(1)}</span></label>
            <input type="range" id="d_gammaR" min="50" max="300" value="${Math.round(v('gammaR', 1) * 100)}" style="accent-color:#ef4444;">
          </div>
          <div class="cog-drawer-row">
            <label>Green <span id="d_gammaGValue">${(v('gammaG', 1)).toFixed(1)}</span></label>
            <input type="range" id="d_gammaG" min="50" max="300" value="${Math.round(v('gammaG', 1) * 100)}" style="accent-color:#22c55e;">
          </div>
          <div class="cog-drawer-row">
            <label>Blue <span id="d_gammaBValue">${(v('gammaB', 1)).toFixed(1)}</span></label>
            <input type="range" id="d_gammaB" min="50" max="300" value="${Math.round(v('gammaB', 1) * 100)}" style="accent-color:#3b82f6;">
          </div>
        </div>

        <div class="cog-drawer-section">
          <div class="cog-drawer-section-title">Display Effects</div>
          <div class="cog-drawer-row">
            <label>Sharpness <span id="d_sharpnessValue">${p('sharpness', 0)}</span></label>
            <input type="range" id="d_sharpness" min="0" max="10" step="1" value="${p('sharpness', 0)}">
          </div>
<div style="display:flex;align-items:center;gap:12px;margin-top:6px;">
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
              <input type="checkbox" id="d_grayscale" ${p('grayscale', false) ? 'checked' : ''}> Grayscale
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;flex:1;">
              Hue <span id="d_hueValue">${p('hueRotate', 0)}</span>°
              <input type="range" id="d_hue" min="-180" max="180" step="5" value="${p('hueRotate', 0)}" style="flex:1;">
            </label>
          </div>
        </div>

        <div class="cog-drawer-section">
          <div class="cog-drawer-section-title">Presets</div>
          <div style="display:flex;gap:4px;">
            <button class="cog-preset-btn" id="d_presetNatural">Natural</button>
            <button class="cog-preset-btn" id="d_presetEnhanced">Enhanced</button>
            <button class="cog-preset-btn" id="d_presetVivid">Vivid</button>
            <button class="cog-preset-btn" id="d_presetCoral">Coral</button>
          </div>
        </div>

        <div class="cog-drawer-section" style="display:flex;gap:8px;">
          <button class="cog-action-btn" id="d_autoLevels" style="background:#0891b2;">Auto Levels</button>
          <button class="cog-action-btn" id="d_reset"      style="background:#6b7280;">Reset All</button>
        </div>
        <div style="padding:6px 14px 14px;font-size:10px;color:#aaa;">Auto Levels stretches range to p2–p98</div>
      `;

      // Close
      document.getElementById('cogDrawerClose').addEventListener('click', () =>
        drawer.classList.remove('cog-drawer-open'));

      // Helpers
      const setVis = (key, val) => {
        if (!cogVisualSettings[tif.id]) cogVisualSettings[tif.id] = {};
        cogVisualSettings[tif.id][key] = val;
        if (tifLayers[tif.id]) reloadCogWithSettings(tif);
      };
      const setPane = (key, val) => {
        if (!cogPaneSettings[tif.id]) cogPaneSettings[tif.id] = {};
        cogPaneSettings[tif.id][key] = val;
        applyPaneFilter(tif.id);
      };
      const q = id => document.getElementById(id);

      // Opacity
      q('d_opacity').addEventListener('input', e => {
        q('d_opacityValue').textContent = e.target.value;
        const layer = tifLayers[tif.id];
        if (layer) layer.setOpacity(e.target.value / 100);
      });

      // Image Tone
      q('d_gamma').addEventListener('change', e => { const v = e.target.value/100; q('d_gammaValue').textContent = v.toFixed(1); setVis('gamma', v); });
      q('d_saturation').addEventListener('change', e => {
        const v = e.target.value / 100;
        q('d_saturationValue').textContent = v.toFixed(1);
        q('d_grayscale').checked = (v === 0);
        setVis('saturation', v);
      });
      q('d_contrast').addEventListener('change', e => { const v = parseInt(e.target.value); q('d_contrastValue').textContent = v; setVis('contrast', v); });

      // Color Balance
      q('d_gammaR').addEventListener('change', e => { const v = e.target.value/100; q('d_gammaRValue').textContent = v.toFixed(1); setVis('gammaR', v); });
      q('d_gammaG').addEventListener('change', e => { const v = e.target.value/100; q('d_gammaGValue').textContent = v.toFixed(1); setVis('gammaG', v); });
      q('d_gammaB').addEventListener('change', e => { const v = e.target.value/100; q('d_gammaBValue').textContent = v.toFixed(1); setVis('gammaB', v); });

      // Display Effects
      q('d_sharpness').addEventListener('input', e => { const v = parseInt(e.target.value); q('d_sharpnessValue').textContent = v; setPane('sharpness', v); });
      // Grayscale = saturation 0 (tile reload) — no CSS filter needed
      q('d_grayscale').addEventListener('change', e => {
        const sat = e.target.checked ? 0 : 1;
        if (!cogVisualSettings[tif.id]) cogVisualSettings[tif.id] = {};
        cogVisualSettings[tif.id].saturation = sat;
        q('d_saturation').value = sat * 100;
        q('d_saturationValue').textContent = sat.toFixed(1);
        if (tifLayers[tif.id]) reloadCogWithSettings(tif);
      });
      q('d_hue').addEventListener('input', e => { const v = parseInt(e.target.value); q('d_hueValue').textContent = v; setPane('hueRotate', v); });

      // Sync drawer sliders from state (called by applyPreset)
      const syncDrawer = () => {
        const vs2 = cogVisualSettings[tif.id] || {};
        const ps2 = cogPaneSettings[tif.id]   || {};
        const vv = (k,d) => vs2[k] ?? d;
        const pp = (k,d) => ps2[k] ?? d;
        q('d_gamma').value = Math.round(vv('gamma',1)*100);     q('d_gammaValue').textContent     = vv('gamma',1).toFixed(1);
        q('d_saturation').value = Math.round(vv('saturation',1)*100); q('d_saturationValue').textContent = vv('saturation',1).toFixed(1);
        q('d_contrast').value = vv('contrast',0);               q('d_contrastValue').textContent  = vv('contrast',0);
        q('d_gammaR').value = Math.round(vv('gammaR',1)*100);   q('d_gammaRValue').textContent    = vv('gammaR',1).toFixed(1);
        q('d_gammaG').value = Math.round(vv('gammaG',1)*100);   q('d_gammaGValue').textContent    = vv('gammaG',1).toFixed(1);
        q('d_gammaB').value = Math.round(vv('gammaB',1)*100);   q('d_gammaBValue').textContent    = vv('gammaB',1).toFixed(1);
        q('d_sharpness').value = pp('sharpness',0);             q('d_sharpnessValue').textContent = pp('sharpness',0);
        q('d_hue').value = pp('hueRotate',0);                   q('d_hueValue').textContent       = pp('hueRotate',0);
        q('d_grayscale').checked = !!pp('grayscale',false);
      };

      const applyPreset = (visS, paneS) => {
        cogVisualSettings[tif.id] = { ...visS };
        cogPaneSettings[tif.id]   = { ...paneS };
        syncDrawer();
        applyPaneFilter(tif.id);
        if (tifLayers[tif.id]) reloadCogWithSettings(tif);
      };

      q('d_presetNatural').addEventListener('click',  () => applyPreset({}, {}));
      q('d_presetEnhanced').addEventListener('click', () => applyPreset({ gamma:1.2, saturation:1.3, contrast:8  }, { sharpness:2 }));
      q('d_presetVivid').addEventListener('click',    () => applyPreset({ saturation:1.8, contrast:15           }, { sharpness:3 }));
      q('d_presetCoral').addEventListener('click',    () => applyPreset({ gammaR:1.4, gammaG:1.0, gammaB:0.75, saturation:1.4, contrast:6 }, { sharpness:2 }));

      q('d_autoLevels').addEventListener('click', () => { if (tifLayers[tif.id]) applyAutoStretch(tif); });

      q('d_reset').addEventListener('click', () => {
        applyPreset({}, {});
        const layer = tifLayers[tif.id];
        if (layer) { layer.setOpacity(1.0); q('d_opacity').value = 100; q('d_opacityValue').textContent = '100'; }
        const pane = map.getPane('cogPane');
        if (pane) pane.style.filter = '';
      });

      drawer.classList.add('cog-drawer-open');
    }

    function applyPaneFilter(tifId) {
      const ps = cogPaneSettings[tifId] || {};
      const filters = [];
      const sharpness = ps.sharpness ?? 0;
      if (sharpness > 0) {
        const edge   = sharpness * 0.5;
        const center = sharpness * 2 + 1;
        const feFilter = document.querySelector('#cogSharpen feConvolveMatrix');
        if (feFilter) feFilter.setAttribute('kernelMatrix',
          `0 -${edge.toFixed(2)} 0 -${edge.toFixed(2)} ${center.toFixed(2)} -${edge.toFixed(2)} 0 -${edge.toFixed(2)} 0`);
        filters.push('url(#cogSharpen)');
      }
      if (ps.hueRotate)          filters.push(`hue-rotate(${ps.hueRotate}deg)`);
      // grayscale is handled via saturation=0 in cogVisualSettings (tile reload), not CSS
      const filterStr = filters.join(' ') || 'none';
      // Apply to layer container directly — survives layer reload via reloadCogWithSettings
      const layer = tifLayers[tifId];
      if (layer && layer._container) {
        layer._container.style.filter = filterStr;
      } else {
        // Fallback: apply to pane so it's ready when layer loads
        const pane = map.getPane('cogPane');
        if (pane) pane.style.filter = filterStr;
      }
    }

    function buildColorFormula(settings) {
      const parts = [];
      const gamma = settings.gamma ?? 1.0;
      const sat   = settings.saturation ?? 1.0;
      const cont  = settings.contrast ?? 0;
      const gR    = settings.gammaR ?? 1.0;
      const gG    = settings.gammaG ?? 1.0;
      const gB    = settings.gammaB ?? 1.0;

      if (gamma !== 1.0) parts.push(`gamma RGB ${gamma.toFixed(2)}`);
      if (cont > 0)      parts.push(`sigmoidal RGB ${cont} 0.5`);
      if (sat !== 1.0)   parts.push(`saturation ${sat.toFixed(2)}`);
      if (gR !== 1.0)    parts.push(`gamma R ${gR.toFixed(2)}`);
      if (gG !== 1.0)    parts.push(`gamma G ${gG.toFixed(2)}`);
      if (gB !== 1.0)    parts.push(`gamma B ${gB.toFixed(2)}`);
      return parts.length ? parts.join(' ') : null;
    }

    function reloadCogWithSettings(tif) {
      const center = map.getCenter();
      const zoom   = map.getZoom();
      removeTifLayer(tif.id);
      loadTifLayer(tif).then(() => {
        map.setView(center, zoom, { animate: false });
        applyPaneFilter(tif.id); // re-apply CSS filters to the new layer container
      });
    }

    async function applyAutoStretch(tif) {
      const cogPath = encodeURIComponent(toGdalPath(tif.cog_path));
      const statsUrl = `${serverUrl}/statistics?url=${cogPath}`;
      try {
        const res   = await fetch(statsUrl);
        const stats = await res.json();
        const b1    = stats.b1 || stats['1'] || {};
        const p2    = b1.percentile_2  ?? 0;
        const p98   = b1.percentile_98 ?? 255;
        if (!cogVisualSettings[tif.id]) cogVisualSettings[tif.id] = {};
        cogVisualSettings[tif.id].rescale = `${p2},${p98}`;
        reloadCogWithSettings(tif);
      } catch (e) {
        console.warn('Auto-stretch failed:', e);
      }
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

      // For non-DEM COGs, apply any stored visual settings
      if (!isDEM) {
        const vs = cogVisualSettings[tif.id] || {};
        const formula = buildColorFormula(vs);
        if (formula)  tileUrl += `&color_formula=${encodeURIComponent(formula)}`;
        if (vs.rescale) tileUrl += `&rescale=${vs.rescale}`;
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
    

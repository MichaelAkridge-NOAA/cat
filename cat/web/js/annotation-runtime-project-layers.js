// Extracted from annotation-file-mode-runtime.js (Phase 2c: project/layers)
    // Single source of truth for whether a project load should auto-start
    // the timer, reading the same 'cat_timer_settings' key and default
    // (autoStart: false) as annotation-runtime-settings-app.js.
    function shouldAutoStartTimer() {
      try {
        const saved = JSON.parse(localStorage.getItem('cat_timer_settings') || '{}');
        return saved.autoStart === true;
      } catch (e) {
        return false;
      }
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

    const DB_PAYLOAD_EXCLUDED_KEYS = new Set([
      'properties', 'geometry', 'feature', 'id', 'annotation_id', 'version',
      'created_by_user_id', 'creator_display_name', 'creator_username', 'client_uuid'
    ]);

    // Stable fingerprint of what would be sent for an annotation. Autosave
    // compares the fingerprint taken at send time with the one after the
    // response: if the user edited the annotation while the request was in
    // flight they differ, and it stays pending instead of being marked saved.
    function annotationPayloadFingerprint(annotation) {
      const p = normalizeAnnotationForDb(annotation);
      const sortedProps = {};
      Object.keys(p.properties).sort().forEach(k => { sortedProps[k] = p.properties[k]; });
      return JSON.stringify([p.feature, sortedProps]);
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

      // Always build the saved properties from the FLAT fields. Annotations
      // used to carry a second, nested `.properties` copy (after a sync,
      // refresh or bulk draw) and this preferred it — so every edit path that
      // only writes flat fields (edit modal, batch fill, defaults, undo) was
      // silently dropped on save. Server-owned and client bookkeeping keys are
      // stripped so they never leak into properties_json.
      const properties = {};
      Object.keys(ann).forEach(k => {
        if (DB_PAYLOAD_EXCLUDED_KEYS.has(k)) return;
        if (k.charAt(0) === '_' && k !== '_localId') return;
        properties[k] = ann[k];
      });

      return {
        feature,
        properties,
        created_by: (properties.ANALYST || properties.analyst || document.getElementById('analyst')?.value || null),
        // Same UUID on every attempt to create this annotation, so the
        // server can recognise a retry of a create that already went through.
        client_uuid: getDbAnnotationId(ann) ? undefined : ensureClientUuid(ann)
      };
    }

    // crypto.randomUUID only exists in secure contexts (https / localhost);
    // CAT is often served over plain http on a workstation, so fall back to
    // getRandomValues (available everywhere) formatted as a v4 UUID.
    function _newUuid() {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        try { return window.crypto.randomUUID(); } catch (e) { /* insecure context */ }
      }
      const b = new Uint8Array(16);
      window.crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }

    function ensureClientUuid(annotation) {
      if (!annotation) return null;
      if (!annotation._clientUuid) annotation._clientUuid = _newUuid();
      return annotation._clientUuid;
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
        _syncStatus: 'synced',
        // Multi-user contributor toggle (annotation-runtime-annotations.js) needs
        // to know who made each annotation, independent of whatever's in
        // `properties` — these come from the API's LEFT JOIN cat_users, not from
        // the annotation's own editable fields.
        _creatorUserId: annotationRow?.created_by_user_id ?? null,
        _creatorLabel: annotationRow?.creator_display_name || annotationRow?.created_by || 'Unknown',
        _clientUuid: annotationRow?.client_uuid || undefined
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
          const body = await resp.json().catch(() => ({}));
          // Task 7 round 2 fix: FastAPI wraps HTTPException(detail=...) as
          // {"detail": {...}} — current_annotation lives at body.detail.
          // current_annotation, not body.current_annotation, so this always
          // read null before and conflict recovery could never adopt the
          // server's version.
          const conflictData = body.detail || body;
          const err = new Error(`Conflict: annotation #${annotationId} was modified by another user`);
          err.isConflict = true;
          err.serverAnnotation = conflictData.current_annotation ? normalizeDbAnnotationResponse(conflictData.current_annotation) : null;
          // Task A2 Step 2: the 409 body always carries current_version (see
          // db_projects.py update_annotation), even on the rare occasions
          // current_annotation fails to normalize/parse — expose it so callers
          // can advance the stale version without a valid serverAnnotation.
          err.currentVersion = conflictData.current_version != null ? conflictData.current_version : null;
          throw err;
        }
        if (resp.status === 410) {
          // Deleted (soft) by someone else — must NOT be re-created.
          const err = new Error(`Annotation #${annotationId} was deleted`);
          err.isGone = true;
          throw err;
        }
        if (resp.status === 404) {
          const err = new Error(`Annotation #${annotationId} no longer exists server-side`);
          err.isNotFound = true;
          throw err;
        }
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}));
          const err = new Error((typeof e.detail === "string" && e.detail) || `Failed to update annotation #${annotationId}`);
          err.status = resp.status;
          throw err;
        }
        const result = await resp.json();
        return normalizeDbAnnotationResponse(result.annotation);
      }

      const resp = await fetch(`${serverUrl}/api/db/projects/${projectId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (resp.status === 410) {
        // Retry of a create whose annotation was deleted meanwhile.
        const err = new Error('Annotation was deleted');
        err.isGone = true;
        throw err;
      }
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        const err = new Error((typeof e.detail === "string" && e.detail) || "Failed to create annotation");
        err.status = resp.status;
        throw err;
      }
      const result = await resp.json();
      return normalizeDbAnnotationResponse(result.annotation);
    }

    function getProjectAnnotations() {
      return projectAnnotations;
    }

    // Task 7 fix: these three helpers are required by annotation-undo.js but
    // were never defined anywhere — getDrawnItems() threw a ReferenceError on
    // every undo/redo of an add, and the typeof-guards on the other two made
    // the server-side delete/restore silently no-op.
    function getDrawnItems() {
      return drawnItems;
    }

    async function deleteAnnotationFromDb(annotation) {
      if (!isOracleProjectMode()) return null;
      const annotationId = getDbAnnotationId(annotation);
      if (!annotationId) return null;
      const resp = await fetch(`${serverUrl}/api/db/projects/${currentProject.project_id}/annotations/${annotationId}`, {
        method: 'DELETE'
      });
      // 404/410 = it is already not live on the server; that's the outcome
      // we wanted, so don't leave the row stuck on screen with an error.
      if (resp.status === 404 || resp.status === 410) {
        return { success: true, already_deleted: true, deleted_annotation_id: annotationId };
      }
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.detail || `Failed to delete annotation #${annotationId}`);
      }
      return resp.json();
    }

    async function restoreAnnotationInDb(annotationId) {
      if (!isOracleProjectMode() || !annotationId) return null;
      const resp = await fetch(`${serverUrl}/api/db/projects/${currentProject.project_id}/annotations/${annotationId}/restore`, {
        method: 'POST'
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.detail || `Failed to restore annotation #${annotationId}`);
      }
      const result = await resp.json();
      return normalizeDbAnnotationResponse(result.annotation);
    }

    function removeAnnotationFromProject(index) {
      projectAnnotations.splice(index, 1);
    }

    function updateAnnotationInProject(index, annotationData) {
      if (index >= 0 && index < projectAnnotations.length) {
        projectAnnotations[index] = annotationData;
      }
    }

    // Copy the server-owned identity (db id, version, creator) from a sync
    // response onto the EXISTING local object. Annotations are never swapped
    // for the response object any more: the table row, open form, undo stack
    // and map layer all hold references to the local object, and swapping it
    // left them editing an orphan that no save ever saw.
    function mergeServerIdentity(annotation, synced) {
      if (!annotation || !synced) return annotation;
      annotation._dbAnnotationId = synced._dbAnnotationId;
      annotation.id = synced._dbAnnotationId;
      annotation._dbAnnotationVersion = synced._dbAnnotationVersion;
      if (synced._creatorUserId !== undefined && annotation._creatorUserId == null) {
        annotation._creatorUserId = synced._creatorUserId;
      }
      if (synced._creatorLabel && !annotation._creatorLabel) {
        annotation._creatorLabel = synced._creatorLabel;
      }
      return annotation;
    }

    // Kept for callers (undo/redo) that receive a fresh server object for an
    // annotation already in the project: merge into the object at `index`
    // rather than replacing it. Layers are matched by object identity only —
    // the old `_displayIndex === index + 1` match went stale after any delete
    // and rebound one annotation's layer to another annotation's data.
    function applySyncedAnnotation(index, syncedAnnotation) {
      if (index < 0 || !syncedAnnotation) return;
      const existing = projectAnnotations[index];
      if (!existing) return;
      if (existing === syncedAnnotation) return;
      const keepLocalId = existing._localId;
      const keepDisplayIndex = existing._displayIndex;
      Object.keys(existing).forEach(k => { delete existing[k]; });
      Object.keys(syncedAnnotation).forEach(k => {
        if (k === 'properties') return; // flat shape only
        existing[k] = syncedAnnotation[k];
      });
      if (keepLocalId && !existing._localId) existing._localId = keepLocalId;
      if (keepDisplayIndex != null) existing._displayIndex = keepDisplayIndex;
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

      const overlay = document.getElementById('fullLoadingOverlay');
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
      // Everyone may view every project; only owner/editor may change it.
      // Set before anything else initializes so the edit tools never arm.
      window.catProjectRole = snapshot.my_role || 'viewer';
      window.catReadOnly = window.catProjectRole === 'viewer';
      // Clear All is owner/admin only (see clearAllAnnotations).
      const _clearAllItem = document.getElementById('ddClearAll');
      if (_clearAllItem) _clearAllItem.style.display = window.catProjectRole === 'owner' ? '' : 'none';
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

      const _uploadPanel = document.getElementById('uploadPanel');
      if (_uploadPanel) _uploadPanel.style.display = 'none';
      // '' rather than 'block': the layers sidebar (annotation-runtime-layers-sidebar.js)
      // styles this panel as a flex column when docked, and an inline 'block'
      // would beat that stylesheet.
      document.getElementById('mapLayersPanel').style.display = '';
      if (window.catReadOnly) {
        // Leave the form panel and Save button hidden; show the view-only banner.
        if (typeof catApplyReadOnlyMode === 'function') catApplyReadOnlyMode(numericId, currentProject);
      } else {
        document.getElementById('annotationFormPanel').style.display = 'block';
        document.getElementById('saveProjectBtn').style.display = 'block';
      }

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
      // Task 8 fix: this used to call startTimer() unconditionally, so the
      // timer always ran from page load regardless of the persisted
      // Settings -> Timer "auto-start" preference (default: off). Honor the
      // same setting annotation-runtime-settings-app.js's _initSettingsOnLoad
      // poller reads, so there's exactly one source of truth for whether the
      // timer should start itself.
      if (shouldAutoStartTimer()) startTimer();

      // Start DB annotation session (best effort)
      try {
        if (window.catReadOnly) throw new Error('view-only: no annotation session');
        // The popout mirrors the main window's timer; starting a session here
        // would close the main window's (one active session per person).
        if (window._catPopoutMode) throw new Error('popout: main window owns the session');
        const analyst = document.getElementById('analyst')?.value || 'unknown';
        const sessionResp = await fetch(`${serverUrl}/api/db/projects/${numericId}/sessions/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: analyst })
        });
        if (sessionResp.ok) {
          const sessionData = await sessionResp.json();
          currentDbSessionId = sessionData.session?.session_id || null;
          if (typeof setPriorSessionTotal === 'function') setPriorSessionTotal(sessionData.prior_total_seconds || 0);
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
    
    
    function initializeAnnotationForm() {
      // Pre-fill annotation form with project data
      if (currentProject) {
        const analystField = document.getElementById('analyst');
        const siteField = document.getElementById('site');
        const obsYearField = document.getElementById('obs_year');
        const missionIdField = document.getElementById('mission_id');

        // Analyst = who is annotating right now (this tool session), which is
        // a distinct person from the project's observer (the field diver who
        // did the survey — metadata, unrelated to who's using the annotator).
        // Always defaults to the logged-in user, always editable.
        if (analystField && !analystField.value) {
          fillAnalystFromLoginOrLocalStorage(analystField);
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
          observer: currentProject.observer,
          site: currentProject.site,
          obs_year: currentProject.year,
          mission_id: currentProject.cruise
        });
      }
    }

    function fillAnalystFromLoginOrLocalStorage(analystField) {
      function fromLocalStorage() {
        if (analystField.value) return;
        const saved = localStorage.getItem('cat_analyst');
        if (saved) {
          analystField.value = saved;
          markFieldAsAutofilled(analystField);
        }
      }
      if (!window.CatAuth) { fromLocalStorage(); return; }
      CatAuth.getConfig().then(function (config) {
        if (!config.auth_enabled) { fromLocalStorage(); return; }
        return CatAuth.fetchCurrentUser().then(function (data) {
          // analyst is a short code field (maxlength 10, e.g. "DTP", "LG")
          // — prefer username over the longer display_name here.
          if (data && data.user && !analystField.value) {
            analystField.value = data.user.username.toUpperCase();
            markFieldAsAutofilled(analystField);
          } else {
            fromLocalStorage();
          }
        });
      }).catch(fromLocalStorage);
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
              <div class="opacity-control" style="margin-top: 8px; display:flex; gap:6px;">
                <button type="button" class="dem-derivative-btn" data-cog-path="${tif.cog_path}" data-derivative="hillshade" data-tif-name="${tif.name}"
                  style="flex:1; padding:6px; font-size:11px; border:1px solid #d1d5db; border-radius:4px; background:#fff; cursor:pointer;">🏔️ Hillshade</button>
                <button type="button" class="dem-derivative-btn" data-cog-path="${tif.cog_path}" data-derivative="slope" data-tif-name="${tif.name}"
                  style="flex:1; padding:6px; font-size:11px; border:1px solid #d1d5db; border-radius:4px; background:#fff; cursor:pointer;">📐 Slope</button>
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
            loadTifLayer(tif).catch((err) => {
              console.error('Failed to load raster layer:', err);
              e.target.checked = false;
              if (typeof showStatus === 'function') showStatus(`Could not load ${tif.name}: ${err.message || err}`, 'error');
            });
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
          loadTifLayer(tif).catch((err) => {
            console.error('Failed to auto-load raster layer:', err);
            if (typeof showStatus === 'function') showStatus(`Could not load ${tif.name}: ${err.message || err}`, 'error');
          });
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
    
    
    async function loadShapefileLayer(shapefile, safeId) {
      console.log('Loading shapefile:', shapefile.name);
      
      // Use shapefile_path property (from project creator)
      const shapefilePath = shapefile.shapefile_path || shapefile.path;
      
      if (!shapefilePath) {
        console.error('No shapefile path found for:', shapefile.name);
        showStatus(`Missing path for shapefile: ${shapefile.name}`, 'error');
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
          showStatus(`Failed to load shapefile: ${shapefile.name} — ${errorText}`, 'error');
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
          showStatus(`Shapefile "${shapefile.name}" is empty (no features)`, 'error');
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
        showStatus(`Error loading shapefile: ${shapefile.name}`, 'error');
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
      // LOCAL_CS underwater imagery is expected/normal, not an error — the
      // brief showStatus() toast at the call site is enough, no need for a
      // persistent banner the user has to dismiss every time.
      if (reason === 'LOCAL_CS') return;

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

      const msg = '⚠️  COG bounds could not be determined — map is centred on site metadata coordinates.';

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
    // CSS layer filter settings per tif.id — sharpness and hue rotation
    let cogPaneSettings = {};
    let cogOpacitySettings = {};
    let cogReloadTimers = {};
    let cogLoadVersions = {};
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
      const opacity = cogOpacitySettings[tif.id] ?? tifLayers[tif.id]?.options?.opacity ?? 1;

      drawer.innerHTML = `
        <div style="position:sticky;top:0;background:#fff;z-index:1;padding:14px 14px 10px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;">
          <div style="font-weight:700;font-size:13px;color:#111;">⚙ COG Settings</div>
          <div style="font-size:11px;color:#888;flex:1;margin:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${tif.name}</div>
          <button id="cogDrawerClose" style="background:none;border:none;font-size:20px;cursor:pointer;color:#999;line-height:1;padding:0;">✕</button>
        </div>

        <div class="cog-drawer-section">
          <div class="cog-drawer-section-title">Opacity</div>
          <div class="cog-drawer-row">
            <label>Opacity <span id="d_opacityValue">${Math.round(opacity * 100)}</span>%</label>
            <input type="range" id="d_opacity" min="0" max="100" value="${Math.round(opacity * 100)}">
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
              <input type="checkbox" id="d_grayscale" ${v('saturation', 1) === 0 ? 'checked' : ''}> Grayscale
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;flex:1;">
              Hue <span id="d_hueValue">${p('hueRotate', 0)}</span>°
              <input type="range" id="d_hue" min="-180" max="180" step="5" value="${p('hueRotate', 0)}" style="flex:1;">
            </label>
          </div>
        </div>

        <div class="cog-drawer-section">
          <div class="cog-drawer-section-title">Band &amp; Colormap</div>
          <div class="cog-drawer-row">
            <label>Band</label>
            <select id="d_band" style="width:100%;padding:5px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;">
              <option value="">Natural color (RGB)</option>
            </select>
          </div>
          <div class="cog-drawer-row">
            <label>Colormap <span style="color:#999;">(single band)</span></label>
            <select id="d_colormap" style="width:100%;padding:5px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;">
              <option value="">None (grayscale)</option>
              <option value="viridis">Viridis</option>
              <option value="magma">Magma</option>
              <option value="inferno">Inferno</option>
              <option value="plasma">Plasma</option>
              <option value="cividis">Cividis</option>
              <option value="turbo">Turbo</option>
              <option value="rdylgn">Red-Yellow-Green</option>
              <option value="ocean">Ocean</option>
              <option value="terrain">Terrain</option>
            </select>
          </div>
          <div style="font-size:10px;color:#aaa;">Pick a band to render it alone with a colormap. Tone and color-balance sliders apply to natural color only.</div>
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
        if (isTifLayerEnabled(tif.id)) scheduleCogReload(tif);
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
        cogOpacitySettings[tif.id] = e.target.value / 100;
        const layer = tifLayers[tif.id];
        if (layer) layer.setOpacity(cogOpacitySettings[tif.id]);
      });

      // Image Tone
      q('d_gamma').addEventListener('input', e => { const v = e.target.value/100; q('d_gammaValue').textContent = v.toFixed(1); setVis('gamma', v); });
      q('d_saturation').addEventListener('input', e => {
        const v = e.target.value / 100;
        q('d_saturationValue').textContent = v.toFixed(1);
        q('d_grayscale').checked = (v === 0);
        setVis('saturation', v);
      });
      q('d_contrast').addEventListener('input', e => { const v = parseInt(e.target.value); q('d_contrastValue').textContent = v; setVis('contrast', v); });

      // Color Balance
      q('d_gammaR').addEventListener('input', e => { const v = e.target.value/100; q('d_gammaRValue').textContent = v.toFixed(1); setVis('gammaR', v); });
      q('d_gammaG').addEventListener('input', e => { const v = e.target.value/100; q('d_gammaGValue').textContent = v.toFixed(1); setVis('gammaG', v); });
      q('d_gammaB').addEventListener('input', e => { const v = e.target.value/100; q('d_gammaBValue').textContent = v.toFixed(1); setVis('gammaB', v); });

      // Display Effects
      q('d_sharpness').addEventListener('input', e => { const v = parseInt(e.target.value); q('d_sharpnessValue').textContent = v; setPane('sharpness', v); });
      // Grayscale = saturation 0 (tile reload) — no CSS filter needed
      q('d_grayscale').addEventListener('change', e => {
        const sat = e.target.checked ? 0 : 1;
        if (!cogVisualSettings[tif.id]) cogVisualSettings[tif.id] = {};
        cogVisualSettings[tif.id].saturation = sat;
        q('d_saturation').value = sat * 100;
        q('d_saturationValue').textContent = sat.toFixed(1);
        if (tifLayers[tif.id]) scheduleCogReload(tif, 0);
      });
      q('d_hue').addEventListener('input', e => { const v = parseInt(e.target.value); q('d_hueValue').textContent = v; setPane('hueRotate', v); });

      // Band & colormap. The band list is filled once /info answers.
      q('d_band').addEventListener('change', e => setVis('band', e.target.value ? Number(e.target.value) : null));
      q('d_colormap').addEventListener('change', e => setVis('colormap', e.target.value || null));
      q('d_colormap').value = v('colormap', '') || '';
      getCogBandCount(tif).then(n => {
        const sel = document.getElementById('d_band');
        if (!sel || !n || n < 2) return;
        for (let i = 1; i <= n; i++) {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = `Band ${i}`;
          sel.appendChild(opt);
        }
        sel.value = v('band', '') ? String(v('band', '')) : '';
      });

      // Sync drawer sliders from state (called by applyPreset)
      const syncDrawer = () => {
        const vs2 = cogVisualSettings[tif.id] || {};
        const bandSel = q('d_band'), cmapSel = q('d_colormap');
        if (bandSel) bandSel.value = vs2.band ? String(vs2.band) : '';
        if (cmapSel) cmapSel.value = vs2.colormap || '';
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
        q('d_grayscale').checked = vv('saturation',1) === 0;
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
        cogOpacitySettings[tif.id] = 1;
        applyPreset({}, {});
        const layer = tifLayers[tif.id];
        if (layer) { layer.setOpacity(1.0); q('d_opacity').value = 100; q('d_opacityValue').textContent = '100'; }
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
      return parts.length ? parts.join(', ') : null;
    }

    function scheduleCogReload(tif, delay = 180) {
      clearTimeout(cogReloadTimers[tif.id]);
      cogReloadTimers[tif.id] = setTimeout(() => {
        delete cogReloadTimers[tif.id];
        reloadCogWithSettings(tif);
      }, delay);
    }

    function isTifLayerEnabled(tifId) {
      return Array.from(document.querySelectorAll('.tif-layer-checkbox'))
        .some(checkbox => String(checkbox.dataset.tifId) === String(tifId) && checkbox.checked);
    }

    async function reloadCogWithSettings(tif) {
      clearTimeout(cogReloadTimers[tif.id]);
      delete cogReloadTimers[tif.id];
      const center = map.getCenter();
      const zoom   = map.getZoom();
      const version = (cogLoadVersions[tif.id] || 0) + 1;
      cogLoadVersions[tif.id] = version;
      removeTifLayer(tif.id, false);
      const layer = await loadTifLayer(tif, version);
      if (layer && cogLoadVersions[tif.id] === version) {
        map.setView(center, zoom, { animate: false });
        applyPaneFilter(tif.id); // re-apply CSS filters to the new layer container
      }
    }

    async function applyAutoStretch(tif) {
      const cogPath = encodeURIComponent(toGdalPath(tif.cog_path));
      const statsUrl = `${serverUrl}/statistics?url=${cogPath}`;
      try {
        const res   = await fetch(statsUrl);
        if (!res.ok) throw new Error(`Statistics request failed (HTTP ${res.status})`);
        const stats = await res.json();
        const b1    = stats.b1 || stats['1'] || {};
        const p2    = b1.percentile_2  ?? 0;
        const p98   = b1.percentile_98 ?? 255;
        if (!Number.isFinite(Number(p2)) || !Number.isFinite(Number(p98)) || Number(p2) >= Number(p98)) {
          throw new Error('Statistics response did not contain a valid p2-p98 range');
        }
        if (!cogVisualSettings[tif.id]) cogVisualSettings[tif.id] = {};
        cogVisualSettings[tif.id].rescale = `${p2},${p98}`;
        await reloadCogWithSettings(tif);
      } catch (e) {
        console.warn('Auto-stretch failed:', e);
        if (typeof showStatus === 'function') showStatus(`Auto Levels failed: ${e.message}`, 'error');
      }
    }

    // A COG's CRS never changes, but reloadCogWithSettings()/applyAutoStretch()
    // re-run loadTifLayer() on every gamma/contrast/saturation/rescale tweak —
    // without this cache each of those re-opened the remote COG via
    // /api/check-cog-crs just to re-derive the same answer (see debug_readme.md).
    const cogCrsCache = {};

    // Band count per COG (from TiTiler /info), cached for the same reason as the
    // CRS lookup above. Resolves to null when it can't be determined, in which
    // case callers fall back to the previous behavior.
    const cogBandCountCache = {};
    async function getCogBandCount(tif) {
      const key = tif.cog_path;
      if (key in cogBandCountCache) return cogBandCountCache[key];
      let count = null;
      try {
        const resp = await fetch(`${serverUrl}/info?url=${encodeURIComponent(toGdalPath(tif.cog_path))}`);
        if (resp.ok) {
          const info = await resp.json();
          const n = Number(info.count ?? (Array.isArray(info.band_metadata) ? info.band_metadata.length : NaN));
          if (Number.isFinite(n) && n > 0) count = n;
        }
      } catch (e) {
        console.warn('Could not read COG band count:', e);
      }
      if (count !== null) cogBandCountCache[key] = count; // don't cache failures
      return count;
    }

    // Project-mode tile layers used to share the default tile pane, so
    // z-order was just insertion order and any settings reload put an
    // orthomosaic on top of an already-loaded DEM. Ortho 250 sits above the
    // basemap (200); DEM 300 sits above ortho.
    function ensureRasterPane(isDEM) {
      const name = isDEM ? 'demPane' : 'cogProjectPane';
      if (!map.getPane(name)) {
        map.createPane(name);
        map.getPane(name).style.zIndex = isDEM ? 300 : 250;
      }
      return name;
    }

    async function loadTifLayer(tif, requestedVersion = null) {
      const version = requestedVersion ?? ((cogLoadVersions[tif.id] || 0) + 1);
      cogLoadVersions[tif.id] = version;
      let cogPath = encodeURIComponent(toGdalPath(tif.cog_path));
      let isLocalCs = false;
      let nativeBounds = null; // bounds in the file's native CRS (metres for LOCAL_CS)

      // --- Check CRS and get VRT override for LOCAL_CS files ---
      try {
        let crsData = cogCrsCache[tif.cog_path];
        if (!crsData) {
          const crsResp = await fetch(`${serverUrl}/api/check-cog-crs?url=${encodeURIComponent(tif.cog_path)}`);
          if (crsResp.ok) {
            crsData = await crsResp.json();
            cogCrsCache[tif.cog_path] = crsData;
          }
        }
        if (crsData) {
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

      // Track the most recently loaded orthomosaic's raw cog_path (not the
      // VRT/GDAL-encoded tile path above) for AI segmentation — DB/project
      // mode has no single "currentCOG" the way file mode does (multiple
      // tif layers can be toggled independently), so annotation-runtime-sam3.js
      // reads this instead. Only orthomosaics are segmentation targets, not DEMs.
      if (!isDEM) {
        window.catSam3ActiveCogPath = tif.cog_path;
        window.catSam3ActiveTifId = tif.id;
      }

      // For DEMs, fetch statistics and add proper parameters
      if (isDEM) {
        const safeId = `tif_${tif.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const colormapSelect = document.getElementById(`${safeId}_colormap`);
        const colormap = colormapSelect?.value || 'viridis';
        
        try {
          // Fetch statistics to get proper rescale values
          const userRescale = (cogVisualSettings[tif.id] || {}).rescale;
          let rescale = userRescale || null;
          if (!rescale) {
            const statsUrl = `${serverUrl}/statistics?url=${cogPath}`;
            const statsResponse = await fetch(statsUrl);
            if (!statsResponse.ok) throw new Error(`Statistics request failed (HTTP ${statsResponse.status})`);
            const stats = await statsResponse.json();

            // Handle different statistics response formats
            const bandStats = stats.b1 || stats['1'] || (stats.statistics && stats.statistics[0]) || {};

            // Percentiles are more robust than min/max with outliers. Use ??
            // (not ||): a legitimate 2nd percentile of 0 must not be replaced.
            const pick = (...vals) => vals.find(v => Number.isFinite(Number(v)) && v !== null && v !== '');
            const min = pick(bandStats.percentile_2, bandStats.min) ?? -10;
            const max = pick(bandStats.percentile_98, bandStats.max) ?? 10;
            rescale = `${min},${max}`;
          }

          // Add DEM parameters: band index, colormap, and rescale
          tileUrl += `&bidx=1&colormap_name=${colormap}&rescale=${rescale}`;
        } catch (error) {
          console.warn('Could not fetch DEM statistics, using defaults:', error);
          tileUrl += `&bidx=1&colormap_name=${colormap}&rescale=-10,10`;
        }
      }

      // For non-DEM COGs, apply any stored visual settings
      if (!isDEM) {
        const vs = cogVisualSettings[tif.id] || {};
        const bandCount = await getCogBandCount(tif);
        if (cogLoadVersions[tif.id] !== version) return null;
        const singleBand = Number(vs.band) > 0 ? Number(vs.band) : (bandCount === 1 ? 1 : null);
        if (singleBand) {
          // Single-band render (user picked a band, or the file only has one):
          // RGB color formulas don't apply, but a colormap + stretch do.
          tileUrl += `&bidx=${singleBand}`;
          if (vs.colormap) tileUrl += `&colormap_name=${encodeURIComponent(vs.colormap)}`;
          if (vs.rescale)  tileUrl += `&rescale=${vs.rescale}`;
        } else {
          const formula = buildColorFormula(vs);
          // rio-color's "RGB" operations need exactly 3 bands. Drone mosaics are
          // often RGBA, so select bands 1-3 explicitly when a formula is used
          // (the alpha/nodata mask is still applied by the tiler).
          if (formula && bandCount && bandCount >= 4) tileUrl += `&bidx=1&bidx=2&bidx=3`;
          if (formula)    tileUrl += `&color_formula=${encodeURIComponent(formula)}`;
          if (vs.rescale) tileUrl += `&rescale=${vs.rescale}`;
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
      const layerOpacity = cogOpacitySettings[tif.id] ?? defaultOpacity;

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
        opacity: layerOpacity,
        attribution: tif.name,
        maxZoom: 2000,  // Match basic viewer setting
        minZoom: 0,
        tileSize: 256,
        errorTileUrl: '',  // Don't show broken image icons
        crossOrigin: true,
        noWrap: true,
        pane: ensureRasterPane(isDEM),
        bounds: rasterBounds || undefined
      });

      if (cogLoadVersions[tif.id] !== version) return null;
      
      layer.addTo(map);
      tifLayers[tif.id] = layer;
      applyPaneFilter(tif.id);

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
        // A flyTo/flyToBounds animation (zoomToSite, opening a project, a
        // bookmark) passes through low intermediate zoom levels on its way
        // to where it settles — fitBounds/setView never painted those, so
        // this always-latent failure mode (a COG's real footprint is tiny
        // next to a low-zoom WebMercator tile; TiTiler has nothing to
        // return for the rest of that tile) only became visible once flying
        // started actually requesting them. The failing tile's own zoom
        // can't be compared against the map's current zoom to tell a
        // fly-through frame from a settled one — Leaflet always requests
        // tiles for whatever zoom it's AT, so the two are the same value at
        // request time by construction. What actually distinguishes them is
        // TIME: debounce the user-facing toast so it only fires once tile
        // errors have stopped arriving for a beat with the map at rest — a
        // fly-through failure stops the moment the animation lands, while a
        // real failure (bad URL, COG genuinely unreachable) keeps erroring
        // at the resting zoom and the toast fires ~2s after settling.
        clearTimeout(tileErrorVerdictTimer);
        tileErrorVerdictTimer = setTimeout(() => {
          if (tileErrorCount >= 3 && typeof showStatus === 'function') {
            showStatus(`Could not render COG settings for ${tif.name}`, 'error');
          }
          tileErrorCount = 0;
        }, 2000); // must exceed the 1.2s flyTo/flyToBounds duration used elsewhere in this file
      });

      // Track tile loading (only log first few to avoid spam)
      let tileLoadCount = 0;
      let tileErrorCount = 0;
      let tileErrorVerdictTimer = null;
      
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

      if (cogLoadVersions[tif.id] !== version) return null;

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
          // flyToBounds, not fitBounds: this is usually a large jump from
          // wherever the map defaulted to, and Leaflet's plain fitBounds
          // animation silently skips the animation for a big enough zoom
          // delta (it just snaps). flyTo's easing handles any distance
          // smoothly, so opening a project always feels like arriving
          // somewhere rather than a jump-cut.
          map.flyToBounds(projectBounds, { padding: [50, 50], maxZoom: 22, duration: 1.2 });
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
              map.flyTo([fallback.lat, fallback.lon], 18, { duration: 1.2 });
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
              map.flyTo([fallback.lat, fallback.lon], 18, { duration: 1.2 });
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
              map.flyToBounds(projectBounds, { padding: [50, 50], maxZoom: 22, duration: 1.2 });
              console.log('🎯 Zoomed to layer bounds:', projectBounds);
            }
          }
        }
      }
      
      console.log('✅ Loaded layer:', tif.name);
      return layer;
    }
    
    function removeTifLayer(tifId, invalidatePending = true) {
      clearTimeout(cogReloadTimers[tifId]);
      delete cogReloadTimers[tifId];
      if (invalidatePending) cogLoadVersions[tifId] = (cogLoadVersions[tifId] || 0) + 1;
      if (tifLayers[tifId]) {
        map.removeLayer(tifLayers[tifId]);
        
        // If this is the DEM layer, hide controls and clear reference.
        // typeof guard: `demLayer` is only ever created (as an implicit
        // global) when a DEM loads, so reading it bare threw a ReferenceError
        // on every reload of an orthomosaic — which silently killed every COG
        // settings change (gamma, saturation, band, colormap...).
        if (typeof demLayer !== 'undefined' && tifLayers[tifId] === demLayer) {
          demLayer = null;
          const demControls = document.getElementById('demGlobalControls');
          if (demControls) {
            demControls.style.display = 'none';
          }
        }

        if (window.catSam3ActiveTifId === tifId) {
          window.catSam3ActiveCogPath = null;
          window.catSam3ActiveTifId = null;
        }

        delete tifLayers[tifId];
      }
    }
    
    function loadProjectAnnotations() {
      // Clear existing annotations
      drawnItems.clearLayers();
      annotations = [];
      
      
      // Load annotations from project
      projectAnnotations.forEach((ann, idx) => {
        const layer = L.geoJSON(ann.geometry, {
          pane: 'annotationsPane',  // Ensure annotations are in the top pane
          style: getAnnotationLayerStyle(ann)
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
          if (ann._creatorUserId !== undefined) normalizedAnn._creatorUserId = ann._creatorUserId;
          if (ann._creatorLabel) normalizedAnn._creatorLabel = ann._creatorLabel;
          if (ann._clientUuid) normalizedAnn._clientUuid = ann._clientUuid;
        }

        // Add the array index as the display ID (for consistent referencing)
        normalizedAnn._displayIndex = idx + 1;

        // Baseline of what the server has, so autosave can detect ANY later
        // change to this annotation (see annotationNeedsSync in autosave.js).
        if (getDbAnnotationId(normalizedAnn) && normalizedAnn._syncStatus === 'synced') {
          normalizedAnn._syncedFingerprint = annotationPayloadFingerprint(normalizedAnn);
        }

        // Keep every annotation consumer on the same object. Differential
        // sync replaces projectAnnotations entries after a successful PUT,
        // so the table array and layer must share this normalized instance.
        projectAnnotations[idx] = normalizedAnn;

        layer.annotationData = normalizedAnn;
        // Multi-user contributor toggle reads these directly off the layer —
        // see buildContributorVisibilityPanel()/applyContributorVisibility()
        // in annotation-runtime-annotations.js.
        layer._creatorUserId = normalizedAnn._creatorUserId ?? null;
        layer._creatorLabel = normalizedAnn._creatorLabel || 'Unknown';

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
      if (typeof buildContributorVisibilityPanel === 'function') {
        buildContributorVisibilityPanel();
      }
      console.log(`✅ Loaded ${annotations.length} annotations`);
      
      // Show import info if annotations were imported
      if (currentProject.metadata?.imported_annotations) {
        const importInfo = currentProject.metadata.imported_annotations;
        console.log(`ℹ️ Imported ${importInfo.count} annotations from "${importInfo.source_file}"`);
      }
    }

    // NOTE: the multi-user change-polling banner's "↻ Refresh" button
    // (annotation-runtime-autosave.js) calls window.refreshAnnotationsFromDb,
    // which is defined in annotation-runtime-operations.js (loaded after this
    // file, so it owns the global). Do not redefine it here.



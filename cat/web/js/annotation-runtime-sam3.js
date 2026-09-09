// AI Segmentation (SAM3) UI wiring — Task 6.
// Depends on globals defined by earlier-loaded runtime scripts:
//   serverUrl, currentCOG        (annotation-runtime-core.js)
//   currentProject, isOracleProjectMode()  (annotation-runtime-project-layers.js)
//   showStatus(), refreshAnnotations()     (annotation-runtime-operations.js)
//   map, drawControl             (annotation-runtime-shell-init.js)
// This module arms window.catSam3PendingMode, which the existing
// L.Draw.Event.CREATED handler in annotation-runtime-shell-init.js checks
// and routes to window.catSam3HandleRectangle() instead of the normal
// manual-drawing flow.

    // ── Availability check ──
    window.catSam3Available = false;
    // Why the button is unavailable, for tooltip purposes: 'file-mode' (DB
    // backend required — segmentation routes 401 under require_auth in
    // file-mode since get_current_user always returns None there) or
    // 'gpu-unreachable' (GPU health check failed/unavailable). Defaults to
    // the GPU reason so an early failed check before /api/config resolves
    // still shows a sensible tooltip.
    window.catSam3UnavailableReason = 'gpu-unreachable';

    async function catSam3CheckStatus() {
      // 'disabled' | 'unreachable' | 'error' | 'cpu' | 'busy' | 'ready'
      let gpuState = 'unreachable';
      let gpuReason = null;
      try {
        const resp = await fetch(`${serverUrl}/api/segmentation/status`);
        if (resp.ok) {
          const data = await resp.json();
          gpuState = data.state || (data.available ? 'ready' : 'unreachable');
          gpuReason = data.reason || null;
        }
      } catch (err) {
        gpuState = 'unreachable';
      }

      // Segmentation routes require Depends(require_auth), which always
      // 401s in file-mode (get_current_user returns None there) — so the
      // button must not be usable unless the active backend is Oracle,
      // regardless of GPU health.
      let storageBackend = null;
      try {
        const cfgResp = await fetch(`${serverUrl}/api/config`);
        if (cfgResp.ok) {
          const cfg = await cfgResp.json();
          storageBackend = cfg.storage_backend;
        }
      } catch (err) {
        storageBackend = null;
      }

      if (storageBackend !== 'oracle') {
        window.catSam3Available = false;
        window.catSam3State = 'file-mode';
        window.catSam3UnavailableReason = 'file-mode';
      } else if (gpuState === 'ready' || gpuState === 'cpu' || gpuState === 'busy') {
        // Still usable (button stays enabled) even when degraded/busy --
        // "unavailable" should mean genuinely can't be used, not "currently
        // slow" or "currently queued behind someone else".
        window.catSam3Available = true;
        window.catSam3State = gpuState;
        window.catSam3UnavailableReason = null;
      } else {
        window.catSam3Available = false;
        window.catSam3State = gpuState; // 'unreachable' or 'error'
        window.catSam3UnavailableReason = 'gpu-unreachable';
      }
      window.catSam3StateReason = gpuReason;
      catSam3UpdateButtonState();
    }

    function catSam3UpdateButtonState() {
      const btn = document.getElementById('sam3ToolbarBtn');
      if (!btn) return;

      // Label/color reflect the real state -- "unavailable" (disabled) is
      // distinct from "usable but degraded" (busy/cpu), so a user isn't
      // told the feature is broken when it's actually just queued behind
      // another request or running slow without a GPU.
      const badges = {
        ready: { label: 'AI Segment', dot: '' },
        cpu: { label: 'AI Segment (CPU — slow)', dot: '🟡 ' },
        busy: { label: 'AI Segment (busy)', dot: '🟠 ' },
        'file-mode': { label: 'AI Segment', dot: '' },
        error: { label: 'AI Segment (unavailable)', dot: '🔴 ' },
        unreachable: { label: 'AI Segment (unavailable)', dot: '🔴 ' },
      };
      const state = window.catSam3State || 'unreachable';
      const badge = badges[state] || badges.unreachable;
      const labelSpan = btn.querySelector('.sam3-btn-label');
      if (labelSpan) labelSpan.textContent = badge.dot + badge.label;

      if (window.catSam3Available) {
        btn.disabled = false;
        if (state === 'busy') {
          btn.title = window.catSam3StateReason || 'SAM3 is processing another request -- try again shortly';
        } else if (state === 'cpu') {
          btn.title = window.catSam3StateReason || 'Running on CPU (no GPU detected) -- segmentation will be very slow';
        } else {
          btn.title = 'AI-assisted coral segmentation (SAM3)';
        }
      } else {
        btn.disabled = true;
        btn.title = (window.catSam3UnavailableReason === 'file-mode')
          ? 'AI segmentation requires a database-backed project'
          : (window.catSam3StateReason || 'AI segmentation unavailable — GPU service not reachable');
        // Close the panel if it happened to be open when availability dropped.
        const menu = document.getElementById('dd-sam3');
        if (menu) menu.classList.remove('open');
      }
    }

    // ── Toolbar button + mode panel (mirrors the existing nav-dropdown pattern) ──
    function catSam3BuildUI() {
      if (document.getElementById('sam3ToolbarBtn')) return; // already injected

      const navMenus = document.querySelector('.nav-menus');
      if (!navMenus) return;

      const wrapper = document.createElement('div');
      wrapper.className = 'nav-dropdown';
      wrapper.setAttribute('data-dropdown', 'sam3');
      wrapper.innerHTML = `
        <button class="nav-dropdown-btn" id="sam3ToolbarBtn" onclick="toggleNavDropdown('sam3')" title="AI segmentation unavailable — GPU service not reachable" aria-haspopup="true" aria-expanded="false">
          <svg class="cat-icon"><use href="/vendor/feather/feather-sprite.svg#zap"/></svg> <span class="sam3-btn-label">AI Segment</span> <span class="caret">▾</span>
        </button>
        <div class="nav-dropdown-menu dd-menu-left" id="dd-sam3">
          <div class="dd-label">AI Segmentation (SAM3)</div>
          <div class="dd-item dd-item-static">
            <label for="sam3ModeSelect" style="margin-right:6px;">Mode</label>
            <select id="sam3ModeSelect">
              <option value="text">Text prompt</option>
              <option value="point">Point (click)</option>
              <option value="box">Box</option>
              <option value="tiled">Tiled (full area)</option>
            </select>
          </div>
          <div class="dd-item dd-item-static" id="sam3PromptRow">
            <label for="sam3PromptInput" style="margin-right:6px;">Prompt</label>
            <input type="text" id="sam3PromptInput" value="coral" style="width:120px;">
          </div>
          <div class="dd-item dd-item-static">
            <label for="sam3MaxDiameterCheckbox" style="display:flex;align-items:center;gap:6px;">
              <input type="checkbox" id="sam3MaxDiameterCheckbox"> Save as max-diameter line
            </label>
          </div>
          <div class="dd-item">
            <button type="button" id="sam3DrawAreaBtn" class="dd-item" style="width:100%;text-align:left;" onclick="catSam3StartDrawArea()">
              <svg class="cat-icon"><use href="/vendor/feather/feather-sprite.svg#crosshair"/></svg> Draw area
            </button>
          </div>
          <div class="dd-item" id="sam3ClickPointRow" style="display:none;">
            <button type="button" id="sam3ClickPointBtn" class="dd-item" style="width:100%;text-align:left;" onclick="catSam3StartClickPoint()">
              <svg class="cat-icon"><use href="/vendor/feather/feather-sprite.svg#map-pin"/></svg> Click point
            </button>
          </div>
        </div>
      `;
      navMenus.appendChild(wrapper);

      const modeSelect = document.getElementById('sam3ModeSelect');
      modeSelect.addEventListener('change', catSam3SyncModeUI);
      catSam3SyncModeUI();

      catSam3UpdateButtonState();
    }

    function catSam3SyncModeUI() {
      const mode = document.getElementById('sam3ModeSelect')?.value || 'text';
      const promptRow = document.getElementById('sam3PromptRow');
      const drawBtn = document.getElementById('sam3DrawAreaBtn');
      const clickRow = document.getElementById('sam3ClickPointRow');
      if (promptRow) promptRow.style.display = (mode === 'text' || mode === 'tiled') ? '' : 'none';
      if (drawBtn) drawBtn.parentElement.style.display = (mode === 'point') ? 'none' : '';
      if (clickRow) clickRow.style.display = (mode === 'point') ? '' : 'none';
    }

    document.addEventListener('DOMContentLoaded', function() {
      catSam3BuildUI();
      catSam3CheckStatus();
      // GPU service can come up after the main app, and busy/cpu/ready can
      // change quickly (a single GPU serves one request at a time) — poll
      // often enough that the busy indicator doesn't feel stale.
      setInterval(catSam3CheckStatus, 15000);

      // Leaflet.draw fires DRAWSTOP whenever a draw session ends, whether
      // the shape was completed OR canceled (Escape key, switching tools).
      // It fires AFTER CREATED when a shape is completed, so this is safe
      // for the success path too — catSam3HandleRectangle's own `finally`
      // will have already cleared the flag by then, making this a no-op.
      // Without this, canceling "Draw area" leaves catSam3PendingMode set
      // indefinitely, and the next unrelated manual rectangle gets
      // silently intercepted as an AI segmentation request.
      if (typeof map !== 'undefined' && map && L.Draw && L.Draw.Event) {
        map.on(L.Draw.Event.DRAWSTOP, function() {
          window.catSam3PendingMode = null;
        });
      }
    });

    // ── Draw-area (Text/Box/Tiled) — reuses the existing rectangle draw tool ──
    function catSam3StartDrawArea() {
      if (!window.catSam3Available) {
        if (typeof showStatus === 'function') showStatus('AI segmentation unavailable', 'error');
        return;
      }
      const mode = document.getElementById('sam3ModeSelect')?.value || 'text';
      window.catSam3PendingMode = mode;
      if (typeof closeNavDropdowns === 'function') closeNavDropdowns();
      new L.Draw.Rectangle(map, {}).enable();
      if (typeof showStatus === 'function') showStatus('Draw a rectangle over the area to segment', 'info');
    }

    // Called by the existing L.Draw.Event.CREATED handler in
    // annotation-runtime-shell-init.js when a rectangle is drawn while
    // window.catSam3PendingMode is set to "text", "box" or "tiled".
    window.catSam3HandleRectangle = async function(layer) {
      const mode = window.catSam3PendingMode;
      try {
        const bounds = layer.getBounds();
        const bbox = {
          min_lon: bounds.getWest(),
          min_lat: bounds.getSouth(),
          max_lon: bounds.getEast(),
          max_lat: bounds.getNorth()
        };
        // The rectangle was only a selection tool — it was never added to
        // drawnItems (this handler returns before the normal drawing flow
        // that would call drawnItems.addLayer(layer)), so there's nothing
        // to remove from the annotation layer. Just make sure it isn't
        // left dangling on the map itself.
        if (layer.remove) layer.remove();

        const promptInput = document.getElementById('sam3PromptInput');
        const prompt = (promptInput && promptInput.value.trim()) || 'coral';

        await catSam3RunSegmentation(mode, { bbox, prompt });
      } finally {
        window.catSam3PendingMode = null;
      }
    };

    // ── Click-point mode ──
    function catSam3StartClickPoint() {
      if (!window.catSam3Available) {
        if (typeof showStatus === 'function') showStatus('AI segmentation unavailable', 'error');
        return;
      }
      window.catSam3PendingMode = 'point';
      if (typeof closeNavDropdowns === 'function') closeNavDropdowns();
      if (typeof showStatus === 'function') showStatus('Click a point on the map to segment (times out in 30s)', 'info');

      // Auto-disarm after 30s if the user never clicks (or the flag would
      // otherwise stay armed indefinitely, letting an unrelated later map
      // click unexpectedly trigger inference).
      let timedOut = false;
      const timeoutId = setTimeout(function() {
        timedOut = true;
        map.off('click', clickHandler);
        window.catSam3PendingMode = null;
      }, 30000);

      function clickHandler(e) {
        if (timedOut) return;
        clearTimeout(timeoutId);
        (async function() {
          try {
            await catSam3RunSegmentation('point', { lon: e.latlng.lng, lat: e.latlng.lat });
          } finally {
            window.catSam3PendingMode = null;
          }
        })();
      }
      map.once('click', clickHandler);
    }

    // ── Shared request/response handling for all four modes ──
    async function catSam3RunSegmentation(mode, params) {
      const endpoints = {
        text: '/api/segmentation/text',
        point: '/api/segmentation/point',
        box: '/api/segmentation/box',
        tiled: '/api/segmentation/tiled'
      };
      const endpoint = endpoints[mode];
      if (!endpoint) return;

      // DB/project mode tracks the active orthomosaic separately from the
      // legacy file-mode `currentCOG` global (see loadTifLayer() in
      // annotation-runtime-project-layers.js) — prefer it when set.
      const cogUrl = window.catSam3ActiveCogPath || currentCOG;
      if (!cogUrl) {
        if (typeof showStatus === 'function') showStatus('Load an orthomosaic layer before running AI segmentation', 'error');
        return;
      }

      const body = {
        cog_url: cogUrl,
        project_id: (currentProject && currentProject.project_id) || null,
        asset_id: window.catSam3ActiveTifId || null,
        auto_save: true,
        save_diameter_line: !!document.getElementById('sam3MaxDiameterCheckbox')?.checked
      };
      if (mode === 'text' || mode === 'tiled') {
        body.bbox = params.bbox;
        body.prompt = params.prompt;
      } else if (mode === 'box') {
        body.bbox = params.bbox;
      } else if (mode === 'point') {
        body.points = [{ lon: params.lon, lat: params.lat, label: 1 }];
      }

      const drawAreaBtn = document.getElementById('sam3DrawAreaBtn');
      const clickPointBtn = document.getElementById('sam3ClickPointBtn');
      if (drawAreaBtn) drawAreaBtn.disabled = true;
      if (clickPointBtn) clickPointBtn.disabled = true;

      if (typeof showStatus === 'function') showStatus('Running AI segmentation...', 'info');

      try {
        const resp = await fetch(`${serverUrl}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!resp.ok) {
          let detail = 'AI segmentation failed';
          try {
            const errBody = await resp.json();
            // FastAPI validation errors (422) send `detail` as an array of
            // {loc, msg, type} objects, not a string — stringifying those
            // directly renders as "[object Object]" in the status bar.
            if (Array.isArray(errBody.detail)) {
              detail = errBody.detail.map(e => e.msg || JSON.stringify(e)).join('; ');
            } else if (typeof errBody.detail === 'string') {
              detail = errBody.detail;
            }
          } catch (parseErr) {
            // Non-JSON error body — fall back to the generic message.
          }
          if (typeof showStatus === 'function') showStatus(detail, 'error');
          return;
        }

        const result = await resp.json();
        const features = result.features || [];

        if (result.saved) {
          const count = (typeof result.count === 'number') ? result.count : features.length;
          if (count === 0) {
            if (typeof showStatus === 'function') showStatus('No detections found', 'info');
          } else {
            if (typeof showStatus === 'function') {
              showStatus(`AI added ${count} detection${count === 1 ? '' : 's'}`, 'success');
            }
            if (typeof refreshAnnotations === 'function') await refreshAnnotations();
          }
        } else if (features.length > 0) {
          if (typeof showStatus === 'function') {
            showStatus(`AI found ${features.length} detections but could not save (no active database project)`, 'info');
          }
        } else {
          if (typeof showStatus === 'function') showStatus('No detections found', 'info');
        }
      } catch (err) {
        if (typeof showStatus === 'function') showStatus('AI segmentation request failed: ' + err.message, 'error');
      } finally {
        if (drawAreaBtn) drawAreaBtn.disabled = false;
        if (clickPointBtn) clickPointBtn.disabled = false;
        // Refresh the busy/ready indicator right away rather than waiting
        // for the next 15s poll -- the GPU frees up the moment this
        // request's response arrives.
        catSam3CheckStatus();
      }
    }

    window.catSam3StartDrawArea = catSam3StartDrawArea;
    window.catSam3StartClickPoint = catSam3StartClickPoint;
    window.catSam3RunSegmentation = catSam3RunSegmentation;

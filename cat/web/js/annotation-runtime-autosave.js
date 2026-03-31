// Extracted from annotation-file-mode-runtime.js (Phase 2b: autosave)
    // ========== Auto-Save (Oracle mode only) ==========
    function setAutoSaveBadge(state, text) {
      const badge = document.getElementById('autoSaveBadge');
      if (!badge) return;
      badge.style.display = 'inline-block';
      const styles = {
        saving:  { bg: 'rgba(255,193,7,0.15)',  color: '#856404' },
        saved:   { bg: 'rgba(40,167,69,0.1)',   color: '#28a745' },
        error:   { bg: 'rgba(220,53,69,0.1)',   color: '#dc3545' },
        pending: { bg: 'rgba(102,126,234,0.1)', color: '#667eea' },
      };
      const s = styles[state] || styles.saved;
      badge.style.background = s.bg;
      badge.style.color = s.color;
      badge.textContent = text;
    }

    // Retry state (Fix 1c)
    let autoSaveRetryCount = 0;
    let autoSaveRetryTimeoutId = null;

    async function runAutoSave() {
      if (!isOracleProjectMode()) return;
      if (!hasUnsavedChanges) {
        if (lastSaveTime) {
          const secs = Math.round((Date.now() - lastSaveTime) / 1000);
          setAutoSaveBadge('saved', `✅ Saved ${secs}s ago`);
        }
        return;
      }
      if (autoSaveInProgress) return;
      autoSaveInProgress = true;
      setAutoSaveBadge('saving', '⏳ Auto-saving…');
      try {
        // Differential sync: only send annotations that aren't already synced (Fix 2a)
        // Treats undefined _syncStatus as dirty (safe fallback for legacy/loaded annotations)
        const toSync = [];
        drawnItems.eachLayer(layer => {
          if (layer.annotationData && layer.annotationData._syncStatus !== 'synced') {
            toSync.push(layer);
          }
        });

        if (toSync.length === 0) {
          hasUnsavedChanges = false;
          lastSaveTime = Date.now();
          setAutoSaveBadge('saved', '✅ Saved');
          return;
        }

        console.log(`🔄 Differential auto-save: ${toSync.length} annotation(s) to sync`);
        const errors = [];

        for (const layer of toSync) {
          try {
            const synced = await syncAnnotationToDb(layer.annotationData);
            synced._syncStatus = 'synced';
            const projectAnnotations = getProjectAnnotations();
            const idx = projectAnnotations.findIndex(a =>
              a === layer.annotationData ||
              (a._dbAnnotationId && a._dbAnnotationId === layer.annotationData._dbAnnotationId)
            );
            if (idx >= 0) applySyncedAnnotation(idx, synced);
            layer.annotationData = synced;
          } catch (err) {
            errors.push(err);
            layer.annotationData._syncStatus = 'error';
          }
        }

        if (errors.length > 0) {
          throw new Error(`${errors.length} of ${toSync.length} annotation(s) failed to sync`);
        }

        hasUnsavedChanges = false;
        lastSaveTime = Date.now();
        // Reset retry state on success (Fix 1c)
        autoSaveRetryCount = 0;
        if (autoSaveRetryTimeoutId) { clearTimeout(autoSaveRetryTimeoutId); autoSaveRetryTimeoutId = null; }
        const badge = document.getElementById('autoSaveBadge');
        if (badge) badge.style.cursor = '';
        // Exit degraded mode if we were in it (5c)
        _exitDegradedMode();
        setAutoSaveBadge('saved', '✅ Auto-saved');
        // Update table to reflect new sync status icons (Fix 2b)
        if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
        // Fade badge back to subtle after 5s
        setTimeout(() => {
          if (!hasUnsavedChanges && document.getElementById('autoSaveBadge')) {
            setAutoSaveBadge('saved', '✅ Saved');
          }
        }, 5000);
      } catch (err) {
        // Exponential backoff retry logic (Fix 1c)
        autoSaveRetryCount++;
        console.warn(`Auto-save failed (attempt ${autoSaveRetryCount}):`, err);
        const maxRetries = 3;
        const retryDelays = [5000, 15000, 30000];
        if (autoSaveRetryCount <= maxRetries) {
          const delay = retryDelays[autoSaveRetryCount - 1];
          setAutoSaveBadge('error', `❌ Save failed — retrying in ${delay / 1000}s…`);
          autoSaveInProgress = false;
          autoSaveRetryTimeoutId = setTimeout(() => { runAutoSave(); }, delay);
          return;
        } else {
          setAutoSaveBadge('error', '❌ Auto-save failed — click to export backup');
          const badge = document.getElementById('autoSaveBadge');
          if (badge) {
            badge.style.cursor = 'pointer';
            badge.addEventListener('click', () => {
              if (typeof exportProjectData === 'function') exportProjectData();
            }, { once: true });
          }
          // Diagnose: is it a full outage or just a DB error? (5c)
          _checkConnectivity().then(online => {
            const label = online
              ? '⚠️ Database unreachable — working offline. Changes are saved locally.'
              : '📡 No network connection — working offline. Changes are saved locally.';
            _enterDegradedMode(label);
          });
        }
      } finally {
        autoSaveInProgress = false;
      }
    }

    function startAutoSave() {
      if (autoSaveIntervalId) return; // already running
      autoSaveIntervalId = setInterval(runAutoSave, AUTO_SAVE_INTERVAL_MS);
      setAutoSaveBadge('saved', '✅ Auto-save on');
      console.log(`⏰ Auto-save started (every ${AUTO_SAVE_INTERVAL_MS / 1000}s)`);
      // Start multi-user change polling alongside auto-save (5b)
      startChangePolling();
    }

    function stopAutoSave() {
      if (autoSaveIntervalId) {
        clearInterval(autoSaveIntervalId);
        autoSaveIntervalId = null;
      }
      if (autoSaveRetryTimeoutId) {
        clearTimeout(autoSaveRetryTimeoutId);
        autoSaveRetryTimeoutId = null;
      }
      const badge = document.getElementById('autoSaveBadge');
      if (badge) badge.style.display = 'none';
      stopChangePolling();
    }
    // ========== End Auto-Save ==========

    // ========== Offline / Degraded Mode (5c) ==========
    let degradedMode = false;
    let degradedRecoveryIntervalId = null;

    async function _checkConnectivity() {
      try {
        const resp = await fetch(`${window.location.origin}/health`, { cache: 'no-store' });
        return resp.ok;
      } catch {
        return false;
      }
    }

    function _enterDegradedMode(label) {
      if (degradedMode) return;
      degradedMode = true;

      const existing = document.getElementById('degradedBanner');
      if (existing) existing.remove();

      const banner = document.createElement('div');
      banner.id = 'degradedBanner';
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0',
        'background:#c0392b', 'color:#fff', 'text-align:center',
        'padding:6px 12px', 'z-index:10000', 'font-size:13px',
        'display:flex', 'align-items:center', 'justify-content:center', 'gap:12px'
      ].join(';');

      const text = document.createElement('span');
      text.id = 'degradedBannerText';
      text.textContent = label;
      banner.appendChild(text);

      const exportBtn = document.createElement('button');
      exportBtn.textContent = '📥 Export backup';
      exportBtn.style.cssText = 'background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:#fff;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
      exportBtn.onclick = () => { if (typeof exportProjectData === 'function') exportProjectData(); };
      banner.appendChild(exportBtn);

      document.body.appendChild(banner);

      // Shift body down so banner doesn't overlap content
      document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || '0') + 36) + 'px';

      // Start recovery polling every 15s
      if (degradedRecoveryIntervalId) clearInterval(degradedRecoveryIntervalId);
      degradedRecoveryIntervalId = setInterval(async () => {
        const online = await _checkConnectivity();
        if (online) _exitDegradedMode();
      }, 15000);
    }

    function _exitDegradedMode() {
      if (!degradedMode) return;
      degradedMode = false;

      if (degradedRecoveryIntervalId) { clearInterval(degradedRecoveryIntervalId); degradedRecoveryIntervalId = null; }

      const banner = document.getElementById('degradedBanner');
      if (banner) {
        banner.style.background = '#27ae60';
        const text = document.getElementById('degradedBannerText');
        if (text) text.textContent = '✅ Connection restored — resuming auto-save';
        setTimeout(() => {
          banner.remove();
          document.body.style.paddingTop = Math.max(0, parseInt(document.body.style.paddingTop || '0') - 36) + 'px';
        }, 3000);
      }

      // Reset retry count so auto-save resumes cleanly
      autoSaveRetryCount = 0;
      if (autoSaveRetryTimeoutId) { clearTimeout(autoSaveRetryTimeoutId); autoSaveRetryTimeoutId = null; }
      autoSaveInProgress = false;
    }
    // ========== End Offline / Degraded Mode ==========

    // ========== Multi-User Change Polling (5b) ==========
    const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds
    let pollIntervalId = null;

    async function pollForRemoteChanges() {
      if (!isOracleProjectMode || !isOracleProjectMode()) return;
      const projectId = currentProject?.project_id;
      if (!projectId) return;

      try {
        const resp = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations`);
        if (!resp.ok) return;
        const data = await resp.json();
        const remoteAnns = data.annotations || [];

        // Build a map of local annotation id → version
        const localVersions = {};
        const projectAnnotations = typeof getProjectAnnotations === 'function' ? getProjectAnnotations() : [];
        projectAnnotations.forEach(a => {
          if (a._dbAnnotationId) localVersions[a._dbAnnotationId] = a._dbAnnotationVersion ?? 1;
        });

        let newCount = 0;
        let updatedCount = 0;
        remoteAnns.forEach(r => {
          const id = r.annotation_id;
          if (!id) return;
          if (!(id in localVersions)) {
            newCount++;
          } else if ((r.version ?? 1) > localVersions[id]) {
            updatedCount++;
          }
        });

        if (newCount > 0 || updatedCount > 0) {
          _showRemoteChangeBanner(newCount, updatedCount);
        }
      } catch (e) {
        // Polling failures are silent — don't disrupt the user
      }
    }

    function _showRemoteChangeBanner(newCount, updatedCount) {
      const existing = document.getElementById('remoteChangeBanner');
      if (existing) existing.remove();

      const parts = [];
      if (newCount > 0) parts.push(`${newCount} new`);
      if (updatedCount > 0) parts.push(`${updatedCount} updated`);
      const msg = `👥 ${parts.join(' & ')} annotation${(newCount + updatedCount) > 1 ? 's' : ''} from another user`;

      const banner = document.createElement('div');
      banner.id = 'remoteChangeBanner';
      banner.style.cssText = [
        'position:fixed', 'top:56px', 'left:50%', 'transform:translateX(-50%)',
        'background:#2c3e50', 'color:#ecf0f1', 'padding:8px 16px',
        'border-radius:6px', 'z-index:9990', 'display:flex', 'align-items:center',
        'gap:12px', 'font-size:13px', 'box-shadow:0 3px 10px rgba(0,0,0,0.35)'
      ].join(';');

      const text = document.createElement('span');
      text.textContent = msg;
      banner.appendChild(text);

      const refreshBtn = document.createElement('button');
      refreshBtn.textContent = '↻ Refresh';
      refreshBtn.style.cssText = 'background:#3498db;border:none;color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:12px;';
      refreshBtn.onclick = async () => {
        banner.remove();
        if (typeof refreshAnnotationsFromDb === 'function') {
          try { await refreshAnnotationsFromDb(); }
          catch (e) { console.warn('Refresh failed:', e); }
        }
      };
      banner.appendChild(refreshBtn);

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'background:none;border:none;color:#bdc3c7;cursor:pointer;font-size:14px;padding:0 2px;';
      closeBtn.onclick = () => banner.remove();
      banner.appendChild(closeBtn);

      document.body.appendChild(banner);

      // Auto-dismiss after 20s if not acted on
      setTimeout(() => { if (document.getElementById('remoteChangeBanner') === banner) banner.remove(); }, 20000);
    }

    function startChangePolling() {
      if (pollIntervalId) return;
      pollIntervalId = setInterval(pollForRemoteChanges, POLL_INTERVAL_MS);
      // Also poll on window focus (catches people switching tabs)
      window.addEventListener('focus', pollForRemoteChanges);
    }

    function stopChangePolling() {
      if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; }
      window.removeEventListener('focus', pollForRemoteChanges);
    }
    // ========== End Change Polling ==========

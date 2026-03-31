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

    async function runAutoSave() {
      if (!isOracleProjectMode()) return;
      if (!hasUnsavedChanges) {
        // Keep badge showing time since last save
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
        const annotationsToSave = [];
        drawnItems.eachLayer(layer => {
          if (layer.annotationData) annotationsToSave.push(layer.annotationData);
        });
        const projectId = currentProject.project_id;
        const dbPayload = { annotations: annotationsToSave.map(normalizeAnnotationForDb) };
        const resp = await fetch(
          `${serverUrl}/api/db/projects/${projectId}/annotations/bulk-replace`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dbPayload) }
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        hasUnsavedChanges = false;
        lastSaveTime = Date.now();
        setAutoSaveBadge('saved', '✅ Auto-saved');
        console.log(`🔄 Auto-saved ${annotationsToSave.length} annotation(s) to project #${projectId}`);
        // Fade badge back to subtle after 5s
        setTimeout(() => {
          if (!hasUnsavedChanges && document.getElementById('autoSaveBadge')) {
            setAutoSaveBadge('saved', '✅ Saved');
          }
        }, 5000);
      } catch (err) {
        console.warn('Auto-save failed:', err);
        setAutoSaveBadge('error', '❌ Auto-save failed');
      } finally {
        autoSaveInProgress = false;
      }
    }

    function startAutoSave() {
      if (autoSaveIntervalId) return; // already running
      autoSaveIntervalId = setInterval(runAutoSave, AUTO_SAVE_INTERVAL_MS);
      setAutoSaveBadge('saved', '✅ Auto-save on');
      console.log(`⏰ Auto-save started (every ${AUTO_SAVE_INTERVAL_MS / 1000}s)`);
    }

    function stopAutoSave() {
      if (autoSaveIntervalId) {
        clearInterval(autoSaveIntervalId);
        autoSaveIntervalId = null;
      }
      const badge = document.getElementById('autoSaveBadge');
      if (badge) badge.style.display = 'none';
    }
    // ========== End Auto-Save ==========

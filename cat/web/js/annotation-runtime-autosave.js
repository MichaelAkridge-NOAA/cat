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
    // A save requested while one is running is remembered and run right
    // after it, instead of being dropped (it used to be dropped while telling
    // the user "your changes are included").
    let autoSaveRerunRequested = false;

    // Every annotation the page knows about, whatever array/layer holds it.
    // Autosave used to walk only drawnItems — so annotations hidden by a
    // filter, and EVERYTHING in the popout (whose drawnItems is a stub), were
    // never saved while the badge said "Saved".
    function _allLocalAnnotations() {
      const seen = new Set();
      const out = [];
      const add = (a) => { if (a && typeof a === 'object' && !seen.has(a)) { seen.add(a); out.push(a); } };
      if (typeof annotations !== 'undefined' && Array.isArray(annotations)) annotations.forEach(add);
      if (typeof getProjectAnnotations === 'function') (getProjectAnnotations() || []).forEach(add);
      drawnItems.eachLayer(layer => add(layer.annotationData));
      return out;
    }

    function _isStillInProject(annotation) {
      if (typeof annotations !== 'undefined' && Array.isArray(annotations) && annotations.includes(annotation)) return true;
      const pa = typeof getProjectAnnotations === 'function' ? getProjectAnnotations() : null;
      return !!(pa && pa.includes(annotation));
    }

    // Dirty = never saved, explicitly marked, or its payload differs from what
    // was last saved. The fingerprint check catches edit paths that change
    // fields without marking the annotation (edit modal, batch fill, defaults,
    // paste…) — those used to be skipped and shown as "Saved".
    function annotationNeedsSync(ann) {
      if (!ann || ann._syncStatus === 'gone') return false;
      // The server refused this exact content (403/422/…). Re-sending the
      // same thing can't succeed, so wait until the user changes it.
      if (ann._syncStatus === 'rejected') {
        return annotationPayloadFingerprint(ann) !== ann._rejectedFingerprint;
      }
      // A keepalive create sent on tab close is still out; don't POST again.
      if (ann._createInFlightUntil && Date.now() < ann._createInFlightUntil) return false;
      // The popout's table holds copies of the main window's annotations; a
      // copy without a db id is still being created by the main window, and
      // POSTing it here too would duplicate it.
      if (!getDbAnnotationId(ann)) return !window._catPopoutMode;
      if (ann._syncStatus === 'pending' || ann._syncStatus === 'error') return true;
      if (ann._syncedFingerprint == null) {
        // Loaded from the server without a baseline: take it now.
        ann._syncedFingerprint = annotationPayloadFingerprint(ann);
        return false;
      }
      return annotationPayloadFingerprint(ann) !== ann._syncedFingerprint;
    }

    // Unsaved = waiting to be sent, or refused by the server (still not saved).
    function countUnsavedAnnotations() {
      if (!isOracleProjectMode() || window.catReadOnly) return 0;
      return _allLocalAnnotations().filter(a => a && (a._syncStatus === 'rejected' || annotationNeedsSync(a))).length;
    }

    // Three-way merge for a 409. Base = what this tab last saved (the
    // fingerprint is exactly that payload, JSON-encoded), theirs = the
    // server's current row, mine = this tab's current fields. Fields this tab
    // didn't touch take the server's value; fields it did touch keep ours.
    // Rewrites `ann` IN PLACE and moves its baseline to the server's copy.
    // Returns false (caller falls back to overwrite) when there is no base.
    function _mergeConflict(ann, serverAnn) {
      if (!ann._syncedFingerprint) return false;
      let base;
      try { base = JSON.parse(ann._syncedFingerprint); } catch (e) { return false; }
      const [baseFeature, baseProps] = base;
      const mine = normalizeAnnotationForDb(ann);
      const theirs = normalizeAnnotationForDb(serverAnn);
      const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

      const mergedProps = Object.assign({}, theirs.properties);
      const keys = new Set([...Object.keys(baseProps || {}), ...Object.keys(mine.properties)]);
      keys.forEach(k => {
        if (same(mine.properties[k], (baseProps || {})[k])) return; // untouched here
        if (mine.properties[k] === undefined) delete mergedProps[k];
        else mergedProps[k] = mine.properties[k];
      });
      const geometryChangedHere = !same(mine.feature, baseFeature);
      const mergedGeometry = geometryChangedHere
        ? (mine.feature && mine.feature.geometry)
        : (theirs.feature && theirs.feature.geometry);

      Object.keys(ann).forEach(k => {
        if (k === 'id' || k.charAt(0) === '_') return;
        delete ann[k];
      });
      Object.assign(ann, mergedProps);
      ann.geometry = mergedGeometry;
      // The server's copy is now the base for the next comparison.
      ann._syncedFingerprint = annotationPayloadFingerprint(serverAnn);

      // Keep the map in step if the other user moved the shape.
      if (!geometryChangedHere && mergedGeometry) {
        drawnItems.eachLayer(layer => {
          if (layer.annotationData !== ann || !layer.setLatLngs) return;
          try {
            const fresh = L.geoJSON(mergedGeometry).getLayers()[0];
            if (fresh && fresh.getLatLngs) layer.setLatLngs(fresh.getLatLngs());
          } catch (e) { /* display only */ }
        });
      }
      return true;
    }
    window.catCountUnsavedAnnotations = countUnsavedAnnotations;

    // Remove an annotation from every local structure (arrays, map, labels).
    function _dropAnnotationLocally(ann) {
      if (typeof annotations !== 'undefined' && Array.isArray(annotations)) {
        const i = annotations.indexOf(ann);
        if (i !== -1) annotations.splice(i, 1);
      }
      const pa = typeof getProjectAnnotations === 'function' ? getProjectAnnotations() : null;
      if (pa && pa !== annotations) {
        const j = pa.indexOf(ann);
        if (j !== -1) pa.splice(j, 1);
      }
      const layers = [];
      drawnItems.eachLayer(layer => { if (layer.annotationData === ann) layers.push(layer); });
      layers.forEach(layer => {
        if (typeof removeAnnotationLabel === 'function') removeAnnotationLabel(layer._leaflet_id);
        drawnItems.removeLayer(layer);
      });
    }

    async function runAutoSave() {
      if (!isOracleProjectMode()) return;
      if (window.catReadOnly) return; // view-only: the server would 403 every write
      if (autoSaveInProgress) {
        autoSaveRerunRequested = true;
        return;
      }

      const toSync = _allLocalAnnotations().filter(annotationNeedsSync);
      if (toSync.length === 0) {
        hasUnsavedChanges = false;
        if (lastSaveTime) {
          const secs = Math.round((Date.now() - lastSaveTime) / 1000);
          setAutoSaveBadge('saved', `✅ Saved ${secs}s ago`);
        }
        return;
      }

      autoSaveInProgress = true;
      autoSaveRerunRequested = false;
      hasUnsavedChanges = true;
      // Task A2 Step 3: explicit window-scoped in-flight flag so callers in
      // other files (e.g. saveProjectAndAnnotations in shell-init.js) can
      // check it without depending on autoSaveInProgress's shared-scope
      // visibility. Always reset in the finally below.
      window._catAutoSaveInFlight = true;
      setAutoSaveBadge('saving', `⏳ Saving ${toSync.length} annotation(s)…`);
      let removedByOthers = 0;
      try {
        console.log(`🔄 Differential auto-save: ${toSync.length} annotation(s) to sync`);
        const errors = [];
        const rejected = [];

        for (const ann of toSync) {
          // Deleted locally before its turn came up — nothing to save.
          if (!_isStillInProject(ann)) continue;
          const wasNew = !getDbAnnotationId(ann);
          const sentFingerprint = annotationPayloadFingerprint(ann);
          try {
            const synced = await syncAnnotationToDb(ann);
            mergeServerIdentity(ann, synced);
            _recordSyncedByMe(synced._dbAnnotationId, synced._dbAnnotationVersion);
            ann._syncedFingerprint = sentFingerprint;
            // Only "synced" if nothing changed while the request was in
            // flight — otherwise the newer edit stays pending for next run.
            ann._syncStatus = (annotationPayloadFingerprint(ann) === sentFingerprint) ? 'synced' : 'pending';

            // Deleted while its create was in flight: the row now exists
            // server-side, so delete it there too or it comes back on refresh.
            if (wasNew && !_isStillInProject(ann)) {
              try { await deleteAnnotationFromDb(ann); }
              catch (delErr) { console.warn('Could not delete annotation removed during save:', delErr); }
            }
          } catch (err) {
            if (err.isGone) {
              // Someone deleted it. Never re-create it — drop it here too.
              ann._syncStatus = 'gone';
              _dropAnnotationLocally(ann);
              removedByOthers++;
              continue;
            }
            // Task 7 round 2 fix (Finding 2): recover from 409/404 instead of
            // re-sending the same stale request forever on every retry.
            if (err.isConflict) {
              // Someone else saved this annotation since we loaded it. Merge
              // instead of overwriting: start from the server's current
              // copy and re-apply only the fields THIS tab changed since its
              // last save. (It used to re-send the whole record, silently
              // undoing the other person's changes to any other field.)
              const merged = err.serverAnnotation ? _mergeConflict(ann, err.serverAnnotation) : false;
              if (err.serverAnnotation && err.serverAnnotation._dbAnnotationVersion != null) {
                ann._dbAnnotationVersion = err.serverAnnotation._dbAnnotationVersion;
              } else if (err.currentVersion != null) {
                ann._dbAnnotationVersion = err.currentVersion;
              }
              if (typeof showStatus === 'function') {
                var _now = Date.now();
                if (!window._catLastConflictToast || _now - window._catLastConflictToast > 10000) {
                  window._catLastConflictToast = _now;
                  showStatus(merged
                    ? 'An annotation was also changed by someone else — merged your edits with theirs.'
                    : 'An annotation was also changed by someone else — your version will be saved over it.', 'info');
                }
              }
              ann._syncStatus = 'pending';
            } else if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
              // Permanent refusal (permissions, validation…). Retrying the
              // same content forever used to end in a false "database is
              // unreachable" banner. Hold it until the user changes it.
              ann._syncStatus = 'rejected';
              ann._rejectedFingerprint = sentFingerprint;
              ann._rejectedReason = err.message;
              rejected.push(err);
              continue;
            } else if (err.isNotFound) {
              // Row is gone for good (hard-deleted), not soft-deleted by a
              // user (that is 410 above) — re-create it so this user's data
              // isn't lost. getDbAnnotationId() falls back through
              // annotation_id/id too, so all of them must be cleared.
              delete ann._dbAnnotationId;
              delete ann._dbAnnotationVersion;
              delete ann.annotation_id;
              delete ann.id;
              ann._syncStatus = 'pending';
            } else {
              ann._syncStatus = 'error';
            }
            errors.push(err);
          }
        }

        if (removedByOthers > 0) {
          showStatus(`🗑️ ${removedByOthers} annotation(s) were deleted by another user and removed here`, 'info');
          if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
          if (typeof updateStatistics === 'function') updateStatistics();
        }

        if (rejected.length > 0) {
          showStatus(`❌ ${rejected.length} annotation(s) were refused by the server and are NOT saved: ${rejected[0].message}`, 'error');
          if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
        }

        if (errors.length > 0) {
          throw new Error(`${errors.length} of ${toSync.length} annotation(s) failed to sync`);
        }

        lastSaveTime = Date.now();
        // Reset retry state on success (Fix 1c)
        autoSaveRetryCount = 0;
        if (autoSaveRetryTimeoutId) { clearTimeout(autoSaveRetryTimeoutId); autoSaveRetryTimeoutId = null; }
        const badge = document.getElementById('autoSaveBadge');
        if (badge) { badge.style.cursor = ''; badge.onclick = null; }
        // Exit degraded mode if we were in it (5c)
        _exitDegradedMode();

        const stillDirty = countUnsavedAnnotations();
        const refusedCount = _allLocalAnnotations().filter(a => a && a._syncStatus === 'rejected').length;
        hasUnsavedChanges = stillDirty > 0;
        if (refusedCount > 0) {
          setAutoSaveBadge('error', `❌ ${refusedCount} annotation(s) not saved (refused by server)`);
          if (stillDirty > refusedCount) autoSaveRerunRequested = true;
        } else if (stillDirty > 0) {
          setAutoSaveBadge('pending', `🔵 ${stillDirty} unsaved change(s)`);
          autoSaveRerunRequested = true;
        } else {
          setAutoSaveBadge('saved', '✅ Auto-saved');
        }
        // Mark rows saved/unsaved in place (was a full table rebuild after
        // every save, just to refresh status).
        if (typeof window.catRefreshRowSaveStates === 'function') window.catRefreshRowSaveStates();
        // Fade badge back to subtle after 5s
        setTimeout(() => {
          if (!hasUnsavedChanges && document.getElementById('autoSaveBadge')) {
            setAutoSaveBadge('saved', '✅ Saved');
          }
        }, 5000);
      } catch (err) {
        hasUnsavedChanges = true;
        autoSaveRerunRequested = false; // the retry below covers it
        // Exponential backoff retry logic (Fix 1c)
        autoSaveRetryCount++;
        console.warn(`Auto-save failed (attempt ${autoSaveRetryCount}):`, err);
        const maxRetries = 3;
        const retryDelays = [5000, 15000, 30000];
        if (autoSaveRetryCount <= maxRetries) {
          const delay = retryDelays[autoSaveRetryCount - 1];
          setAutoSaveBadge('error', `❌ Save failed — retrying in ${delay / 1000}s…`);
          if (autoSaveRetryTimeoutId) clearTimeout(autoSaveRetryTimeoutId);
          autoSaveRetryTimeoutId = setTimeout(() => { runAutoSave(); }, delay);
        } else {
          setAutoSaveBadge('error', '❌ Auto-save failed — click to export backup');
          const badge = document.getElementById('autoSaveBadge');
          if (badge) {
            badge.style.cursor = 'pointer';
            // Assign (not addEventListener): every later failed auto-save runs
            // this branch again, and stacked listeners made one click fire the
            // backup export several times. Cleared on the next successful save.
            badge.onclick = () => { exportProjectData(); };
          }
          // Diagnose: is it a full outage or just a DB error? (5c)
          // Nothing is persisted locally — unsaved work exists only in this
          // tab — so say that, and point at the export.
          _checkConnectivity().then(online => {
            const label = online
              ? '⚠️ Save failed — the database is unreachable. Your changes are NOT saved and exist only in this tab. Export a backup and do not close the page.'
              : '📡 No network connection. Your changes are NOT saved and exist only in this tab. Export a backup and do not close the page.';
            _enterDegradedMode(label);
          });
        }
      } finally {
        autoSaveInProgress = false;
        window._catAutoSaveInFlight = false;
        if (autoSaveRerunRequested) {
          autoSaveRerunRequested = false;
          setTimeout(() => { runAutoSave(); }, 500);
        }
      }
    }

    // Download everything this tab holds as GeoJSON — the escape hatch the
    // save-failure badge/banner point at. It previously called a function
    // that only existed in an unloaded legacy file, so the button did nothing.
    function exportProjectData() {
      try {
        const features = _allLocalAnnotations().map(ann => {
          const p = normalizeAnnotationForDb(ann);
          return {
            type: 'Feature',
            geometry: p.feature && p.feature.geometry ? p.feature.geometry : null,
            properties: Object.assign({}, p.properties, {
              _db_annotation_id: getDbAnnotationId(ann),
              _unsaved: annotationNeedsSync(ann)
            })
          };
        });
        const fc = {
          type: 'FeatureCollection',
          project_id: currentProject?.project_id ?? null,
          project_name: currentProject?.name || currentProject?.project_name || null,
          exported_at: new Date().toISOString(),
          features
        };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = `cat_project_${currentProject?.project_id ?? 'unknown'}_backup_${stamp}.geojson`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        if (typeof showStatus === 'function') showStatus(`📥 Exported ${features.length} annotation(s) as a backup file`, 'success');
      } catch (e) {
        console.error('Backup export failed:', e);
        if (typeof showStatus === 'function') showStatus(`❌ Backup export failed: ${e.message}`, 'error');
      }
    }
    window.exportProjectData = exportProjectData;

    // ========== Local journal of unsaved changes ==========
    // Anything not yet on the server is also written to localStorage, so a
    // tab that is closed, crashes or loses its network doesn't take the work
    // with it: the next time the project is opened, the changes are offered
    // back and saved through the normal path (409 → merge, 410 → dropped).
    //
    // localStorage, not IndexedDB: it is synchronous, so the final write on
    // pagehide/beforeunload actually completes before the page goes away.
    // Entries are per tab; a tab only replays entries from tabs whose
    // heartbeat has stopped, never from a tab that is still open and saving.
    const JOURNAL_PREFIX = 'cat_journal_v1:';
    const JOURNAL_HB_PREFIX = 'cat_journal_hb_v1:';
    const JOURNAL_STALE_MS = 20000;
    const JOURNAL_TAB_ID = (function () {
      try { return (typeof _newUuid === 'function') ? _newUuid() : String(Date.now()) + Math.random(); }
      catch (e) { return String(Date.now()) + Math.random(); }
    })();
    let _journalHasItems = false;

    function _journalKey(projectId, tabId) {
      return `${JOURNAL_PREFIX}${projectId}:${tabId}`;
    }

    // Copy of an annotation's saveable state plus what replay needs.
    function _journalItem(ann) {
      const fields = {};
      Object.keys(ann).forEach(k => {
        if (k === 'properties' || k === 'id' || k.charAt(0) === '_') return;
        fields[k] = ann[k];
      });
      return {
        dbId: getDbAnnotationId(ann) || null,
        clientUuid: getDbAnnotationId(ann) ? (ann._clientUuid || null) : ensureClientUuid(ann),
        version: ann._dbAnnotationVersion ?? null,
        baseFingerprint: ann._syncedFingerprint || null,
        fields
      };
    }

    // Rewrite this tab's journal entry from the current unsaved set.
    // `force` = do the full scan even if nothing is flagged (used on unload).
    function writeJournal(force) {
      const projectId = currentProject?.project_id;
      if (!projectId || !isOracleProjectMode() || window.catReadOnly) return;
      if (!force && !hasUnsavedChanges && !_journalHasItems) return;
      const key = _journalKey(projectId, JOURNAL_TAB_ID);
      try {
        const unsaved = _allLocalAnnotations().filter(a => a && (a._syncStatus === 'rejected' || annotationNeedsSync(a)));
        if (unsaved.length === 0) {
          localStorage.removeItem(key);
          _journalHasItems = false;
          return;
        }
        localStorage.setItem(key, JSON.stringify({
          projectId,
          tabId: JOURNAL_TAB_ID,
          savedAt: Date.now(),
          items: unsaved.map(_journalItem)
        }));
        _journalHasItems = true;
      } catch (e) {
        // Quota or serialisation error — the tab still has the data, and the
        // save badge/unload prompt still warn. Don't break the page over it.
        console.warn('Could not write the unsaved-changes journal:', e);
      }
    }
    window.catWriteJournal = writeJournal;

    function _journalHeartbeat() {
      try { localStorage.setItem(JOURNAL_HB_PREFIX + JOURNAL_TAB_ID, String(Date.now())); } catch (e) { /* ignore */ }
    }

    function _tabIsAlive(tabId) {
      try {
        const ts = parseInt(localStorage.getItem(JOURNAL_HB_PREFIX + tabId) || '0', 10);
        return Date.now() - ts < JOURNAL_STALE_MS;
      } catch (e) {
        return false;
      }
    }

    function _orphanedJournalEntries(projectId) {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || !key.startsWith(`${JOURNAL_PREFIX}${projectId}:`)) continue;
          let entry = null;
          try { entry = JSON.parse(localStorage.getItem(key)); } catch (e) { /* corrupt */ }
          if (!entry || entry.tabId === JOURNAL_TAB_ID || _tabIsAlive(entry.tabId)) continue;
          out.push({ key, entry });
        }
      } catch (e) { /* storage unavailable */ }
      return out;
    }

    // Build a map layer for an annotation recovered from the journal.
    function _addRecoveredLayer(ann) {
      if (!ann.geometry || typeof L === 'undefined' || window._catPopoutMode) return;
      try {
        const style = (typeof getAnnotationLayerStyle === 'function')
          ? getAnnotationLayerStyle(ann)
          : { color: '#3388ff', weight: 7, opacity: 0.8, fillOpacity: 0.3 };
        const layer = L.geoJSON(ann.geometry, { pane: 'annotationsPane', style }).getLayers()[0];
        if (!layer) return;
        layer.annotationData = ann;
        layer.on('click', function (e) {
          L.DomEvent.stopPropagation(e);
          if (typeof showAnnotationPopup === 'function') showAnnotationPopup(layer, e.latlng);
        });
        drawnItems.addLayer(layer);
        if (typeof labelsVisible !== 'undefined' && labelsVisible && typeof addLabelToAnnotation === 'function') {
          addLabelToAnnotation(layer);
        }
      } catch (e) {
        console.warn('Could not draw a recovered annotation:', e);
      }
    }

    function _applyJournalItem(item) {
      const local = _allLocalAnnotations();
      let target = null;
      if (item.dbId) target = local.find(a => String(getDbAnnotationId(a)) === String(item.dbId));
      if (!target && item.clientUuid) target = local.find(a => a._clientUuid === item.clientUuid);

      if (target) {
        // Existing annotation: put the unsaved fields back IN PLACE, with the
        // version/baseline they were edited against, so the save goes through
        // the normal conflict path (a newer server copy is merged, not
        // overwritten).
        Object.keys(target).forEach(k => {
          if (k === 'id' || k.charAt(0) === '_') return;
          delete target[k];
        });
        Object.assign(target, item.fields);
        if (item.dbId && item.version != null) target._dbAnnotationVersion = item.version;
        if (item.baseFingerprint) target._syncedFingerprint = item.baseFingerprint;
        if (item.clientUuid && !target._clientUuid) target._clientUuid = item.clientUuid;
        target._syncStatus = 'pending';
        drawnItems.eachLayer(layer => {
          if (layer.annotationData !== target) return;
          if (layer.setLatLngs && target.geometry) {
            try {
              const fresh = L.geoJSON(target.geometry).getLayers()[0];
              if (fresh && fresh.getLatLngs) layer.setLatLngs(fresh.getLatLngs());
            } catch (e) { /* display only */ }
          }
          if (layer.setStyle && typeof getAnnotationLayerStyle === 'function') layer.setStyle(getAnnotationLayerStyle(target));
        });
        return 'updated';
      }

      if (item.dbId) {
        // It was saved once but is no longer in the project — someone deleted
        // it after this change was made. Deleted wins; don't resurrect it.
        return 'skipped';
      }

      // Never reached the server: re-create it (same client_uuid, so if the
      // create did in fact go through, the server hands back that row).
      const ann = Object.assign({}, item.fields);
      ann._clientUuid = item.clientUuid || ensureClientUuid(ann);
      ann._syncStatus = 'pending';
      annotations.push(ann);
      const pa = getProjectAnnotations();
      if (pa && pa !== annotations) pa.push(ann);
      _addRecoveredLayer(ann);
      return 'created';
    }

    async function recoverJournaledChanges() {
      const projectId = currentProject?.project_id;
      if (!projectId || window.catReadOnly) return;
      const orphans = _orphanedJournalEntries(projectId);
      if (orphans.length === 0) return;

      // Drop items whose content the server already has (e.g. the tab-close
      // keepalive save did get through) — only offer what is really missing.
      const local = _allLocalAnnotations();
      const alreadySaved = (it) => {
        const match = local.find(a =>
          (it.dbId && String(getDbAnnotationId(a)) === String(it.dbId)) ||
          (it.clientUuid && a._clientUuid === it.clientUuid));
        if (!match) return false;
        const probe = Object.assign({}, it.fields);
        return annotationPayloadFingerprint(probe) === annotationPayloadFingerprint(match);
      };
      const items = [];
      orphans.forEach(o => (o.entry.items || []).forEach(it => { if (!alreadySaved(it)) items.push(it); }));
      const newest = Math.max(...orphans.map(o => o.entry.savedAt || 0));
      const when = newest ? new Date(newest).toLocaleString() : 'an earlier session';
      const discardKeys = () => orphans.forEach(o => { try { localStorage.removeItem(o.key); } catch (e) { /* ignore */ } });

      if (items.length === 0) { discardKeys(); return; }

      const restore = (typeof catConfirm === 'function')
        ? await catConfirm(
            `${items.length} change(s) to this project from ${when} never reached the server ` +
            `(the tab was closed or lost its connection).\n\nRestore and save them now?`,
            { ok: 'Restore changes', cancel: 'Discard them' }
          )
        : true;
      if (!restore) {
        discardKeys();
        showStatus(`Discarded ${items.length} unsaved change(s) from ${when}`, 'info');
        return;
      }

      const counts = { updated: 0, created: 0, skipped: 0 };
      items.forEach(it => {
        try { counts[_applyJournalItem(it)]++; }
        catch (e) { console.warn('Could not restore a journaled change:', e); counts.skipped++; }
      });
      discardKeys();
      hasUnsavedChanges = true;
      writeJournal(true); // now held by this tab until saved
      if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
      if (typeof updateStatistics === 'function') updateStatistics();
      const parts = [];
      if (counts.updated) parts.push(`${counts.updated} edit(s)`);
      if (counts.created) parts.push(`${counts.created} new annotation(s)`);
      showStatus(`♻️ Recovered ${parts.join(' and ') || 'nothing'} from ${when}` +
        (counts.skipped ? ` — ${counts.skipped} skipped (deleted since)` : '') + '. Saving now…', 'success');
      runAutoSave();
    }
    window.recoverJournaledChanges = recoverJournaledChanges;

    // Keep the journal current while the page is open, and write it one last
    // time as the page goes away (pagehide also covers mobile/bfcache).
    setInterval(() => { _journalHeartbeat(); writeJournal(false); }, 5000);
    _journalHeartbeat();
    window.addEventListener('pagehide', () => {
      writeJournal(true);
      // Stop the heartbeat so the next load can recover this tab's entry.
      try { localStorage.removeItem(JOURNAL_HB_PREFIX + JOURNAL_TAB_ID); } catch (e) { /* ignore */ }
    });
    // ========== End local journal ==========

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

      // Reset retry count so auto-save resumes cleanly. autoSaveInProgress is
      // deliberately NOT touched: this also runs from the 15s recovery timer
      // while a save is mid-flight, and clearing the flag let a second
      // runAutoSave start in parallel and POST the same new annotation twice.
      autoSaveRetryCount = 0;
      if (autoSaveRetryTimeoutId) { clearTimeout(autoSaveRetryTimeoutId); autoSaveRetryTimeoutId = null; }
      if (!autoSaveInProgress) setTimeout(() => { runAutoSave(); }, 0);
    }
    // ========== End Offline / Degraded Mode ==========

    // ========== Multi-User Change Polling (5b) ==========
    const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds
    let pollIntervalId = null;

    // Track annotation IDs we have recently synced ourselves.
    // Entries are { id, version, ts }.  Cleared after 90s (> poll interval).
    const _recentlySyncedByMe = [];
    const _RECENTLY_SYNCED_TTL = 90 * 1000; // 90 seconds

    /** Call after every successful auto-save/sync to record our own writes. */
    function _recordSyncedByMe(dbAnnotationId, version) {
      if (!dbAnnotationId) return;
      _recentlySyncedByMe.push({ id: dbAnnotationId, version: version ?? 1, ts: Date.now() });
    }

    /** Prune entries older than TTL */
    function _pruneRecentlySynced() {
      const cutoff = Date.now() - _RECENTLY_SYNCED_TTL;
      while (_recentlySyncedByMe.length > 0 && _recentlySyncedByMe[0].ts < cutoff) {
        _recentlySyncedByMe.shift();
      }
    }

    async function pollForRemoteChanges() {
      if (!isOracleProjectMode || !isOracleProjectMode()) return;
      if (autoSaveInProgress) return; // don't poll while auto-save is mid-sync
      const projectId = currentProject?.project_id;
      if (!projectId) return;

      try {
        // ids + versions only (was: every annotation with its geometry, capped
        // at 500 rows — so big projects and deletions were invisible).
        const resp = await fetch(`${window.location.origin}/api/db/projects/${projectId}/annotations/versions`);
        if (!resp.ok) return;
        const data = await resp.json();
        const remoteAnns = data.annotations || [];

        // Prune stale entries from the recently-synced list
        _pruneRecentlySynced();

        // Build sets from our recent syncs for fast lookup
        const mySyncedIds = new Set(_recentlySyncedByMe.map(e => e.id));
        const mySyncedVersions = {};
        _recentlySyncedByMe.forEach(e => {
          mySyncedVersions[e.id] = Math.max(mySyncedVersions[e.id] || 0, e.version);
        });

        // Build a map of local annotation id → version
        const localVersions = {};
        let localUnsyncedCount = 0;
        // Use annotations array directly (always kept in sync after refresh/load)
        const allLocalAnns = (typeof annotations !== 'undefined' && annotations.length > 0)
          ? annotations
          : (typeof getProjectAnnotations === 'function' ? getProjectAnnotations() : []);
        allLocalAnns.forEach(a => {
          const dbId = a._dbAnnotationId || a.annotation_id || a.id;
          if (dbId) {
            localVersions[dbId] = a._dbAnnotationVersion ?? a.version ?? 1;
          } else {
            localUnsyncedCount++;
          }
        });

        let newCount = 0;
        let updatedCount = 0;
        remoteAnns.forEach(r => {
          const id = r.annotation_id;
          if (!id) return;
          if (!(id in localVersions)) {
            // This ID isn't in our local list.  If we recently created it
            // ourselves (race between sync and poll) skip it.
            if (!mySyncedIds.has(id)) {
              newCount++;
            }
          } else if ((r.version ?? 1) > localVersions[id]) {
            // Version bump.  If our own sync caused it, skip.
            if (mySyncedVersions[id] && mySyncedVersions[id] >= (r.version ?? 1)) {
              // This version bump was from our own auto-save — ignore
            } else {
              updatedCount++;
            }
          }
        });

        // Subtract remaining unsynced local annotations from "new" count
        newCount = Math.max(0, newCount - localUnsyncedCount);

        // Saved here, gone from the server = deleted by someone else.
        const remoteIds = new Set(remoteAnns.map(r => String(r.annotation_id)));
        const deletedCount = Object.keys(localVersions).filter(id => !remoteIds.has(String(id))).length;

        if (newCount > 0 || updatedCount > 0 || deletedCount > 0) {
          _showRemoteChangeBanner(newCount, updatedCount, deletedCount);
        }
      } catch (e) {
        // Polling failures are silent — don't disrupt the user
      }
    }

    function _showRemoteChangeBanner(newCount, updatedCount, deletedCount = 0) {
      const existing = document.getElementById('remoteChangeBanner');
      if (existing) existing.remove();

      const parts = [];
      if (newCount > 0) parts.push(`${newCount} new`);
      if (updatedCount > 0) parts.push(`${updatedCount} updated`);
      if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
      const msg = `👥 ${parts.join(', ')} annotation${(newCount + updatedCount + deletedCount) > 1 ? 's' : ''} from another user`;

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

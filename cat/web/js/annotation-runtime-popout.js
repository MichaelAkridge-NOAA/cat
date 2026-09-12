(function() {
    'use strict';
    const _ch = new BroadcastChannel('cat-annotation-v1');
    window._catChannel = _ch;
    const _mode = window._catPopoutMode;

    // ── Shared: the popout's two-state body ──
    // The popout has no map of its own, so until the main window sends a shape
    // there is nothing to fill in a form about. Exactly one of the waiting
    // indicator and the form is visible at a time; this is the single place
    // that decides which, so the two can't drift out of sync.
    //
    // (Previously nothing ever toggled these on 'new-shape', and the post-save
    // path in annotation-runtime-operations.js hid #formSectionContent without
    // anything to show it again — so the popout's form disappeared for good
    // after the first save.)
    function _setPopoutFormState(hasShape) {
      const waiting = document.getElementById('popoutWaitingIndicator');
      // Hide only the field grid, NOT the whole #formSectionContent: the
      // annotations table, its filter and Select-by-Attribute all live inside
      // that section too, so hiding it (as the old save path did) blanked the
      // entire popout between shapes and left nothing to review or edit.
      const fields = document.querySelector('.form-container');
      const section = document.getElementById('formSectionContent');
      if (waiting) waiting.classList.toggle('visible', !hasShape);
      if (fields) fields.style.display = hasShape ? '' : 'none';
      if (section) section.style.display = ''; // undo any older state
    }
    window._catSetPopoutFormState = _setPopoutFormState;

    if (_mode) {
      // ── Popout window setup ──
      document.body.classList.add('cat-popout-' + _mode);
      document.title = 'CAT — Annotation Panel';

      // Show the annotation panel
      const panel = document.getElementById('annotationFormPanel');
      if (panel) panel.style.display = '';

      // Both modes show the full panel — form + table both visible

      // Hide pop-out buttons (no need to pop out from within a popout)
      const _pb = document.getElementById('popoutBtn');
      if (_pb) _pb.style.display = 'none';

      // The popout's own navbar (and the timer/save badges that live in it) is
      // entirely display:none (annotation-popout-boot.js), so there was previously
      // no way to see timer/save status here at all - "stay in sync" had nothing to
      // show. Insert a small mirrored readout, fed by 'status-sync' broadcasts from
      // the main window (the authoritative timer/session owner - popouts don't draw
      // shapes, so they never independently start a timer of their own).
      const _statusBar = document.createElement('div');
      _statusBar.id = 'popoutStatusMirror';
      _statusBar.style.cssText = 'display:flex;gap:12px;align-items:center;font-size:12px;' +
        'padding:6px 10px;margin-bottom:8px;background:#f8f9fa;border:1px solid #e5e7eb;' +
        'border-radius:4px;color:#495057;';
      _statusBar.innerHTML =
        '<span id="popoutTimerMirror" style="display:none;font-family:\'Courier New\',monospace;">⏱️ --:--</span>' +
        '<span id="popoutSaveMirror" style="display:none;"></span>' +
        '<span id="popoutLinkMirror" style="margin-left:auto;color:#6c757d;">🔗 waiting for main window…</span>';
      if (panel) panel.insertBefore(_statusBar, panel.firstChild);

      // Start in the waiting state: nothing has been drawn for this popout yet.
      _setPopoutFormState(false);

      function _setLinkText(text) {
        const el = document.getElementById('popoutLinkMirror');
        if (el) el.textContent = text;
      }

      // Listen for messages from the main window
      _ch.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'status-sync') {
          _setLinkText('🔗 linked to main window');
          const t = document.getElementById('popoutTimerMirror');
          const s = document.getElementById('popoutSaveMirror');
          if (t) {
            t.style.display = msg.timerVisible ? 'inline' : 'none';
            t.textContent = '⏱️ ' + (msg.timerText || '--:--');
          }
          if (s) {
            s.style.display = msg.badgeVisible ? 'inline' : 'none';
            s.textContent = msg.badgeText || '';
          }
        }
        if (msg.type === 'new-shape') {
          window._popoutGeometry = msg.geometry;
          window._popoutShapeType = msg.shapeType;
          _setPopoutFormState(true);
          if (typeof showStatus === 'function') showStatus('Shape received — fill in the form and click Save', 'info');
          // Focus the species field so the user can start typing immediately
          window.focus();
          const spField = document.getElementById('spcode');
          if (spField) { spField.focus(); spField.select(); }
        }
        if (msg.type === 'shape-discarded') {
          // The main window threw away the shape this form was filling in
          // (Escape or the Discard button). Saving now would write an
          // annotation for geometry the analyst already rejected.
          window._popoutGeometry = null;
          window._popoutShapeType = null;
          _setPopoutFormState(false);
          if (typeof showStatus === 'function') showStatus('Shape discarded in the main window', 'info');
        }
        if (msg.type === 'sync-annotations' && Array.isArray(msg.annotations)) {
          // Bulk draw sync — replace local annotations array and refresh table
          if (typeof annotations !== 'undefined' && Array.isArray(annotations)) {
            annotations.length = 0;
            msg.annotations.forEach(function(a) { annotations.push(a); });
            if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
          }
        }
        if (msg.type === 'annotations-changed') {
          // Was gated on `_mode === 'table'`, a mode name that no longer exists (see
          // the saveAnnotation() fix in annotation-runtime-operations.js) - the single
          // 'panel' mode shows the table alongside the form, so it should refresh here too.
          if (typeof refreshAnnotationsFromDb === 'function') {
            refreshAnnotationsFromDb().catch(function(e) { console.warn('Refresh failed:', e); });
          }
        }
        if (msg.type === 'main-closing') {
          // Without the main window there is no map to receive shapes from and
          // no session owner — say so rather than looking idle forever.
          _setLinkText('🔌 main window closed');
          if (typeof showStatus === 'function') {
            showStatus('Main window closed — reopen CAT to keep annotating', 'error');
          }
        }
      };

      // Announce readiness to main window (so main can send pending shape)
      _ch.postMessage({ type: 'popout-ready', mode: _mode });

      // Tell main window when this popout closes so it can restore the panel
      window.addEventListener('beforeunload', function() {
        _ch.postMessage({ type: 'popout-closed' });
      });

    } else {
      // ── Main window: listen for popout events ──
      function _broadcastStatus() {
        const timerEl = document.getElementById('annotationTimer');
        const timerText = document.getElementById('timerDisplay');
        const badge = document.getElementById('autoSaveBadge');
        _ch.postMessage({
          type: 'status-sync',
          timerVisible: !!timerEl && getComputedStyle(timerEl).display !== 'none',
          timerText: timerText ? timerText.textContent : null,
          badgeVisible: !!badge && getComputedStyle(badge).display !== 'none',
          badgeText: badge ? badge.textContent : null
        });
      }
      window._catBroadcastStatus = _broadcastStatus;

      // Mirror both elements to any open popout: a MutationObserver picks up every
      // update regardless of which of the several call sites changed them (autosave.js,
      // navbar.js, settings-app.js, shell-init.js all touch #autoSaveBadge), and a 1s
      // poll covers the timer's own textContent tick (updateTimerDisplay in core.js).
      const _timerEl = document.getElementById('annotationTimer');
      const _badgeEl = document.getElementById('autoSaveBadge');
      if (_badgeEl) {
        new MutationObserver(_broadcastStatus).observe(_badgeEl, {
          childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['style']
        });
      }
      if (_timerEl) {
        setInterval(_broadcastStatus, 1000);
      }

      // Re-send the shape that is currently drawn-but-unsaved, if any.
      //
      // A popout opened AFTER the shape was drawn used to get nothing: the
      // main window broadcast 'new-shape' once, at draw time, into a channel
      // no one was listening on yet, and the replay path was gated on
      // `msg.mode === 'form'` — a mode name that no longer exists (the only
      // mode is 'panel'), so it was unreachable dead code. The popout then sat
      // on "Draw a shape on the main map" with a shape already on the map.
      //
      // Rebuilt from live state rather than from a cached message, so it can
      // never replay a shape that has since been saved or discarded.
      function _replayPendingShape() {
        try {
          if (typeof currentAnnotation === 'undefined' || !currentAnnotation) return;
          const layer = currentAnnotation.layer;
          if (!layer || layer.annotationData) return; // already saved — not pending
          _ch.postMessage({
            type: 'new-shape',
            geometry: currentAnnotation.geometry,
            shapeType: currentAnnotation.type
          });
        } catch (e) {
          // currentAnnotation lives in another script's lexical scope; if that
          // script hasn't run yet there is nothing pending anyway.
        }
      }
      window._catReplayPendingShape = _replayPendingShape;

      // The popout saved the shape the main window is still holding as an
      // unsaved drawing. refreshAnnotations() only removes layers that carry
      // annotationData/objectId, so that raw drawn layer would survive the
      // refresh and sit on top of the freshly-loaded DB copy as a duplicate
      // outline, with the Discard button still offering to delete "it".
      function _clearGhostAfterPopoutSave() {
        try {
          if (typeof currentAnnotation === 'undefined' || !currentAnnotation) return;
          const layer = currentAnnotation.layer;
          if (layer && !layer.annotationData && typeof drawnItems !== 'undefined' && drawnItems) {
            drawnItems.removeLayer(layer);
          }
          currentAnnotation = null;
        } catch (e) { /* nothing drawn */ }
        const discardBtn = document.getElementById('discardAnnotationBtn');
        if (discardBtn) discardBtn.style.display = 'none';
      }

      _ch.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'annotations-changed') {
          _clearGhostAfterPopoutSave();
          if (typeof refreshAnnotations === 'function') {
            refreshAnnotations().catch(function(e) { console.warn('Refresh failed:', e); });
          }
        }
        if (msg.type === 'popout-ready') {
          // Send an immediate snapshot so the popout doesn't wait up to 1s for its first paint.
          _broadcastStatus();
          _replayPendingShape();
        }
        if (msg.type === 'popout-closed') {
          // Fast path when the message does arrive; window.closed polling (see
          // openAnnotationPopout) is the reliable fallback that always fires.
          _restoreMainPanel();
        }
      };

      // A popout left open after the main window goes away can't receive shapes
      // and has no session behind it; tell it so it can say as much.
      window.addEventListener('beforeunload', function() {
        try { _ch.postMessage({ type: 'main-closing' }); } catch (e) {}
      });
    }

    // ── Pop-out opener ──
    // Restoring the main panel used to rely solely on the popout's beforeunload
    // handler posting {type:'popout-closed'} over the BroadcastChannel. That message
    // is unreliable during page teardown (browsers may tear the channel down before
    // the send is flushed to other contexts, and it never fires at all if the popout
    // is killed/crashes rather than closed normally) - verified empirically: it was
    // dropped in every run of the popout-close exercise, leaving the main window's
    // annotation panel permanently hidden. Poll window.closed instead, which needs no
    // cooperation from the popout document and catches crashes too. The BroadcastChannel
    // message is kept as a secondary, faster path when it does arrive.
    let _popoutCloseWatcher = null;

    function _restoreMainPanel() {
      const mainPanel = document.getElementById('annotationFormPanel');
      if (mainPanel) mainPanel.style.display = '';
      if (_popoutCloseWatcher) {
        clearInterval(_popoutCloseWatcher);
        _popoutCloseWatcher = null;
      }
    }

    // Resolve the id of the project to hand the popout. DB projects live on
    // `currentProject.project_id`; `currentProjectId` is the copy overlay-layers
    // keeps, and the page URL is the last resort for a popout opened before the
    // snapshot finished loading. Without an id the popout loads an empty shell
    // and every save fails with "no project".
    function _currentProjectIdForPopout() {
      try {
        if (typeof currentProject !== 'undefined' && currentProject && currentProject.project_id) {
          return currentProject.project_id;
        }
      } catch (e) {}
      try {
        if (typeof currentProjectId !== 'undefined' && currentProjectId) return currentProjectId;
      } catch (e) {}
      const p = new URLSearchParams(window.location.search).get('project_id');
      if (p && /^\d+$/.test(p.trim())) return p.trim();
      return null;
    }

    window.openAnnotationPopout = function() {
      if (window._annotationPopout && !window._annotationPopout.closed) { window._annotationPopout.focus(); return; }
      const base = window.location.pathname;
      const id = _currentProjectIdForPopout();
      if (!id && typeof showStatus === 'function') {
        showStatus('Open a project before popping the panel out', 'error');
        return;
      }
      window._annotationPopout = window.open(
        base + '?cat_popout=panel&project_id=' + encodeURIComponent(id),
        'cat-annotation-popout',
        'width=1200,height=800,resizable=yes,scrollbars=yes'
      );
      if (!window._annotationPopout) {
        // Blocked by a popup blocker — leave the main panel visible rather than
        // hiding it in favour of a window that never opened.
        if (typeof showStatus === 'function') {
          showStatus('Pop-out blocked by the browser — allow pop-ups for this site', 'error');
        }
        return;
      }
      // Hide the entire annotation panel while the popout is open
      const mainPanel = document.getElementById('annotationFormPanel');
      if (mainPanel) mainPanel.style.display = 'none';

      if (_popoutCloseWatcher) clearInterval(_popoutCloseWatcher);
      const popoutRef = window._annotationPopout;
      _popoutCloseWatcher = setInterval(function() {
        if (!popoutRef || popoutRef.closed) {
          _restoreMainPanel();
        }
      }, 400);
    };
    // Keep old names as aliases in case anything still calls them
    window.openFormPopout = window.openAnnotationPopout;
    window.openTablePopout = window.openAnnotationPopout;
  })();

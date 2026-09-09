(function() {
    'use strict';
    const _ch = new BroadcastChannel('cat-annotation-v1');
    window._catChannel = _ch;
    const _mode = window._catPopoutMode;

    if (_mode) {
      // ── Popout window setup ──
      document.body.classList.add('cat-popout-' + _mode);

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
        '<span id="popoutSaveMirror" style="display:none;"></span>';
      if (panel) panel.insertBefore(_statusBar, panel.firstChild);

      // Listen for messages from the main window
      _ch.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'status-sync') {
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
          if (typeof showStatus === 'function') showStatus('Shape received — fill in the form and click Save', 'info');
          // Focus the species field so the user can start typing immediately
          window.focus();
          const spField = document.getElementById('spcode');
          if (spField) { spField.focus(); spField.select(); }
        }
        if (msg.type === 'sync-annotations' && Array.isArray(msg.annotations)) {
          // Bulk draw sync — replace local annotations array and refresh table
          annotations.length = 0;
          msg.annotations.forEach(function(a) { annotations.push(a); });
          if (typeof updateAnnotationTable === 'function') updateAnnotationTable();
        }
        if (msg.type === 'annotations-changed') {
          // Was gated on `_mode === 'table'`, a mode name that no longer exists (see
          // the saveAnnotation() fix in annotation-runtime-operations.js) - the single
          // 'panel' mode shows the table alongside the form, so it should refresh here too.
          if (typeof refreshAnnotationsFromDb === 'function') {
            refreshAnnotationsFromDb().catch(function(e) { console.warn('Refresh failed:', e); });
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

      _ch.onmessage = function(e) {
        const msg = e.data;
        if (msg.type === 'annotations-changed') {
          if (typeof refreshAnnotations === 'function') {
            refreshAnnotations().catch(function(e) { console.warn('Refresh failed:', e); });
          }
        }
        if (msg.type === 'popout-ready' && msg.mode === 'form' && window._pendingPopoutShape) {
          _ch.postMessage(window._pendingPopoutShape);
          window._pendingPopoutShape = null;
        }
        if (msg.type === 'popout-ready') {
          // Send an immediate snapshot so the popout doesn't wait up to 1s for its first paint.
          _broadcastStatus();
        }
        if (msg.type === 'popout-closed') {
          // Fast path when the message does arrive; window.closed polling (see
          // openAnnotationPopout) is the reliable fallback that always fires.
          _restoreMainPanel();
        }
      };
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

    window.openAnnotationPopout = function() {
      if (window._annotationPopout && !window._annotationPopout.closed) { window._annotationPopout.focus(); return; }
      const base = window.location.pathname;
      const pid = (typeof currentProject !== 'undefined' && currentProject && currentProject.project_id)
        ? '&project_id=' + currentProject.project_id : '';
      window._annotationPopout = window.open(
        base + '?cat_popout=panel' + pid,
        'cat-annotation-popout',
        'width=1200,height=800,resizable=yes,scrollbars=yes'
      );
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

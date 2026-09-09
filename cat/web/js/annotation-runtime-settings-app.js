  // ============================================================
  //  Timer Settings + Auto-save Preferences
  // ============================================================
  (function () {
    'use strict';

    const TS_KEY = 'cat_timer_settings';
    const AS_KEY = 'cat_autosave_settings';

    const TIMER_DEFAULTS = {
      autoStart: false,
      allowPause: true,
      idlePause: false,
      idleDelaySec: 300,
      perAnnotation: true,
    };
    const AUTOSAVE_DEFAULTS = {
      enabled: true,
      intervalMs: 30000,
      showBadge: true,
      maxRetries: 3,
    };

    // ── Persistence helpers ──
    function _loadJson(key, defaults) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
      } catch (_) { return { ...defaults }; }
    }
    function _saveJson(key, obj) {
      try { localStorage.setItem(key, JSON.stringify(obj)); } catch (_) {}
    }

    // ================================================================
    //  TIMER SETTINGS
    // ================================================================
    let _idleTimeout = null;
    let _idleListenersAttached = false;

    window.openTimerSettings = function () {
      const s = _loadJson(TS_KEY, TIMER_DEFAULTS);
      document.getElementById('tsAutoStart').checked = s.autoStart;
      document.getElementById('tsAllowPause').checked = s.allowPause;
      document.getElementById('tsIdlePause').checked = s.idlePause;
      document.getElementById('tsIdleDelay').value = String(s.idleDelaySec);
      document.getElementById('tsPerAnnotation').checked = s.perAnnotation;
      _toggleIdleDelayRow();
      _updateTimerStatus();
      document.getElementById('tsIdlePause').onchange = _toggleIdleDelayRow;
      document.getElementById('timerSettingsModal').style.display = 'flex';
    };
    window.closeTimerSettings = function () {
      document.getElementById('timerSettingsModal').style.display = 'none';
    };
    window.saveTimerSettings = function () {
      const s = {
        autoStart: document.getElementById('tsAutoStart').checked,
        allowPause: document.getElementById('tsAllowPause').checked,
        idlePause: document.getElementById('tsIdlePause').checked,
        idleDelaySec: parseInt(document.getElementById('tsIdleDelay').value, 10),
        perAnnotation: document.getElementById('tsPerAnnotation').checked,
      };
      _saveJson(TS_KEY, s);
      _applyTimerSettings(s);
      closeTimerSettings();
      if (typeof showStatus === 'function') showStatus('✅ Timer settings saved', 'success');
    };
    window.resetTimerSettings = function () {
      document.getElementById('tsAutoStart').checked = TIMER_DEFAULTS.autoStart;
      document.getElementById('tsAllowPause').checked = TIMER_DEFAULTS.allowPause;
      document.getElementById('tsIdlePause').checked = TIMER_DEFAULTS.idlePause;
      document.getElementById('tsIdleDelay').value = String(TIMER_DEFAULTS.idleDelaySec);
      document.getElementById('tsPerAnnotation').checked = TIMER_DEFAULTS.perAnnotation;
      _toggleIdleDelayRow();
    };

    function _toggleIdleDelayRow() {
      const show = document.getElementById('tsIdlePause').checked;
      document.getElementById('tsIdleDelayRow').style.display = show ? 'block' : 'none';
    }
    function _updateTimerStatus() {
      const el = document.getElementById('tsStatusText');
      if (!el) return;
      if (typeof timerState === 'undefined') { el.textContent = 'Timer module not loaded'; return; }
      if (timerState.isRunning && timerState.isPaused) {
        el.innerHTML = '⏸️ Timer is <strong>paused</strong>';
      } else if (timerState.isRunning) {
        el.innerHTML = '▶️ Timer is <strong>running</strong> — ' + (timerState.elapsedSeconds || 0) + 's elapsed';
      } else {
        el.textContent = '⏹️ Timer is not running';
      }
    }

    function _applyTimerSettings(s) {
      // Pause control: make badge non-clickable if pause disabled
      const badge = document.getElementById('annotationTimer');
      if (badge) {
        badge.style.cursor = s.allowPause ? 'pointer' : 'default';
        badge.title = s.allowPause ? 'Click to pause/resume timer' : 'Timer (pause disabled in settings)';
      }
      // Expose for timer module
      window._timerSettings = s;

      // Idle auto-pause watcher
      _clearIdleWatcher();
      if (s.idlePause) _startIdleWatcher(s.idleDelaySec);
    }

    // ── Idle watcher ──
    const IDLE_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    function _onActivity() {
      // If timer was auto-paused by idle, resume it
      if (window._idleAutoPaused && typeof timerState !== 'undefined' && timerState.isPaused) {
        window._idleAutoPaused = false;
        if (typeof startTimer === 'function') startTimer();
        if (typeof showStatus === 'function') showStatus('▶️ Timer resumed (activity detected)', 'info');
      }
      // Reset idle countdown
      if (_idleTimeout) clearTimeout(_idleTimeout);
      const delay = (window._timerSettings?.idleDelaySec || 300) * 1000;
      _idleTimeout = setTimeout(_onIdle, delay);
    }
    function _onIdle() {
      if (typeof timerState !== 'undefined' && timerState.isRunning && !timerState.isPaused) {
        if (typeof pauseTimer === 'function') pauseTimer();
        window._idleAutoPaused = true;
        if (typeof showStatus === 'function') showStatus('⏸️ Timer auto-paused (idle)', 'warning');
      }
    }
    function _startIdleWatcher(delaySec) {
      if (!_idleListenersAttached) {
        IDLE_EVENTS.forEach(evt => document.addEventListener(evt, _onActivity, { passive: true }));
        _idleListenersAttached = true;
      }
      _idleTimeout = setTimeout(_onIdle, delaySec * 1000);
    }
    function _clearIdleWatcher() {
      if (_idleTimeout) { clearTimeout(_idleTimeout); _idleTimeout = null; }
      window._idleAutoPaused = false;
    }

    // ================================================================
    //  AUTO-SAVE SETTINGS
    // ================================================================
    window.openAutoSaveSettings = function () {
      const s = _loadJson(AS_KEY, AUTOSAVE_DEFAULTS);
      document.getElementById('asEnabled').checked = s.enabled;
      document.querySelectorAll('input[name="asInterval"]').forEach(r => {
        r.checked = (parseInt(r.value, 10) === s.intervalMs);
      });
      document.getElementById('asShowBadge').checked = s.showBadge;
      document.getElementById('asMaxRetries').value = String(s.maxRetries);
      _updateAutoSaveStatus();
      document.getElementById('autoSaveSettingsModal').style.display = 'flex';
    };
    window.closeAutoSaveSettings = function () {
      document.getElementById('autoSaveSettingsModal').style.display = 'none';
    };
    window.saveAutoSaveSettings = function () {
      const checkedRadio = document.querySelector('input[name="asInterval"]:checked');
      const s = {
        enabled: document.getElementById('asEnabled').checked,
        intervalMs: checkedRadio ? parseInt(checkedRadio.value, 10) : 30000,
        showBadge: document.getElementById('asShowBadge').checked,
        maxRetries: parseInt(document.getElementById('asMaxRetries').value, 10),
      };
      _saveJson(AS_KEY, s);
      _applyAutoSaveSettings(s);
      closeAutoSaveSettings();
      if (typeof showStatus === 'function') showStatus('✅ Auto-save preferences saved', 'success');
    };
    window.resetAutoSaveSettings = function () {
      document.getElementById('asEnabled').checked = AUTOSAVE_DEFAULTS.enabled;
      document.querySelectorAll('input[name="asInterval"]').forEach(r => {
        r.checked = (parseInt(r.value, 10) === AUTOSAVE_DEFAULTS.intervalMs);
      });
      document.getElementById('asShowBadge').checked = AUTOSAVE_DEFAULTS.showBadge;
      document.getElementById('asMaxRetries').value = String(AUTOSAVE_DEFAULTS.maxRetries);
    };

    function _updateAutoSaveStatus() {
      const el = document.getElementById('asStatusText');
      if (!el) return;
      const isOracle = typeof storageBackend !== 'undefined' && storageBackend === 'oracle';
      if (!isOracle) {
        el.innerHTML = '📁 <strong>File mode</strong> — auto-save is not available (use 💾 Save to download)';
        return;
      }
      const running = typeof autoSaveIntervalId !== 'undefined' && autoSaveIntervalId !== null;
      if (running) {
        const intervalSec = (typeof AUTO_SAVE_INTERVAL_MS !== 'undefined' ? AUTO_SAVE_INTERVAL_MS : 30000) / 1000;
        el.innerHTML = `✅ Auto-save is <strong>active</strong> — saving every ${intervalSec}s`;
      } else {
        el.innerHTML = '⏹️ Auto-save is <strong>stopped</strong>';
      }
    }

    function _applyAutoSaveSettings(s) {
      // Update the global interval constant (used by startAutoSave)
      if (typeof AUTO_SAVE_INTERVAL_MS !== 'undefined') {
        // AUTO_SAVE_INTERVAL_MS is declared with const, so we override via a
        // module-level setter if available, or restart the interval directly.
      }

      // Apply badge visibility
      const badge = document.getElementById('autoSaveBadge');
      if (badge && !s.showBadge) {
        badge.style.display = 'none';
      }
      window._autoSaveSettings = s;

      // If Oracle mode, restart auto-save with new interval
      const isOracle = typeof storageBackend !== 'undefined' && storageBackend === 'oracle';
      if (isOracle) {
        // Stop existing
        if (typeof stopAutoSave === 'function') stopAutoSave();

        if (s.enabled) {
          // Restart with new interval
          if (typeof autoSaveIntervalId !== 'undefined') {
            autoSaveIntervalId = setInterval(function () {
              if (typeof runAutoSave === 'function') runAutoSave();
            }, s.intervalMs);
            if (typeof setAutoSaveBadge === 'function') {
              setAutoSaveBadge('saved', '✅ Auto-save on (' + (s.intervalMs / 1000) + 's)');
            }
            if (typeof startChangePolling === 'function') startChangePolling();
          }
        }
      }
    }

    // ================================================================
    //  APPLY ON LOAD — read saved prefs and apply them
    // ================================================================
    function _initSettingsOnLoad() {
      // Timer settings
      const ts = _loadJson(TS_KEY, TIMER_DEFAULTS);
      _applyTimerSettings(ts);

      // If auto-start is enabled and a project loads, start the timer
      if (ts.autoStart) {
        const _waitForProject = setInterval(() => {
          if (typeof currentProject !== 'undefined' && currentProject) {
            clearInterval(_waitForProject);
            if (typeof startTimer === 'function' && (typeof timerState === 'undefined' || !timerState.isRunning)) {
              startTimer();
            }
          }
        }, 500);
        // Give up after 30s
        setTimeout(() => clearInterval(_waitForProject), 30000);
      }

      // Auto-save settings
      const as = _loadJson(AS_KEY, AUTOSAVE_DEFAULTS);
      window._autoSaveSettings = as;
      // The actual auto-save is started by the runtime when an Oracle project loads,
      // so we just expose the settings for it to read.
    }

    // Patch the pause-click handler to respect allowPause setting
    const _origTimerBadgeSetup = setInterval(() => {
      const badge = document.getElementById('annotationTimer');
      if (!badge) return;
      clearInterval(_origTimerBadgeSetup);
      // Wrap the existing click handler
      badge.addEventListener('click', function (e) {
        const s = window._timerSettings || TIMER_DEFAULTS;
        if (!s.allowPause) {
          e.stopImmediatePropagation();
          if (typeof showStatus === 'function') showStatus('⏸️ Pause is disabled in Timer settings', 'warning');
        }
      }, true); // capture phase — fires before the existing handler
    }, 200);

    // Run on DOMContentLoaded or immediately if already loaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initSettingsOnLoad);
    } else {
      _initSettingsOnLoad();
    }

    // ================================================================
    //  Task 9 fix: Escape closes any open settings modal.
    // ================================================================
    // None of the 4 settings modals (Species Filters, Map & Display, Timer,
    // Auto-save) had any keydown handling at all - only the X button and Cancel/Save
    // closed them. The page's one global Escape handler (annotation-runtime-shell-init.js)
    // is dedicated to cancelling in-progress drawing and doesn't know these modals
    // exist, so Escape silently did nothing while any of them was open (confirmed via
    // the harness: all 4 failed an Escape-close check before this fix). Listed here
    // rather than in each modal's own file since it's one small, shared concern
    // spanning multiple files/modules.
    const _SETTINGS_MODALS = [
      { id: 'speciesFilterModal', close: 'closeSpeciesFilterModal' },
      { id: 'mapDisplaySettingsModal', close: 'closeMapDisplaySettings' },
      { id: 'timerSettingsModal', close: 'closeTimerSettings' },
      { id: 'autoSaveSettingsModal', close: 'closeAutoSaveSettings' },
    ];
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      for (const m of _SETTINGS_MODALS) {
        const el = document.getElementById(m.id);
        if (el && getComputedStyle(el).display !== 'none' && typeof window[m.close] === 'function') {
          e.stopPropagation();
          window[m.close]();
          return; // close only the topmost/first match - these modals aren't stacked
        }
      }
    });
  })();

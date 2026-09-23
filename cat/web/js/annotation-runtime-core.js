// Extracted from annotation-file-mode-runtime.js (Phase 2b: core)
    // Configuration
    // Same-origin: the API is always served by the host that served this page.
    // A hardcoded host breaks proxied deployments (Cloud Workstations, etc.).
    const serverUrl = window.location.origin;
    let currentCOG = null;
    let currentAnnotation = null;
    let annotations = [];
    let selectedSiteData = null;
    
    // File-based project data
    let currentProject = null;
    let projectAnnotations = [];
    let hasUnsavedChanges = false;
    let lastSaveTime = null;
    // The Oracle database is the only backend (file mode was removed).
    let storageBackend = 'oracle';
    let currentDbSessionId = null;
    let autoSaveIntervalId = null;
    const AUTO_SAVE_INTERVAL_MS = 30000; // 30 seconds
    let autoSaveInProgress = false;
    
    // ========== Annotation Timer Tracking (File Mode) ==========
    let timerState = {
      // File mode: Simple local timer without database
      sessionId: null,
      username: null,
      isRunning: false,
      isPaused: false,
      startTime: null,
      elapsedSeconds: 0,
      pauseStartTime: null,
      totalPauseSeconds: 0,
      annotationCount: 0,
      displayInterval: null,
      sessionStartTime: null, // When the entire session started
      totalSessionSeconds: 0, // Total time for this session
      annotationStartTime: null, // When current annotation drawing started
      annotationTimings: [] // Track time per annotation
    };
    
    function formatTime(seconds) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    
    function formatTotalTime(seconds) {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      if (hours > 0) {
        return `${hours}h ${mins}m`;
      } else {
        return `${mins}m`;
      }
    }
    
    function updateTimerDisplay() {
      const display = document.getElementById('timerDisplay');
      const totalDisplay = document.getElementById('totalTime');
      
      if (!display) return;
      
      // Update current annotation timer
      if (timerState.isRunning && !timerState.isPaused) {
        const now = Date.now();
        const elapsed = Math.floor((now - timerState.startTime) / 1000);
        timerState.elapsedSeconds = elapsed;
        display.textContent = formatTime(elapsed);
      } else {
        display.textContent = formatTime(timerState.elapsedSeconds);
      }
      
      // Total = this person's earlier time on the project + ACTIVE time in
      // this session (pauses excluded). It used to be wall-clock time since
      // the page loaded, pauses included, and restarted at zero on reload.
      timerState.totalSessionSeconds = timerState.elapsedSeconds;
      if (totalDisplay) {
        totalDisplay.textContent = formatTotalTime((timerState.priorTotalSeconds || 0) + timerState.elapsedSeconds);
      }
    }

    // Earlier sessions' total for this project, from the session-start call.
    function setPriorSessionTotal(seconds) {
      timerState.priorTotalSeconds = Math.max(0, parseInt(seconds, 10) || 0);
      const totalBadge = document.getElementById('totalTimeDisplay');
      const placeholder = document.getElementById('noTimePlaceholder');
      if (timerState.priorTotalSeconds > 0) {
        if (totalBadge) totalBadge.style.display = 'inline-block';
        if (placeholder) placeholder.style.display = 'none';
      }
      updateTimerDisplay();
    }
    window.setPriorSessionTotal = setPriorSessionTotal;

    // Save this session's active time to the server. Previously only a
    // manual Save click did this, so a closed tab lost the session's time.
    let _lastPersistedSeconds = -1;
    function persistSessionTime(keepalive) {
      if (typeof currentDbSessionId === 'undefined' || !currentDbSessionId || !currentProject?.project_id) return;
      if (window.catReadOnly) return;
      const seconds = timerState.elapsedSeconds || 0;
      if (!keepalive && seconds === _lastPersistedSeconds) return;
      _lastPersistedSeconds = seconds;
      fetch(`${serverUrl}/api/db/projects/${currentProject.project_id}/sessions/${currentDbSessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ total_seconds: seconds, annotation_count: timerState.annotationCount || 0, is_active: true }),
        keepalive: !!keepalive,
        credentials: 'same-origin'
      }).catch(() => { /* best effort — retried next minute */ });
    }
    window.persistSessionTime = persistSessionTime;
    setInterval(() => persistSessionTime(false), 60000);
    window.addEventListener('pagehide', () => persistSessionTime(true));
    
    function startSessionTimer() {
      // File mode: Start session timer locally (no database)
      if (!timerState.sessionStartTime) {
        timerState.sessionStartTime = Date.now();
        console.log('⏱️ Session timer started');
        
        // Show total time badge
        const totalBadge = document.getElementById('totalTimeDisplay');
        if (totalBadge) {
          totalBadge.style.display = 'inline-block';
        }
      }
    }
    
    // Reveal the timer badge in its resting ("not started yet") state,
    // without starting the clock. Called once a project has finished
    // loading (see the project-load poller in annotation-runtime-settings-
    // app.js) so the timer is visible and clickable from the moment
    // there's something to time — previously the badge stayed
    // display:none (its inline default in annotation.html) until EITHER
    // auto-start was on, or an annotation was drawn (which auto-starts it
    // via shell-init.js), meaning with auto-start off there was no way to
    // discover the control or start it manually before drawing something.
    function showIdleTimerBadge() {
      if (timerState.isRunning) return; // already running/paused — leave its look alone
      // Respect the "Show timer" setting (Settings -> Timer): a project
      // load shouldn't override someone who's explicitly opted out of
      // seeing the badge at all.
      if (window._timerSettings && window._timerSettings.showTimer === false) return;
      const timerBadge = document.getElementById('annotationTimer');
      if (!timerBadge) return;
      timerBadge.style.display = 'inline-block';
      // Explicit neutral/grey — .timer-badge's own CSS default is the same
      // green startTimer() uses for "running", so falling back to it here
      // would make idle and running indistinguishable at a glance.
      timerBadge.style.background = 'rgba(0, 0, 0, 0.06)';
      timerBadge.style.color = 'var(--cat-ink-soft, #6c757d)';
      timerBadge.title = 'Click to start timer';
      const display = document.getElementById('timerDisplay');
      if (display) display.textContent = formatTime(0);
    }
    window.showIdleTimerBadge = showIdleTimerBadge;

    function startTimer() {
      // Task A2 Step 4: this is the existing isRunning guard that makes
      // startTimer() idempotent against the double auto-start mechanism
      // (direct call from loadProjectFromDatabase/loadProjectFromFile in
      // annotation-runtime-project-layers.js + the settings poller in
      // annotation-runtime-settings-app.js). timerState.isRunning is the
      // single source of truth for "is the timer running" — reused here
      // rather than introducing a parallel window._catTimerRunning flag.
      if (timerState.isRunning && !timerState.isPaused) {
        console.log('⏱️ Timer already running');
        return;
      }
      
      const timerBadge = document.getElementById('annotationTimer');
      
      // Get username
      if (!timerState.username) {
        const userSpan = document.getElementById('currentUsername');
        timerState.username = userSpan ? userSpan.textContent : 'unknown';
      }
      
      // Start session timer if not started
      startSessionTimer();
      
      // Resume paused timer
      if (timerState.isPaused) {
        console.log('▶️ Resuming timer');
        timerState.isPaused = false;
        
        // Calculate pause duration
        if (timerState.pauseStartTime) {
          const pauseDuration = Math.floor((Date.now() - timerState.pauseStartTime) / 1000);
          timerState.totalPauseSeconds += pauseDuration;
          timerState.pauseStartTime = null;
        }
        
        // Adjust start time to account for pause
        timerState.startTime = Date.now() - (timerState.elapsedSeconds * 1000);
        
        timerBadge.style.background = 'rgba(40, 167, 69, 0.1)';
        timerBadge.style.color = '#28a745';
        timerBadge.title = 'Click to pause timer';
        
        startTimerIntervals();
        return;
      }
      
      // Start new timer (file mode - local only, no database)
      timerState.sessionId = Date.now(); // Use timestamp as session ID
      timerState.isRunning = true;
      timerState.isPaused = false;
      timerState.startTime = Date.now();
      timerState.annotationStartTime = Date.now(); // Track when drawing starts
      timerState.elapsedSeconds = 0;
      timerState.totalPauseSeconds = 0;
      
      console.log('⏱️ Timer started (file mode)');

      // Respect "Show timer" (Settings -> Timer): starting the clock still
      // starts the clock even for someone who's opted out of seeing it —
      // this only decides whether the badge itself is drawn.
      if (!window._timerSettings || window._timerSettings.showTimer !== false) {
        timerBadge.style.display = 'inline-block';
      }
      timerBadge.style.background = 'rgba(40, 167, 69, 0.1)';
      timerBadge.style.color = '#28a745';
      timerBadge.title = 'Click to pause timer';
      
      // Show total time display
      const totalBadge = document.getElementById('totalTimeDisplay');
      if (totalBadge) {
        totalBadge.style.display = 'inline-block';
      }
      
      startTimerIntervals();
    }
    
    function startTimerIntervals() {
      // Clear existing intervals
      if (timerState.displayInterval) clearInterval(timerState.displayInterval);
      
      // Update display every second (file mode - local only)
      timerState.displayInterval = setInterval(updateTimerDisplay, 1000);
    }
    
    function pauseTimer() {
      if (!timerState.isRunning || timerState.isPaused) return;
      
      console.log('⏸️ Timer paused');
      timerState.isPaused = true;
      timerState.pauseStartTime = Date.now();
      
      const timerBadge = document.getElementById('annotationTimer');
      timerBadge.style.background = 'rgba(255, 193, 7, 0.1)';
      timerBadge.style.color = '#ffc107';
      timerBadge.title = 'Timer paused - Click to resume';
      
      // Stop intervals
      if (timerState.displayInterval) {
        clearInterval(timerState.displayInterval);
        timerState.displayInterval = null;
      }
      persistSessionTime(false);
    }
    
    function incrementAnnotationCount() {
      timerState.annotationCount++;
      console.log('📝 Annotation count:', timerState.annotationCount);
    }
    
    function getAnnotationTime() {
      // Return time spent on current annotation in seconds
      if (timerState.annotationStartTime) {
        const elapsed = Math.floor((Date.now() - timerState.annotationStartTime) / 1000);
        return elapsed;
      }
      return 0;
    }
    
    function resetAnnotationTimer() {
      // Reset timer for next annotation
      timerState.annotationStartTime = Date.now();
    }
    
    // File mode: No endTimer needed - time tracked locally
    
    // ========== File-Based Project Loading ==========

    async function initializeStorageBackend() {
      try {
        const response = await catFetch(`${serverUrl}/api/config`, undefined, 'Loading app configuration');
        const config = await response.json();
        // Kept only so a misconfigured server shows up in the console.
        if (config?.storage_backend && config.storage_backend !== 'oracle') {
          console.error(`Server reports storage_backend=${config.storage_backend}; CAT requires the Oracle database.`);
        }
      } catch (error) {
        console.warn('Could not load app configuration:', error);
      }
    }

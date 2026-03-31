// Extracted from annotation-file-mode-runtime.js (Phase 2b: core)
    // Configuration
    const serverUrl = 'http://localhost:8000';
    let currentCOG = null;
    let currentAnnotation = null;
    let annotations = [];
    let selectedSiteData = null;
    
    // File-based project data
    let currentProject = null;
    let projectAnnotations = [];
    let hasUnsavedChanges = false;
    let lastSaveTime = null;
    let storageBackend = 'file';
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
      
      // Update total session time
      if (totalDisplay && timerState.sessionStartTime) {
        const now = Date.now();
        const sessionElapsed = Math.floor((now - timerState.sessionStartTime) / 1000);
        timerState.totalSessionSeconds = sessionElapsed;
        totalDisplay.textContent = formatTotalTime(sessionElapsed);
      }
    }
    
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
    
    function startTimer() {
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
      
      timerBadge.style.display = 'inline-block';
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
        const response = await fetch(`${serverUrl}/api/config`);
        if (!response.ok) return;
        const config = await response.json();
        if (config?.storage_backend) {
          storageBackend = config.storage_backend;
        }
        console.log(`🧭 Storage backend: ${storageBackend}`);
      } catch (error) {
        console.warn('Could not determine storage backend, defaulting to file mode:', error);
      }
    }

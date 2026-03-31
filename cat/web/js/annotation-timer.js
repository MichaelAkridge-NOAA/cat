/* ================================================
   CAT - Coral Annotation Tool
   Timer Tracking Module
   ================================================ */

// Timer state object
const timerState = {
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
  sessionStartTime: null,
  totalSessionSeconds: 0,
  annotationStartTime: null,
  annotationTimings: []
};

/**
 * Update timer display on UI
 */
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

/**
 * Start the session timer (tracks total time)
 */
function startSessionTimer() {
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

/**
 * Start the annotation timer
 */
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
    
    if (timerBadge) {
      timerBadge.style.background = 'rgba(40, 167, 69, 0.1)';
      timerBadge.style.color = '#28a745';
      timerBadge.title = 'Click to pause timer';
    }
    
    startTimerIntervals();
    return;
  }
  
  // Start new timer
  timerState.sessionId = Date.now();
  timerState.isRunning = true;
  timerState.isPaused = false;
  timerState.startTime = Date.now();
  timerState.annotationStartTime = Date.now();
  timerState.elapsedSeconds = 0;
  timerState.totalPauseSeconds = 0;
  
  console.log('⏱️ Timer started (file mode)');
  
  if (timerBadge) {
    timerBadge.style.display = 'inline-block';
    timerBadge.style.background = 'rgba(40, 167, 69, 0.1)';
    timerBadge.style.color = '#28a745';
    timerBadge.title = 'Click to pause timer';
  }
  
  // Show total time display
  const totalBadge = document.getElementById('totalTimeDisplay');
  if (totalBadge) {
    totalBadge.style.display = 'inline-block';
  }
  
  startTimerIntervals();
}

/**
 * Start timer intervals for display updates
 */
function startTimerIntervals() {
  // Clear existing intervals
  if (timerState.displayInterval) {
    clearInterval(timerState.displayInterval);
  }
  
  // Update display every second
  timerState.displayInterval = setInterval(updateTimerDisplay, 1000);
}

/**
 * Pause the timer
 */
function pauseTimer() {
  if (!timerState.isRunning || timerState.isPaused) return;
  
  console.log('⏸️ Timer paused');
  timerState.isPaused = true;
  timerState.pauseStartTime = Date.now();
  
  const timerBadge = document.getElementById('annotationTimer');
  if (timerBadge) {
    timerBadge.style.background = 'rgba(255, 193, 7, 0.1)';
    timerBadge.style.color = '#ffc107';
    timerBadge.title = 'Timer paused - Click to resume';
  }
  
  // Stop intervals
  if (timerState.displayInterval) {
    clearInterval(timerState.displayInterval);
    timerState.displayInterval = null;
  }
}

/**
 * Increment annotation count
 */
function incrementAnnotationCount() {
  timerState.annotationCount++;
  console.log('📝 Annotation count:', timerState.annotationCount);
}

/**
 * Get time spent on current annotation
 * @returns {number} Time in seconds
 */
function getAnnotationTime() {
  if (timerState.annotationStartTime) {
    const elapsed = Math.floor((Date.now() - timerState.annotationStartTime) / 1000);
    return elapsed;
  }
  return 0;
}

/**
 * Reset annotation timer for next annotation
 */
function resetAnnotationTimer() {
  timerState.annotationStartTime = Date.now();
}

/**
 * Stop the timer and return final statistics
 * @returns {Object} Timer statistics
 */
function stopTimer() {
  if (!timerState.isRunning) return null;
  
  timerState.isRunning = false;
  timerState.isPaused = false;
  
  if (timerState.displayInterval) {
    clearInterval(timerState.displayInterval);
    timerState.displayInterval = null;
  }
  
  const stats = {
    sessionId: timerState.sessionId,
    totalSessionSeconds: timerState.totalSessionSeconds,
    annotationCount: timerState.annotationCount,
    annotationTimings: timerState.annotationTimings
  };
  
  console.log('⏹️ Timer stopped', stats);
  
  return stats;
}

/**
 * Get current timer state
 * @returns {Object} Current timer state
 */
function getTimerState() {
  return { ...timerState };
}

/**
 * Reset all timer state
 */
function resetTimerState() {
  if (timerState.displayInterval) {
    clearInterval(timerState.displayInterval);
  }
  
  timerState.sessionId = null;
  timerState.username = null;
  timerState.isRunning = false;
  timerState.isPaused = false;
  timerState.startTime = null;
  timerState.elapsedSeconds = 0;
  timerState.pauseStartTime = null;
  timerState.totalPauseSeconds = 0;
  timerState.annotationCount = 0;
  timerState.displayInterval = null;
  timerState.sessionStartTime = null;
  timerState.totalSessionSeconds = 0;
  timerState.annotationStartTime = null;
  timerState.annotationTimings = [];
  
  console.log('🔄 Timer state reset');
}

// Export functions for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    timerState,
    updateTimerDisplay,
    startSessionTimer,
    startTimer,
    startTimerIntervals,
    pauseTimer,
    incrementAnnotationCount,
    getAnnotationTime,
    resetAnnotationTimer,
    stopTimer,
    getTimerState,
    resetTimerState
  };
}

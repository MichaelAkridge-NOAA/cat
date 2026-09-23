// 🐱 Cat buddy — a tiny tamagotchi-style cat that sits by the timer and
// nudges people to take a break after a long stretch of annotating.
//
// "Continuous" time = the timer's active time since the last real break (a
// pause of BREAK_MINUTES or more). After THRESHOLD minutes the cat wakes up;
// it gets sleepier and then grumpier the longer it goes. Feed it = take a
// break (pauses the timer). It also celebrates annotation milestones.
// Purely client-side; settings live in localStorage.
(function () {
  'use strict';
  if (window._catPopoutMode) return; // the popout mirrors the main window's timer

  const KEY_OFF = 'cat_buddy_off';
  const KEY_MIN = 'cat_buddy_minutes';
  const KEY_PETS = 'cat_buddy_pets';
  const BREAK_MINUTES = 3;
  const MILESTONE = 50;

  const read = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) { /* ignore */ } };

  let enabled = read(KEY_OFF, '0') !== '1';
  let thresholdMin = Math.max(1, Math.min(480, parseInt(read(KEY_MIN, '60'), 10) || 60));
  let breakMarkSeconds = 0;       // timer active-seconds at the last real break
  let snoozeUntil = 0;
  let pauseSeenAt = null;
  let lastMilestone = 0;
  let celebrateUntil = 0;
  let purrUntil = 0;
  let el = null;

  const MOODS = [
    { after: 0,   face: '😺', cls: 'ok',     say: m => `${m} min in — nice focus! A quick stretch soon? 🐟` },
    { after: 30,  face: '😽', cls: 'sleepy', say: m => `${m} min straight… my eyes are getting heavy. Look at something far away for 20 s? 👀` },
    { after: 60,  face: '🙀', cls: 'grumpy', say: m => `${m} minutes without a break! Feed me — take 5! 🐟🐟` }
  ];

  function injectStyle() {
    if (document.getElementById('catBuddyStyle')) return;
    const s = document.createElement('style');
    s.id = 'catBuddyStyle';
    s.textContent = `
      #catBuddy { position: relative; display: none; align-items: center; margin-left: 6px; cursor: pointer; user-select: none; }
      #catBuddy .cb-face { font-size: 20px; line-height: 1; display: inline-block; transform-origin: 50% 90%; }
      #catBuddy.ok .cb-face { animation: cbBob 2.4s ease-in-out infinite; }
      #catBuddy.sleepy .cb-face { animation: cbBob 4s ease-in-out infinite; filter: saturate(.7); }
      #catBuddy.grumpy .cb-face { animation: cbShake .6s ease-in-out infinite; }
      #catBuddy.party .cb-face { animation: cbJump .5s ease-in-out infinite; }
      #catBuddy.purr .cb-face { animation: cbPurr .25s linear infinite; }
      @keyframes cbBob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2px) } }
      @keyframes cbShake { 0%,100% { transform: rotate(0) } 25% { transform: rotate(-12deg) } 75% { transform: rotate(12deg) } }
      @keyframes cbJump { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }
      @keyframes cbPurr { 0%,100% { transform: translateX(0) } 50% { transform: translateX(1px) } }
      #catBuddy .cb-zz { position: absolute; top: -8px; right: -6px; font-size: 10px; opacity: .8; }
      #catBuddyBubble { position: fixed; z-index: 10060; width: 250px; background: #fff; color: #1f2937; border: 1px solid #e5e7eb;
        border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 10px 12px; font-size: 12px; line-height: 1.45; display: none; }
      #catBuddyBubble .cb-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      #catBuddyBubble button { font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid #cbd5e1; background: #f8fafc; cursor: pointer; }
      #catBuddyBubble button.primary { background: #ff2d6f; border-color: #ff2d6f; color: #fff; }
      #catBuddyBubble .cb-meta { color: #6b7280; font-size: 11px; margin-top: 6px; }
    `;
    document.head.appendChild(s);
  }

  function ensureEl() {
    if (el) return el;
    const timer = document.getElementById('annotationTimer');
    if (!timer || !timer.parentElement) return null;
    injectStyle();
    el = document.createElement('span');
    el.id = 'catBuddy';
    el.title = 'Cat buddy';
    el.innerHTML = '<span class="cb-face">😺</span><span class="cb-zz"></span>';
    timer.parentElement.insertBefore(el, timer.nextSibling);
    const bubble = document.createElement('div');
    bubble.id = 'catBuddyBubble';
    document.body.appendChild(bubble);
    el.addEventListener('click', (e) => { e.stopPropagation(); toggleBubble(); });
    document.addEventListener('click', (e) => {
      if (!bubble.contains(e.target)) bubble.style.display = 'none';
    });
    return el;
  }

  function activeSeconds() {
    return (typeof timerState !== 'undefined' && timerState) ? (timerState.elapsedSeconds || 0) : 0;
  }
  // Snooze scales with the interval: half of it, between 1 and 30 min.
  function snoozeMinutes() { return Math.max(1, Math.min(30, Math.round(thresholdMin / 2))); }
  function continuousMinutes() {
    return Math.floor(Math.max(0, activeSeconds() - breakMarkSeconds) / 60);
  }

  function moodFor(mins) {
    const over = mins - thresholdMin;
    let mood = MOODS[0];
    MOODS.forEach(m => { if (over >= m.after) mood = m; });
    return mood;
  }

  function bubbleHtml() {
    const mins = continuousMinutes();
    const pets = parseInt(read(KEY_PETS, '0'), 10) || 0;
    let text;
    if (Date.now() < celebrateUntil) text = `🎉 ${lastMilestone} annotations this session! Amazing work!`;
    else if (mins >= thresholdMin) text = moodFor(mins).say(mins);
    else text = `Purring along… ${mins} min since your last break. I'll wake up at ${thresholdMin} min.`;
    return `
      <div>${text}</div>
      <div class="cb-actions">
        <button class="primary" data-act="feed">🐟 Feed me (take a break)</button>
        <button data-act="pet">🤚 Pet</button>
        <button data-act="snooze">💤 Snooze ${snoozeMinutes()} min</button>
      </div>
      <div class="cb-meta">Pets given: ${pets} · Wakes after ${thresholdMin} min · <a href="#" data-act="settings">settings</a></div>`;
  }

  function toggleBubble(forceOpen) {
    const bubble = document.getElementById('catBuddyBubble');
    if (!bubble || !el) return;
    if (!forceOpen && bubble.style.display === 'block') { bubble.style.display = 'none'; return; }
    bubble.innerHTML = bubbleHtml();
    const r = el.getBoundingClientRect();
    bubble.style.display = 'block';
    bubble.style.top = `${Math.round(r.bottom + 8)}px`;
    bubble.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - 262, r.left - 110)))}px`;
    bubble.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      act(b.dataset.act);
    }));
  }

  function act(what) {
    const bubble = document.getElementById('catBuddyBubble');
    if (what === 'feed') {
      if (typeof pauseTimer === 'function') pauseTimer();
      breakMarkSeconds = activeSeconds();
      if (bubble) bubble.style.display = 'none';
      if (typeof showStatus === 'function') showStatus('🐟 Nom nom — timer paused. Stretch, blink, grab water. Click the timer to resume.', 'info');
    } else if (what === 'pet') {
      write(KEY_PETS, (parseInt(read(KEY_PETS, '0'), 10) || 0) + 1);
      purrUntil = Date.now() + 2500;
      toggleBubble(true);
    } else if (what === 'snooze') {
      snoozeUntil = Date.now() + snoozeMinutes() * 60 * 1000;
      if (bubble) bubble.style.display = 'none';
    } else if (what === 'settings') {
      if (typeof showStatus === 'function') showStatus('Cat buddy settings are in View → 🐱 Cat buddy.', 'info');
      if (bubble) bubble.style.display = 'none';
      return;
    }
    tick();
  }

  function tick() {
    const node = ensureEl();
    if (!node) return;
    const running = typeof timerState !== 'undefined' && timerState && timerState.isRunning;

    // A pause long enough to count as a break resets the clock.
    if (running && timerState.isPaused) {
      if (!pauseSeenAt) pauseSeenAt = Date.now();
      if (Date.now() - pauseSeenAt >= BREAK_MINUTES * 60 * 1000) breakMarkSeconds = activeSeconds();
    } else {
      pauseSeenAt = null;
    }

    // Milestones: every MILESTONE annotations saved this session.
    const count = (typeof timerState !== 'undefined' && timerState) ? (timerState.annotationCount || 0) : 0;
    const milestone = Math.floor(count / MILESTONE) * MILESTONE;
    if (milestone > 0 && milestone > lastMilestone) {
      lastMilestone = milestone;
      celebrateUntil = Date.now() + 8000;
    }

    const mins = continuousMinutes();
    const celebrating = Date.now() < celebrateUntil;
    const purring = Date.now() < purrUntil;
    const due = mins >= thresholdMin && Date.now() >= snoozeUntil;
    const visible = enabled && running && (due || celebrating || purring);
    node.style.display = visible ? 'inline-flex' : 'none';
    if (!visible) return;

    const mood = moodFor(mins);
    node.className = celebrating ? 'party' : purring ? 'purr' : mood.cls;
    node.querySelector('.cb-face').textContent = celebrating ? '😸' : purring ? '😻' : mood.face;
    node.querySelector('.cb-zz').textContent = (!celebrating && !purring && mood.cls === 'sleepy') ? 'z' : '';
    node.title = celebrating ? `🎉 ${lastMilestone} annotations!` : `${mins} min since your last break — click me`;
  }

  // View-menu hooks
  window.catBuddyToggle = function () {
    enabled = !enabled;
    write(KEY_OFF, enabled ? '0' : '1');
    if (typeof showStatus === 'function') showStatus(enabled ? '🐱 Cat buddy is on' : '🐱 Cat buddy is off', 'info');
    tick();
    return enabled;
  };
  // Keep the View-menu controls in step with the saved value: a preset
  // shows in the dropdown, anything else shows as "Custom…" + the number.
  function syncMinutesControls() {
    const sel = document.getElementById('catBuddyMinutes');
    const row = document.getElementById('catBuddyCustomRow');
    const input = document.getElementById('catBuddyCustomMinutes');
    if (!sel) return;
    const preset = Array.from(sel.options).some(o => o.value === String(thresholdMin));
    sel.value = preset ? String(thresholdMin) : 'custom';
    if (row) row.style.display = preset ? 'none' : '';
    if (input) input.value = String(thresholdMin);
  }

  window.catBuddySetMinutes = function (m) {
    if (m === 'custom') {
      // Show the number box; keep the current value until one is typed.
      const row = document.getElementById('catBuddyCustomRow');
      const input = document.getElementById('catBuddyCustomMinutes');
      if (row) row.style.display = '';
      if (input) { input.value = String(thresholdMin); input.focus(); }
      return;
    }
    // More frequent breaks are allowed (down to 1 min) for anyone who wants them.
    thresholdMin = Math.max(1, Math.min(480, parseInt(m, 10) || 60));
    write(KEY_MIN, thresholdMin);
    syncMinutesControls();
    if (typeof showStatus === 'function') showStatus(`🐱 Cat buddy will remind you after ${thresholdMin} min without a break`, 'info');
    tick();
  };
  window.catBuddyState = function () {
    return { enabled, thresholdMin, continuousMinutes: continuousMinutes() };
  };
  // For demos/testing: pretend the break was N minutes ago.
  window.catBuddyDemo = function (minutesAgo) {
    breakMarkSeconds = activeSeconds() - Math.max(0, minutesAgo) * 60;
    snoozeUntil = 0;
    tick();
    toggleBubble(true);
  };

  document.addEventListener('DOMContentLoaded', () => {
    syncMinutesControls();
    const lbl = document.getElementById('catBuddyToggleLabel');
    if (lbl) lbl.textContent = enabled ? 'on' : 'off';
    setInterval(tick, 5000);
    tick();
  });
})();

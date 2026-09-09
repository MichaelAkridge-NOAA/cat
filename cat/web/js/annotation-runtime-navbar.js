// --- Navbar dropdown logic ---
  function toggleNavDropdown(name) {
    const menu = document.getElementById('dd-' + name);
    const btn = menu?.previousElementSibling;
    const wasOpen = menu?.classList.contains('open');
    closeNavDropdowns();
    if (!wasOpen && menu) {
      menu.classList.add('open');
      if (btn) { btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
    }
  }
  function closeNavDropdowns() {
    document.querySelectorAll('.nav-dropdown-menu.open').forEach(m => m.classList.remove('open'));
    document.querySelectorAll('.nav-dropdown-btn.open').forEach(b => b.classList.remove('open'));
    document.querySelectorAll('.nav-dropdown-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  // Close dropdowns on click outside
  document.addEventListener('mousedown', function(e) {
    if (!e.target.closest('.nav-dropdown')) closeNavDropdowns();
  });
  // Close dropdowns on Escape (a11y). Non-capturing + no preventDefault so other
  // Escape handlers (e.g. drawing-cancel) still run; it's a no-op when none are open.
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeNavDropdowns();
  });
  // Initialize ARIA state so the dropdown buttons announce as collapsible menus.
  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('.nav-dropdown-btn').forEach(function(b) {
      b.setAttribute('aria-haspopup', 'true');
      if (!b.hasAttribute('aria-expanded')) b.setAttribute('aria-expanded', 'false');
    });
  });

  // --- Toast notification system (replaces inline showStatus) ---
  (function() {
    const TOAST_DURATION = { success: 2200, info: 3000, warning: 4000, error: 6000 };
    // Expose as _catToast so runtime-operations.js local showStatus() can delegate
    // Also set window.showStatus for scripts that call it directly
    window._catToast = toastShowStatus;
    window.showStatus = toastShowStatus;
    function toastShowStatus(message, type) {
      type = type || 'info';
      // For routine success saves, just flash the autosave badge — no toast
      if (type === 'success' && /annotation saved|saved!/i.test(message)) {
        // Task 8 fix: the per-annotation "Save" button (annotation-runtime-
        // operations.js saveAnnotation()) only pushes the new annotation into
        // the local in-memory array — it does NOT talk to the database. That
        // function still emits a "✅ Annotation saved! Total: N" toast (to
        // confirm the local draft) right after explicitly setting the badge
        // to the pending/blue "🔵 Unsaved changes" state. Because that message
        // also matches this same success-toast regex, it used to force the
        // badge back to a green "✅ Saved" immediately — a false-positive
        // claiming the DB write had happened when no network request had even
        // been sent yet (confirmed via network-log ordering: the badge went
        // green ~1s before the sync POST that actually saved it).
        // Still update the nav annotation-count badge (that IS accurate —
        // it reflects the local working set), but only flash the green
        // "Saved" badge itself when we're not sitting on unsynced Oracle
        // changes.
        const countMatch = message.match(/Total:\s*(\d+)/i);
        if (countMatch) updateNavAnnotationCount(parseInt(countMatch[1]));
        const isUnsyncedOracleDraft = typeof isOracleProjectMode === 'function' && isOracleProjectMode() &&
          typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges;
        if (!isUnsyncedOracleDraft) {
          flashAutoSaveBadge(message, /*skipCountUpdate*/ true);
        }
        return;
      }
      createToast(message, type);
    };

    function createToast(message, type) {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const el = document.createElement('div');
      el.className = 'cat-toast ' + type;
      // Strip emoji prefix for cleaner look (keep if it's the whole message)
      el.textContent = message;
      el.onclick = () => dismissToast(el);
      container.appendChild(el);
      // Auto-dismiss
      const dur = TOAST_DURATION[type] || 3000;
      setTimeout(() => dismissToast(el), dur);
      // Cap at 4 toasts visible
      while (container.children.length > 4) {
        dismissToast(container.firstElementChild);
      }
    }

    function dismissToast(el) {
      if (!el || el.classList.contains('exit')) return;
      el.classList.add('exit');
      setTimeout(() => el.remove(), 220);
    }

    function flashAutoSaveBadge(message, skipCountUpdate) {
      const badge = document.getElementById('autoSaveBadge');
      if (!badge) return;
      // Extract count if present (e.g. "Total: 12") unless the caller already did it
      if (!skipCountUpdate) {
        const countMatch = message.match(/Total:\s*(\d+)/i);
        if (countMatch) updateNavAnnotationCount(parseInt(countMatch[1]));
      }
      badge.style.display = '';
      badge.textContent = '✅ Saved';
      badge.style.background = 'rgba(40,167,69,0.2)';
      badge.style.transition = 'background 0.6s';
      setTimeout(() => { badge.style.background = 'rgba(40,167,69,0.1)'; }, 600);
    }

    // Annotation count badge in navbar
    window.updateNavAnnotationCount = function(count) {
      const el = document.getElementById('navAnnotationCount');
      if (!el) return;
      if (count > 0) {
        el.textContent = count + ' annotation' + (count !== 1 ? 's' : '');
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    };
  })();

  // --- Login-state badge (Oracle mode only) ---
  // This page has its own toolbar and deliberately doesn't include cat-nav.js,
  // but cat-auth.js is still loaded so we can show who's logged in / log out.
  document.addEventListener('DOMContentLoaded', function() {
    const badge = document.getElementById('navUserBadge');
    if (!badge || !window.CatAuth) return;
    CatAuth.getConfig().then(function(config) {
      if (!config.auth_enabled) return;
      CatAuth.fetchCurrentUser().then(function(data) {
        if (!data || !data.user) return;
        badge.style.display = '';
        badge.textContent = data.user.display_name || data.user.username;
        badge.title = 'Logged in as ' + data.user.username + ' — click to log out';
        badge.style.cursor = 'pointer';
        badge.addEventListener('click', function() { CatAuth.logout(); });
      });
    });
  });

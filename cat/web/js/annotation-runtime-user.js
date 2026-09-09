// Extracted from annotation-file-mode-runtime.js (Phase 2b: user helpers)
    // Fetch current logged-in user and auto-fill analyst field
    async function fetchCurrentUser() {
      // --- Sticky field persistence (Fix 3a) ---
      // Restore and persist: analyst, obs_year, mission_id, site
      const stickyFields = [
        { id: 'analyst',    key: 'cat_analyst',    transform: v => v.trim().toUpperCase() },
        { id: 'obs_year',   key: 'cat_obs_year',   transform: v => v.trim() },
        { id: 'mission_id', key: 'cat_mission_id', transform: v => v.trim() },
        { id: 'site',       key: 'cat_site',       transform: v => v.trim() },
      ];

      stickyFields.forEach(({ id, key, transform }) => {
        const el = document.getElementById(id);
        if (!el) return;
        // Restore saved value (don't overwrite if already populated by project load)
        if (!el.value) {
          const saved = localStorage.getItem(key);
          if (saved) {
            el.value = saved;
            markFieldAsAutofilled(el);
            console.log(`✅ Restored ${id} from localStorage:`, saved);
          }
        }
        // Persist on change/blur
        const persist = () => { if (el.value.trim()) localStorage.setItem(key, transform(el.value)); };
        el.addEventListener('change', persist);
        el.addEventListener('blur', persist);
      });

      // If still empty after project metadata + localStorage, fall back to the
      // logged-in user's display name (Oracle mode only — CatAuth is a no-op
      // no-network call when auth isn't enabled).
      if (!window.CatAuth) return;
      const analystField = document.getElementById('analyst');
      if (!analystField || analystField.value) return;
      try {
        const config = await CatAuth.getConfig();
        if (!config.auth_enabled) return;
        const data = await CatAuth.fetchCurrentUser();
        if (data && data.user && !analystField.value) {
          analystField.value = data.user.username.toUpperCase();
          markFieldAsAutofilled(analystField);
          timerState.username = data.user.username;
          loadTotalTime();
        }
      } catch (error) {
        console.warn('Could not fetch current user:', error);
      }
    }

    // Logout function
    async function logout() {
      if (window.CatAuth) {
        await CatAuth.logout();
        return false;
      }
      try {
        const response = await fetch(`${serverUrl}/api/auth/logout`, {
          method: 'POST',
          credentials: 'include'
        });

        if (response.ok) {
          window.location.href = '/login.html';
        }
      } catch (error) {
        console.error('Logout error:', error);
        window.location.href = '/login.html';
      }
      return false; // Prevent default link behavior
    }
    
